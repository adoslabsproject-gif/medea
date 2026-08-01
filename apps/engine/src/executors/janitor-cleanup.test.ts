/**
 * Bug-bounty UNIT — executors/janitor-cleanup.ts (audit coverage 2026-06-12:
 * 2%). Singleton janitor mockato: si pinna il BRANCHING (il valore del nodo
 * in un workflow), che è dove un bug manda il workflow sul ramo sbagliato:
 *   - single: ruleId mancante→error, rule non trovata→error (NON throw),
 *     paramsOverride JSON rotto/non-object→error, success+quarantine>0→
 *     detection, success+0→clean, !success→error;
 *   - failOnDetection: forza 'error' anche con detection (gate "blocca il
 *     workflow se trovi sporco");
 *   - cycle: aggrega rules, anyError→error, somma quarantined→detection;
 *   - eccezione runtime → branch 'error' (mai propaga, il workflow continua).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const janitor = {
  registry: { get: vi.fn() },
  executeRule: { execute: vi.fn() },
  executeCycle: { execute: vi.fn() },
};
vi.mock('@/services/janitor/janitor.singleton.js', () => ({ getJanitor: () => janitor }));
vi.mock('@/lib/logger.js');

import { janitorCleanupExecutor } from './janitor-cleanup.js';

const ctx = { tenantId: 't1', nodeId: 'n1' } as never;
const run = (config: Record<string, unknown>) => janitorCleanupExecutor(config as never, {} as never, ctx);

function ruleReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: true, rowsDetected: 0, rowsRepaired: 0, rowsQuarantined: 0, rowsSkipped: 0, bySeverity: {}, dryRun: false, durationMs: 1, ...over };
}

beforeEach(() => {
  janitor.registry.get.mockReset();
  janitor.executeRule.execute.mockReset();
  janitor.executeCycle.execute.mockReset();
  janitor.registry.get.mockReturnValue({ id: 'rule-1' }); // default: rule esiste
});

describe('single — gate di input', () => {
  it('ruleId mancante → branch error (no throw)', async () => {
    const res = await run({ mode: 'single' });
    expect(res.branch).toBe('error');
    expect(janitor.executeRule.execute).not.toHaveBeenCalled();
  });

  it('rule NON trovata → branch error con messaggio guida (no throw)', async () => {
    janitor.registry.get.mockReturnValue(null);
    const res = await run({ mode: 'single', ruleId: 'inesistente' });
    expect(res.branch).toBe('error');
    expect((res.output as { error: string }).error).toMatch(/Salute dati/);
  });

  it('paramsOverride JSON malformato → branch error', async () => {
    const res = await run({ mode: 'single', ruleId: 'rule-1', paramsOverride: '{rotto' });
    expect(res.branch).toBe('error');
    expect((res.output as { error: string }).error).toMatch(/JSON non valido/);
  });

  it('paramsOverride JSON valido ma NON object (array) → branch error', async () => {
    const res = await run({ mode: 'single', ruleId: 'rule-1', paramsOverride: '[1,2]' });
    expect(res.branch).toBe('error');
    expect((res.output as { error: string }).error).toMatch(/object/);
  });
});

describe('single — branching su esito rule', () => {
  it('success + quarantined 0 → branch CLEAN', async () => {
    janitor.executeRule.execute.mockResolvedValue({ report: ruleReport({ rowsQuarantined: 0 }) });
    expect((await run({ mode: 'single', ruleId: 'rule-1' })).branch).toBe('clean');
  });

  it('success + quarantined > 0 → branch DETECTION', async () => {
    janitor.executeRule.execute.mockResolvedValue({ report: ruleReport({ rowsQuarantined: 3, rowsDetected: 3 }) });
    const res = await run({ mode: 'single', ruleId: 'rule-1' });
    expect(res.branch).toBe('detection');
    expect((res.output as { rowsQuarantined: number }).rowsQuarantined).toBe(3);
  });

  it('report.success=false → branch ERROR con report propagato', async () => {
    janitor.executeRule.execute.mockResolvedValue({ report: ruleReport({ success: false, error: 'lock contention' }) });
    const res = await run({ mode: 'single', ruleId: 'rule-1' });
    expect(res.branch).toBe('error');
    expect((res.output as { error: string }).error).toBe('lock contention');
  });

  it('failOnDetection=true + quarantine>0 → forza ERROR (gate blocca workflow)', async () => {
    janitor.executeRule.execute.mockResolvedValue({ report: ruleReport({ rowsQuarantined: 2 }) });
    const res = await run({ mode: 'single', ruleId: 'rule-1', failOnDetection: 'true' });
    expect(res.branch).toBe('error');
  });

  it('eccezione runtime dell executeRule → branch error (mai propaga)', async () => {
    janitor.executeRule.execute.mockRejectedValue(new Error('DB down'));
    const res = await run({ mode: 'single', ruleId: 'rule-1' });
    expect(res.branch).toBe('error');
    expect((res.output as { error: string }).error).toBe('DB down');
  });

  it('overrides: paramsOverride object + maxRowsPerRun string → passati a executeRule', async () => {
    janitor.executeRule.execute.mockResolvedValue({ report: ruleReport() });
    await run({ mode: 'single', ruleId: 'rule-1', paramsOverride: { soglia: 5 }, maxRowsPerRun: '250' });
    const arg = janitor.executeRule.execute.mock.calls[0]![0] as { overrides: { params: unknown; maxRowsPerRun: number } };
    expect(arg.overrides.params).toEqual({ soglia: 5 });
    expect(arg.overrides.maxRowsPerRun).toBe(250);
  });

  it('dryRun="true" → propagato + detected incluso nell output', async () => {
    janitor.executeRule.execute.mockResolvedValue({ report: ruleReport({ dryRun: true }), detected: [{ id: 1 }] });
    const res = await run({ mode: 'single', ruleId: 'rule-1', dryRun: 'true' });
    expect(janitor.executeRule.execute.mock.calls[0]![0]).toMatchObject({ dryRun: true });
    expect((res.output as { detected: unknown[] }).detected).toEqual([{ id: 1 }]);
  });
});

describe('cycle — aggregazione multi-rule', () => {
  const cycleReport = (rules: Record<string, unknown>[]) => ({
    cycleId: 'cyc-1', rulesExecuted: rules.length, rulesSkippedLock: 0, rulesSkippedDisabled: 0, durationMs: 5, rules,
  });

  it('tutte pulite → branch CLEAN', async () => {
    janitor.executeCycle.execute.mockResolvedValue(cycleReport([
      { success: true, rowsQuarantined: 0, rowsDetected: 0 },
      { success: true, rowsQuarantined: 0, rowsDetected: 0 },
    ]));
    expect((await run({ mode: 'cycle' })).branch).toBe('clean');
  });

  it('somma quarantined > 0 → DETECTION con totali aggregati', async () => {
    janitor.executeCycle.execute.mockResolvedValue(cycleReport([
      { success: true, rowsQuarantined: 2, rowsDetected: 2 },
      { success: true, rowsQuarantined: 3, rowsDetected: 5 },
    ]));
    const res = await run({ mode: 'cycle' });
    expect(res.branch).toBe('detection');
    expect((res.output as { rowsQuarantined: number; rowsDetected: number })).toMatchObject({ rowsQuarantined: 5, rowsDetected: 7 });
  });

  it('almeno una rule fallita → branch ERROR (anche se altre pulite)', async () => {
    janitor.executeCycle.execute.mockResolvedValue(cycleReport([
      { success: true, rowsQuarantined: 0, rowsDetected: 0 },
      { success: false, rowsQuarantined: 0, rowsDetected: 0 },
    ]));
    expect((await run({ mode: 'cycle' })).branch).toBe('error');
  });

  it('tagFilter CSV → split e passato a executeCycle (vuoto → omesso)', async () => {
    janitor.executeCycle.execute.mockResolvedValue(cycleReport([{ success: true, rowsQuarantined: 0, rowsDetected: 0 }]));
    await run({ mode: 'cycle', tagFilter: 'orders, gdpr , ' });
    expect(janitor.executeCycle.execute.mock.calls[0]![0]).toMatchObject({ tagFilter: ['orders', 'gdpr'] });
  });
});
