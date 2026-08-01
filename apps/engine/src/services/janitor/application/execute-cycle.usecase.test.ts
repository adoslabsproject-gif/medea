/**
 * Test 2026-grade — application/execute-cycle.usecase.ts (cycle orchestrator).
 *
 * 🚨 SEQUENZIALE: rule eseguite in serie (no parallel). Stesso DB → BEGIN
 *    IMMEDIATE locks. Bug parallel = race condition quarantine.
 *
 * 🚨 SKIP DISABLED: config.enabled=false → counter+continua (no execute).
 *
 * 🚨 LOCK DETECTION: report.error startsWith 'Lock' → counter rulesSkippedLock.
 *    Bug = ogni run "lock contended" conta come fail, falsa SLA.
 *
 * 🚨 FILTER ruleIds + tagFilter: solo subset attivato.
 *
 * 🚨 REPORT AGGREGATO: frozen + cycleId + durationMs + counter triplo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecuteCycleUseCase } from './execute-cycle.usecase.js';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type {
  IClock, IRuleRegistry, IRuleConfigRepository,
} from '@/services/janitor/ports/index.js';
import type { Logger } from 'pino';
import type { CodeRule, JanitorRuleReport } from '@/services/janitor/domain/index.js';

const mkRule = (id: string, tags: string[] = []): CodeRule => ({
  kind: 'code', id, title: id, description: 'd',
  defaultDataSource: SYSTEM_REF, targetTable: 'runs', targetPkColumn: 'id',
  tags, paramsSchema: [],
  defaultSeverity: 'critical', defaultSchedule: '0 * * * *', defaultMaxRowsPerRun: 100,
  detect: async () => [],
});

const mkReport = (over: Partial<JanitorRuleReport> = {}): JanitorRuleReport => ({
  cycleId: 'c1', ruleId: 'rule.a', tenantId: 't1', dataSourceRef: SYSTEM_REF,
  targetTable: 'runs', startedAt: '2026-06-08T12:00:00Z', endedAt: '2026-06-08T12:00:01Z',
  durationMs: 1000, rowsDetected: 0, rowsRepaired: 0, rowsQuarantined: 0, rowsSkipped: 0,
  bySeverity: { critical: 0, warning: 0 }, dryRun: false, success: true,
  triggeredBy: 'scheduler', ...over,
});

const mkLogger = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const fixedNow = new Date('2026-06-08T12:00:00Z');
const mkClock = (): IClock => ({
  now: vi.fn(() => fixedNow),
  epochMs: vi.fn(() => fixedNow.getTime()),
  nowIso: vi.fn(() => fixedNow.toISOString()),
});

let registry: IRuleRegistry;
let configRepo: IRuleConfigRepository;
let executeRule: { execute: ReturnType<typeof vi.fn> };
let uc: ExecuteCycleUseCase;

beforeEach(() => {
  registry = {
    get: vi.fn(),
    listAll: vi.fn(() => []),
    listForTenant: vi.fn(() => []),
    registerCodeRule: vi.fn(), registerDslRule: vi.fn(), unregisterDslRule: vi.fn(),
  };
  configRepo = {
    list: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    get: vi.fn(async () => null),
    upsert: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  };
  executeRule = {
    execute: vi.fn(async () => ({ report: mkReport(), detected: [] })),
  };
  uc = new ExecuteCycleUseCase(
    mkClock(), registry, configRepo,
    executeRule as never, mkLogger(),
  );
});

describe('🚨 selectRules — filter logic', () => {
  it('🚨 no filter → tutte le rules del tenant', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a'), mkRule('rule.b'), mkRule('rule.c'),
    ]);
    await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(executeRule.execute).toHaveBeenCalledTimes(3);
  });

  it('🚨 ruleIds filter → solo i matching', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a'), mkRule('rule.b'), mkRule('rule.c'),
    ]);
    await uc.execute({
      triggeredBy: 'manual', dryRun: false, ruleIds: ['rule.a', 'rule.c'],
    });
    expect(executeRule.execute).toHaveBeenCalledTimes(2);
    const ids = executeRule.execute.mock.calls.map(c => (c[0] as { rule: { id: string } }).rule.id);
    expect(ids.sort()).toEqual(['rule.a', 'rule.c']);
  });

  it('🚨 ruleIds vuoto (length 0) → fallback tutte (per UI guard)', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    await uc.execute({ triggeredBy: 'manual', dryRun: false, ruleIds: [] });
    expect(executeRule.execute).toHaveBeenCalledTimes(1);
  });

  it('🚨 tagFilter → solo rules con almeno 1 tag matching', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a', ['critical']),
      mkRule('rule.b', ['low']),
      mkRule('rule.c', ['critical', 'audit']),
    ]);
    await uc.execute({
      triggeredBy: 'manual', dryRun: false, tagFilter: ['critical'],
    });
    expect(executeRule.execute).toHaveBeenCalledTimes(2); // a + c
  });

  it('🚨 tagFilter multi-tag (OR semantics) → match any', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a', ['critical']),
      mkRule('rule.b', ['audit']),
      mkRule('rule.c', ['other']),
    ]);
    await uc.execute({
      triggeredBy: 'manual', dryRun: false, tagFilter: ['critical', 'audit'],
    });
    expect(executeRule.execute).toHaveBeenCalledTimes(2);
  });

  it('🚨 tagFilter senza match → 0 rules eseguite', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a', ['critical']),
    ]);
    await uc.execute({
      triggeredBy: 'manual', dryRun: false, tagFilter: ['nonexistent'],
    });
    expect(executeRule.execute).not.toHaveBeenCalled();
  });

  it('🚨 ruleIds precedenza su tagFilter (priority)', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a', ['critical']),
      mkRule('rule.b', ['critical']),
    ]);
    await uc.execute({
      triggeredBy: 'manual', dryRun: false,
      ruleIds: ['rule.a'], tagFilter: ['critical'],
    });
    expect(executeRule.execute).toHaveBeenCalledTimes(1);
  });
});

describe('🚨 execute — disabled/lock/skip counters', () => {
  it('🚨 config.enabled=false → SKIP execute + counter rulesSkippedDisabled', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ruleId: 'rule.a', tenantId: 't1', enabled: false,
      schedule: '0 * * * *', dataSourceRef: SYSTEM_REF, maxRowsPerRun: 100,
      severity: 'critical', params: {}, notifyOnDetection: false,
      updatedAt: '2026-06-08T00:00:00Z',
    });
    const report = await uc.execute({ tenantId: 't1', triggeredBy: 'manual', dryRun: false });
    expect(executeRule.execute).not.toHaveBeenCalled();
    expect(report.rulesSkippedDisabled).toBe(1);
    expect(report.rulesExecuted).toBe(0);
  });

  it('🚨 config null (no override) → executeRule chiamato', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await uc.execute({ tenantId: 't1', triggeredBy: 'manual', dryRun: false });
    expect(executeRule.execute).toHaveBeenCalled();
  });

  it('🚨 report.success=false + error startsWith "Lock" → rulesSkippedLock', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    executeRule.execute.mockResolvedValue({
      report: mkReport({ success: false, error: 'Lock contention: held by other process' }),
      detected: [],
    });
    const report = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(report.rulesSkippedLock).toBe(1);
    expect(report.rulesExecuted).toBe(0);
  });

  it('🚨 report.success=false NON lock → conta come executed', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    executeRule.execute.mockResolvedValue({
      report: mkReport({ success: false, error: 'Schema mismatch' }),
      detected: [],
    });
    const report = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(report.rulesSkippedLock).toBe(0);
    expect(report.rulesExecuted).toBe(1);
  });

  it('🚨 mix: 1 success + 1 lock + 1 disabled', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a'), mkRule('rule.b'), mkRule('rule.c'),
    ]);
    (configRepo.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      Promise.resolve(id === 'rule.c'
        ? { ruleId: id, tenantId: 't1', enabled: false, schedule: '0 * * * *',
            dataSourceRef: SYSTEM_REF, maxRowsPerRun: 100, severity: 'critical',
            params: {}, notifyOnDetection: false, updatedAt: '2026-06-08' }
        : null),
    );
    executeRule.execute
      .mockResolvedValueOnce({ report: mkReport({ success: true }), detected: [] })
      .mockResolvedValueOnce({
        report: mkReport({ success: false, error: 'Lock held' }), detected: [],
      });
    const report = await uc.execute({ tenantId: 't1', triggeredBy: 'manual', dryRun: false });
    expect(report.rulesExecuted).toBe(1);
    expect(report.rulesSkippedLock).toBe(1);
    expect(report.rulesSkippedDisabled).toBe(1);
  });
});

describe('🚨 execute — report shape', () => {
  it('🚨 cycleId univoco generato', async () => {
    const r1 = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    const r2 = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(r1.cycleId).not.toBe(r2.cycleId);
  });

  it('🚨 report frozen (immutability)', async () => {
    const r = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.rules)).toBe(true);
  });

  it('🚨 durationMs = endedAt - startedAt (con clock fisso → 0)', async () => {
    const r = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(r.durationMs).toBe(0);
  });

  it('🚨 ISO 8601 startedAt/endedAt', async () => {
    const r = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(r.startedAt).toBe('2026-06-08T12:00:00.000Z');
    expect(r.endedAt).toBe('2026-06-08T12:00:00.000Z');
  });

  it('🚨 dryRun e triggeredBy propagati nel report', async () => {
    const r = await uc.execute({ triggeredBy: 'admin:alice', dryRun: true });
    expect(r.triggeredBy).toBe('admin:alice');
    expect(r.dryRun).toBe(true);
  });

  it('🚨 cycleId propagato al executeRule input', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    const r = await uc.execute({ triggeredBy: 'manual', dryRun: false });
    expect(executeRule.execute).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: r.cycleId,
    }));
  });

  it('🚨 tenantId default "default" se omesso', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkRule('rule.a')]);
    await uc.execute({ triggeredBy: 'scheduler', dryRun: false });
    expect(executeRule.execute).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'default',
    }));
    expect(registry.listForTenant).toHaveBeenCalledWith('default');
  });
});

describe('🚨 execute — sequential ordering', () => {
  it('🚨 rule eseguite in serie (no parallel)', async () => {
    const order: string[] = [];
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkRule('rule.a'), mkRule('rule.b'), mkRule('rule.c'),
    ]);
    executeRule.execute.mockImplementation(async (input: { rule: { id: string } }) => {
      order.push(`start-${input.rule.id}`);
      await new Promise(r => setTimeout(r, 5));
      order.push(`end-${input.rule.id}`);
      return { report: mkReport(), detected: [] };
    });
    await uc.execute({ triggeredBy: 'manual', dryRun: false });
    // Sequenza attesa: start-a, end-a, start-b, end-b, start-c, end-c
    expect(order).toEqual([
      'start-rule.a', 'end-rule.a',
      'start-rule.b', 'end-rule.b',
      'start-rule.c', 'end-rule.c',
    ]);
  });
});
