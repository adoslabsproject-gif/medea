/**
 * Test 2026-grade — runs.truncated_steps janitor rule.
 *
 * INTEGRITY: detect run con ended_at + step running (replay duplicate side-effect).
 * AUTO-REPAIR: enableAutoRepair=true marca step running → error, NO quarantine.
 * SAFETY: dryRun → NO mutation; broken JSON → ignored (next rule handles).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runsTruncatedStepsRule } from './runs-truncated-steps.rule.js';
import { at, first } from '@/__testkit__/assert.js';

const executeRawMock = vi.fn();
const baseCtx = {
  adapter: { executeRaw: executeRawMock },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  maxRows: 100,
  params: { enableAutoRepair: false },
  dryRun: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 rule metadata', () => {
  it('🚨 kind=code + id stabile', () => {
    expect(runsTruncatedStepsRule.kind).toBe('code');
    expect(runsTruncatedStepsRule.id).toBe('system.runs.truncated_steps');
  });

  it('🚨 paramsSchema include enableAutoRepair', () => {
    const p = runsTruncatedStepsRule.paramsSchema.find((p) => p.name === 'enableAutoRepair');
    expect(p).toBeDefined();
    expect(p!.type).toBe('boolean');
    expect(p!.default).toBe(false);
  });

  it('🚨 defaultSeverity warning + targetTable runs', () => {
    expect(runsTruncatedStepsRule.defaultSeverity).toBe('warning');
    expect(runsTruncatedStepsRule.targetTable).toBe('runs');
  });
});

describe('🚨 detect', () => {
  it('🚨 adapter senza executeRaw → return [] + warn', async () => {
    const ctx: any = { ...baseCtx, adapter: {} };
    const r = await runsTruncatedStepsRule.detect!(ctx);
    expect(r).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('🚨 zero rows → []', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    const r = await runsTruncatedStepsRule.detect!(baseCtx as any);
    expect(r).toEqual([]);
  });

  it('🚨 run senza step running → skip', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-1',
          workflow_id: 'wf',
          tenant_id: 't',
          status: 'success',
          started_at: 'a',
          ended_at: 'b',
          steps_json: JSON.stringify([{ nodeId: 'n1', status: 'success' }]),
          error_count: 0,
        },
      ],
    });
    const r = await runsTruncatedStepsRule.detect!(baseCtx as any);
    expect(r.length).toBe(0);
  });

  it('🚨 run con 1+ step running → detected', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-bad',
          workflow_id: 'wf',
          tenant_id: 't-1',
          status: 'success',
          started_at: 'a',
          ended_at: '2026-06-07',
          steps_json: JSON.stringify([
            { nodeId: 'n1', status: 'success' },
            { nodeId: 'n2', status: 'running' },
            { nodeId: 'n3', status: 'running' },
          ]),
          error_count: 0,
        },
      ],
    });
    const r = await runsTruncatedStepsRule.detect!(baseCtx as any);
    expect(r.length).toBe(1);
    const row = first(r, 'truncated-rows');
    expect(row.id).toBe('r-bad');
    expect(row.reason).toMatch(/2 step ancora in status='running'/u);
    expect(row.severity).toBe('warning');
    expect(row.tenantId).toBe('t-1');
  });

  it('🚨 tenant_id null → tenantId NON nel result', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-no-tenant',
          workflow_id: 'wf',
          tenant_id: null,
          status: 'success',
          started_at: 'a',
          ended_at: 'b',
          steps_json: JSON.stringify([{ nodeId: 'n', status: 'running' }]),
          error_count: 0,
        },
      ],
    });
    const r = await runsTruncatedStepsRule.detect!(baseCtx as any);
    expect(first(r, 'truncated-rows').tenantId).toBeUndefined();
  });

  it('🚨 steps_json malformato → skip (no throw)', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-broken',
          workflow_id: 'wf',
          tenant_id: null,
          status: 'success',
          started_at: 'a',
          ended_at: 'b',
          steps_json: 'not-json{',
          error_count: 0,
        },
      ],
    });
    const r = await runsTruncatedStepsRule.detect!(baseCtx as any);
    expect(r).toEqual([]);
  });

  it('🚨 maxRows cap output (anche se SQL LIMIT più alto)', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `r-${i}`,
      workflow_id: 'wf',
      tenant_id: null,
      status: 'success',
      started_at: 'a',
      ended_at: 'b',
      steps_json: JSON.stringify([{ status: 'running' }]),
      error_count: 0,
    }));
    executeRawMock.mockResolvedValueOnce({ rows });
    const r = await runsTruncatedStepsRule.detect!({ ...baseCtx, maxRows: 50 } as any);
    expect(r.length).toBe(50);
  });
});

describe('🚨 repair — auto-repair gated by enableAutoRepair', () => {
  const detectedRow = {
    id: 'r-1',
    reason: 'x',
    severity: 'warning',
    raw: {
      id: 'r-1',
      steps_json: JSON.stringify([
        { nodeId: 'n1', status: 'success' },
        { nodeId: 'n2', status: 'running' },
        { nodeId: 'n3', status: 'running' },
      ]),
      error_count: 2,
    },
  };

  it('🚨 enableAutoRepair=false → repairedIds vuoto', async () => {
    const r = await runsTruncatedStepsRule.repair!(baseCtx as any, [detectedRow as any]);
    expect(r.repairedIds).toEqual([]);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('🚨 dryRun=true → repairedIds vuoto anche con autoRepair', async () => {
    const ctx = { ...baseCtx, params: { enableAutoRepair: true }, dryRun: true };
    const r = await runsTruncatedStepsRule.repair!(ctx as any, [detectedRow as any]);
    expect(r.repairedIds).toEqual([]);
  });

  it('🚨 happy: UPDATE step running → error', async () => {
    executeRawMock.mockResolvedValueOnce({});
    const ctx = { ...baseCtx, params: { enableAutoRepair: true }, dryRun: false };
    const r = await runsTruncatedStepsRule.repair!(ctx as any, [detectedRow as any]);
    expect(r.repairedIds).toEqual(['r-1']);
    const sql = at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0] as string;
    expect(sql).toContain('UPDATE runs');
    expect(sql).toContain('partial');
    expect(sql).toContain('error_count = 4'); // 2 running + 2 pre = 4
  });

  it("🚨 SQL injection-safe: id e steps_json escaped via replace(/'/g, \"''\")", async () => {
    executeRawMock.mockResolvedValueOnce({});
    const evilRow = {
      ...detectedRow,
      id: "r'; DROP TABLE runs; --",
      raw: { ...detectedRow.raw, id: "r'; DROP TABLE runs; --" },
    };
    const ctx = { ...baseCtx, params: { enableAutoRepair: true }, dryRun: false };
    await runsTruncatedStepsRule.repair!(ctx as any, [evilRow as any]);
    const sql = at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0] as string;
    expect(sql).toContain("r''; DROP TABLE runs; --");
    expect(sql).not.toContain("'r'; DROP TABLE");
  });

  it('🚨 steps_json non-string → skip (no crash)', async () => {
    const badRow = { ...detectedRow, raw: { ...detectedRow.raw, steps_json: 42 } };
    const ctx = { ...baseCtx, params: { enableAutoRepair: true }, dryRun: false };
    const r = await runsTruncatedStepsRule.repair!(ctx as any, [badRow as any]);
    expect(r.repairedIds).toEqual([]);
  });

  it('🚨 step già success → no mutation, no UPDATE', async () => {
    const noMutateRow = {
      ...detectedRow,
      raw: {
        ...detectedRow.raw,
        steps_json: JSON.stringify([{ nodeId: 'n', status: 'success' }]),
      },
    };
    const ctx = { ...baseCtx, params: { enableAutoRepair: true }, dryRun: false };
    const r = await runsTruncatedStepsRule.repair!(ctx as any, [noMutateRow as any]);
    expect(r.repairedIds).toEqual([]);
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('🚨 broken JSON in steps_json → skip silently', async () => {
    const brokenRow = {
      ...detectedRow,
      raw: { ...detectedRow.raw, steps_json: 'broken{' },
    };
    const ctx = { ...baseCtx, params: { enableAutoRepair: true }, dryRun: false };
    const r = await runsTruncatedStepsRule.repair!(ctx as any, [brokenRow as any]);
    expect(r.repairedIds).toEqual([]);
  });
});
