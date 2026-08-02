/**
 * Test 2026-grade — runs.corrupted_json janitor rule.
 *
 * CRITICAL: severity critical → blocca dashboard rendering.
 * DEFENSIVE: NO repair (JSON troncato non recoverable, quarantine only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runsCorruptedJsonRule } from './runs-corrupted-json.rule.js';
import { first } from '@/__testkit__/assert.js';

const executeRawMock = vi.fn();
const baseCtx = {
  adapter: { executeRaw: executeRawMock },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  maxRows: 100,
  params: { scanWindowSize: 500 },
  dryRun: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 rule metadata', () => {
  it('🚨 id stabile', () => {
    expect(runsCorruptedJsonRule.id).toBe('system.runs.corrupted_json');
  });

  it('🚨 severity critical (data-loss visibility)', () => {
    expect(runsCorruptedJsonRule.defaultSeverity).toBe('critical');
  });

  it('🚨 NO repair function (recovery non-possibile)', () => {
    expect(runsCorruptedJsonRule.repair).toBeUndefined();
  });

  it('🚨 paramsSchema scanWindowSize 50-5000', () => {
    const p = first(runsCorruptedJsonRule.paramsSchema, 'paramsSchema');
    expect(p.name).toBe('scanWindowSize');
    // Narrowing reale via discriminant: min/max esistono solo su RuleParamNumber.
    if (p.type !== 'number') throw new Error(`atteso param 'number', ricevuto '${p.type}'`);
    expect(p.min).toBe(50);
    expect(p.max).toBe(5000);
  });
});

describe('🚨 detect — checkStepsJson logic', () => {
  it('🚨 adapter senza executeRaw → []', async () => {
    const r = await runsCorruptedJsonRule.detect!({ ...baseCtx, adapter: {} } as any);
    expect(r).toEqual([]);
  });

  it('🚨 zero rows → []', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    expect(await runsCorruptedJsonRule.detect!(baseCtx as any)).toEqual([]);
  });

  it('🚨 valid JSON array → NO detection', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-ok',
          workflow_id: 'w',
          tenant_id: 't',
          status: 's',
          started_at: 'a',
          ended_at: 'b',
          steps_json: JSON.stringify([{ nodeId: 'n' }]),
        },
      ],
    });
    expect(await runsCorruptedJsonRule.detect!(baseCtx as any)).toEqual([]);
  });

  it('🚨 NULL steps_json → detected "campo NULL"', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-null',
          workflow_id: 'w',
          tenant_id: null,
          status: 's',
          started_at: 'a',
          ended_at: null,
          steps_json: null,
        },
      ],
    });
    const r = await runsCorruptedJsonRule.detect!(baseCtx as any);
    expect(r.length).toBe(1);
    const row = first(r, 'corrupted-rows');
    expect(row.reason).toMatch(/campo NULL/u);
    expect(row.severity).toBe('critical');
  });

  it('🚨 stringa vuota → detected', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-empty',
          workflow_id: 'w',
          tenant_id: null,
          status: 's',
          started_at: 'a',
          ended_at: null,
          steps_json: '',
        },
      ],
    });
    const r = await runsCorruptedJsonRule.detect!(baseCtx as any);
    expect(first(r, 'corrupted-rows').reason).toMatch(/stringa vuota/u);
  });

  it('🚨 JSON troncato → reason "JSON troncato"', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-trunc',
          workflow_id: 'w',
          tenant_id: null,
          status: 's',
          started_at: 'a',
          ended_at: null,
          steps_json: '[{"nodeId":"n"',
        },
      ],
    });
    const r = await runsCorruptedJsonRule.detect!(baseCtx as any);
    expect(first(r, 'corrupted-rows').reason).toMatch(/troncato|non valido/u);
  });

  it('🚨 JSON valido MA non-array → detected "formato inatteso"', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-obj',
          workflow_id: 'w',
          tenant_id: null,
          status: 's',
          started_at: 'a',
          ended_at: null,
          steps_json: '{}',
        },
      ],
    });
    const r = await runsCorruptedJsonRule.detect!(baseCtx as any);
    expect(first(r, 'corrupted-rows').reason).toMatch(/formato inatteso.*array.*object/u);
  });

  it('🚨 tenantId propagato se != null', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-t',
          workflow_id: 'w',
          tenant_id: 't-7',
          status: 's',
          started_at: 'a',
          ended_at: null,
          steps_json: 'x',
        },
      ],
    });
    const r = await runsCorruptedJsonRule.detect!(baseCtx as any);
    expect(first(r, 'corrupted-rows').tenantId).toBe('t-7');
  });

  it('🚨 maxRows cap', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `r-${i}`,
      workflow_id: 'w',
      tenant_id: null,
      status: 's',
      started_at: 'a',
      ended_at: null,
      steps_json: 'broken',
    }));
    executeRawMock.mockResolvedValueOnce({ rows });
    const r = await runsCorruptedJsonRule.detect!({ ...baseCtx, maxRows: 10 } as any);
    expect(r.length).toBe(10);
  });
});
