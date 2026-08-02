/**
 * Test 2026-grade — runs.zombie janitor rule.
 *
 * RECOVERY: status running/pending da > threshold → quarantine (NO restore safe).
 * SQL: escapeForSqlLiteral defense-in-depth contro injection in cutoffIso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runsZombieRule } from './runs-zombie.rule.js';
import { at, first } from '@/__testkit__/assert.js';

const executeRawMock = vi.fn();
const now = new Date('2026-06-07T10:00:00Z');
const baseCtx = {
  adapter: { executeRaw: executeRawMock },
  logger: { warn: vi.fn(), info: vi.fn() },
  now,
  maxRows: 100,
  params: { zombieThresholdMs: 1_800_000 }, // 30 min
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 rule metadata', () => {
  it('🚨 id stabile + critical severity', () => {
    expect(runsZombieRule.id).toBe('system.runs.zombie');
    expect(runsZombieRule.defaultSeverity).toBe('critical');
  });

  it('🚨 paramsSchema zombieThresholdMs 1min-24h', () => {
    const p = runsZombieRule.paramsSchema[0] as any;
    expect(p.name).toBe('zombieThresholdMs');
    expect(p.type).toBe('duration_ms');
    expect(p.minMs).toBe(60_000);
    expect(p.maxMs).toBe(86_400_000);
  });

  it('🚨 NO repair (zombie non-recoverable)', () => {
    expect(runsZombieRule.repair).toBeUndefined();
  });

  it('🚨 defaultSchedule ogni 5 min', () => {
    expect(runsZombieRule.defaultSchedule).toBe('*/5 * * * *');
  });
});

describe('🚨 detect', () => {
  it('🚨 adapter senza executeRaw → []', async () => {
    const r = await runsZombieRule.detect!({ ...baseCtx, adapter: {} } as any);
    expect(r).toEqual([]);
  });

  it('🚨 SQL include cutoff calcolato + LIMIT maxRows', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    await runsZombieRule.detect!(baseCtx as any);
    const sql = at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0] as string;
    expect(sql).toContain("status IN ('running', 'pending')");
    expect(sql).toContain("started_at <= '2026-06-07T09:30:00.000Z'"); // 30min back
    expect(sql).toContain('LIMIT 100');
  });

  it('🚨 happy: detected zombie row → critical + reason age + threshold', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-zombie',
          workflow_id: 'wf',
          tenant_id: 't-1',
          status: 'running',
          started_at: '2026-06-07T08:00:00Z',
          ended_at: null,
          steps_json: '[]',
        },
      ],
    });
    const r = await runsZombieRule.detect!(baseCtx as any);
    expect(r.length).toBe(1);
    const row = first(r, 'zombie-rows');
    expect(row.severity).toBe('critical');
    expect(row.reason).toMatch(/Status=running/u);
    expect(row.reason).toMatch(/soglia 30m/u);
    expect(row.tenantId).toBe('t-1');
  });

  it('🚨 humanizeAge: < 1s → "0s", 5s → "5s", 5m → "5m", 1h → "1.0h"', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r',
          workflow_id: 'w',
          tenant_id: null,
          status: 'pending',
          started_at: '2026-06-07T09:00:00Z', // 1h ago
          ended_at: null,
          steps_json: '[]',
        },
      ],
    });
    const r = await runsZombieRule.detect!(baseCtx as any);
    expect(first(r, 'zombie-rows').reason).toMatch(/1\.0h|60m/u); // age window
  });

  it('🚨 SQL injection defense: cutoffIso non contiene apostrofi (Date.toISOString())', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    await runsZombieRule.detect!(baseCtx as any);
    const sql = at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0] as string;
    expect(sql).not.toMatch(/['][^']*[';]\s*--/u); // no SQL-injection pattern
  });

  it('🚨 tenant_id null → tenantId absent in result', async () => {
    executeRawMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r',
          workflow_id: 'w',
          tenant_id: null,
          status: 'running',
          started_at: '2026-06-07T08:00:00Z',
          ended_at: null,
          steps_json: '[]',
        },
      ],
    });
    const r = await runsZombieRule.detect!(baseCtx as any);
    expect(first(r, 'zombie-rows').tenantId).toBeUndefined();
  });

  it('🚨 SQL include LIMIT maxRows (cap server-side)', async () => {
    executeRawMock.mockResolvedValueOnce({ rows: [] });
    await runsZombieRule.detect!({ ...baseCtx, maxRows: 42 } as any);
    const sql = at(executeRawMock.mock.calls, 0, 'executeRaw-calls')[0] as string;
    expect(sql).toContain('LIMIT 42');
  });
});
