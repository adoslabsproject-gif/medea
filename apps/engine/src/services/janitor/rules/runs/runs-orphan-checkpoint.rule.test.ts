/**
 * Test 2026-grade — runs.orphan_checkpoint janitor rule.
 *
 * INTEGRITY: checkpoint senza run → recovery sweeper failure ricorrente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runsOrphanCheckpointRule } from './runs-orphan-checkpoint.rule.js';
import { at, first } from '@/__testkit__/assert.js';

const executeRawMock = vi.fn();
const baseCtx = {
  adapter: { executeRaw: executeRawMock },
  logger: { warn: vi.fn() },
  maxRows: 100,
  params: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 metadata', () => {
  it('🚨 id stabile + warning severity', () => {
    expect(runsOrphanCheckpointRule.id).toBe('system.runs.orphan_checkpoint');
    expect(runsOrphanCheckpointRule.defaultSeverity).toBe('warning');
  });

  it('🚨 targetTable workflow_checkpoints (not runs!)', () => {
    expect(runsOrphanCheckpointRule.targetTable).toBe('workflow_checkpoints');
  });

  it('🚨 NO params (binary check)', () => {
    expect(runsOrphanCheckpointRule.paramsSchema).toEqual([]);
  });

  it('🚨 NO repair (orfani non-recoverable, solo quarantine)', () => {
    expect(runsOrphanCheckpointRule.repair).toBeUndefined();
  });

  it('🚨 schedule ogni 2 ore (low-frequency)', () => {
    expect(runsOrphanCheckpointRule.defaultSchedule).toBe('0 */2 * * *');
  });
});

describe('🚨 detect', () => {
  it('🚨 adapter senza executeRaw → []', async () => {
    const r = await runsOrphanCheckpointRule.detect!({ ...baseCtx, adapter: {} } as any);
    expect(r).toEqual([]);
  });

  it('🚨 zero orfani → []', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    expect(await runsOrphanCheckpointRule.detect!(baseCtx as any)).toEqual([]);
  });

  it('🚨 SQL include LEFT JOIN + WHERE r.id IS NULL', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    await runsOrphanCheckpointRule.detect!(baseCtx as any);
    const sql = at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0] as string;
    expect(sql).toMatch(/LEFT JOIN runs/u);
    expect(sql).toMatch(/r\.id IS NULL/u);
  });

  it('🚨 happy: orfano → reason include run_id', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          run_id: 'orphan-run-id',
          workflow_id: 'wf',
          tenant_id: 't-1',
          at_node_id: 'n-mid',
          step_count: 5,
          created_at: '2026-06-07',
        },
      ],
    });
    const r = await runsOrphanCheckpointRule.detect!(baseCtx as any);
    expect(r.length).toBe(1);
    const row = first(r, 'orphan-rows');
    expect(row.id).toBe('42'); // id stringified
    expect(row.reason).toContain('orphan-run-id');
    expect(row.tenantId).toBe('t-1');
  });

  it('🚨 id INT → coerced to string in result', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 99,
          run_id: 'x',
          workflow_id: 'w',
          tenant_id: null,
          at_node_id: 'n',
          step_count: 0,
          created_at: '',
        },
      ],
    });
    const r = await runsOrphanCheckpointRule.detect!(baseCtx as any);
    const row = first(r, 'orphan-rows');
    expect(typeof row.id).toBe('string');
    expect(row.id).toBe('99');
  });

  it('🚨 LIMIT maxRows in SQL', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    await runsOrphanCheckpointRule.detect!({ ...baseCtx, maxRows: 73 } as any);
    expect(at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0]).toContain('LIMIT 73');
  });
});
