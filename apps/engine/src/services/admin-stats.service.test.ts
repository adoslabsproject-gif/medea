/**
 * Test 2026-grade — AdminStatsService (cross-tenant + per-tenant dashboard).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { first } from '@/__testkit__/assert.js';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: sqliteInst }) }));

const { AdminStatsService } = await import('./admin-stats.service.js');

function seedFixture(tenantId = 't-1', { runs = 0, errors = 0, success = 0 } = {}) {
  const now = Date.now();
  const old = new Date(now - 1000).toISOString();
  for (let i = 0; i < runs - errors - success; i++) {
    sqliteInst
      .prepare(
        `INSERT INTO runs (id, tenant_id, workflow_id, status, started_at, total_duration_ms, error_count) VALUES (?, ?, 'wf', 'partial', ?, 100, 0)`,
      )
      .run(`r-${tenantId}-${i}`, tenantId, old);
  }
  for (let i = 0; i < errors; i++) {
    sqliteInst
      .prepare(
        `INSERT INTO runs (id, tenant_id, workflow_id, status, started_at, total_duration_ms, error_count) VALUES (?, ?, 'wf', 'error', ?, 100, 1)`,
      )
      .run(`re-${tenantId}-${i}`, tenantId, old);
  }
  for (let i = 0; i < success; i++) {
    sqliteInst
      .prepare(
        `INSERT INTO runs (id, tenant_id, workflow_id, status, started_at, total_duration_ms, ended_at, error_count) VALUES (?, ?, 'wf', 'success', ?, 200, ?, 0)`,
      )
      .run(`rs-${tenantId}-${i}`, tenantId, old, new Date(now).toISOString());
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`
    CREATE TABLE users (id TEXT, tenant_id TEXT, enabled INTEGER);
    CREATE TABLE workflows (id TEXT, tenant_id TEXT, name TEXT, enabled INTEGER);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, tenant_id TEXT, workflow_id TEXT, status TEXT,
      started_at TEXT, ended_at TEXT, total_duration_ms INTEGER, error_count INTEGER
    );
  `);
});

describe('🚨 instance', () => {
  it('🚨 zero data → all zero + successRate=100', () => {
    const r = new AdminStatsService().instance();
    expect(r).toEqual({
      tenants: 0,
      users: 0,
      workflows: 0,
      activeWorkflows: 0,
      runsLast24h: 0,
      runsLast7d: 0,
      errorsLast24h: 0,
      successRate7d: 100,
    });
  });

  it('🚨 cross-tenant aggregate count', () => {
    sqliteInst.exec(
      `INSERT INTO users VALUES ('u1', 't-A', 1), ('u2', 't-A', 1), ('u3', 't-B', 1)`,
    );
    sqliteInst.exec(`INSERT INTO workflows VALUES ('w1', 't-A', 'WF', 1), ('w2', 't-B', 'WF', 0)`);
    seedFixture('t-A', { runs: 10, errors: 2, success: 7 });
    const r = new AdminStatsService().instance();
    expect(r.tenants).toBe(2);
    expect(r.users).toBe(3);
    expect(r.workflows).toBe(2);
    expect(r.activeWorkflows).toBe(1);
    expect(r.runsLast24h).toBe(10);
    expect(r.errorsLast24h).toBe(2);
    expect(r.successRate7d).toBe(70.0); // 7/10
  });

  it('🚨 enabled=0 user NOT counted', () => {
    sqliteInst.exec(`INSERT INTO users VALUES ('u1', 't', 1), ('u2', 't', 0)`);
    expect(new AdminStatsService().instance().users).toBe(1);
  });
});

describe('🚨 tenants()', () => {
  it('🚨 ordered by runsLast24h DESC', () => {
    sqliteInst.exec(`INSERT INTO users VALUES ('u1', 'tenant-low', 1), ('u2', 'tenant-high', 1)`);
    seedFixture('tenant-low', { runs: 2 });
    seedFixture('tenant-high', { runs: 10 });
    const t = new AdminStatsService().tenants();
    const t0 = first(t, 'tenants');
    expect(t0.tenantId).toBe('tenant-high');
    expect(t0.runsLast24h).toBe(10);
  });
});

describe('🚨 tenantDashboard', () => {
  beforeEach(() => {
    sqliteInst.exec(`INSERT INTO workflows VALUES ('wf-1', 't-1', 'Hello WF', 1)`);
    seedFixture('t-1', { runs: 5, errors: 1, success: 3 });
  });

  it('🚨 returns full shape', () => {
    const r = new AdminStatsService().tenantDashboard('t-1');
    expect(r.workflows).toBe(1);
    expect(r.activeWorkflows).toBe(1);
    expect(r.runsLast24h).toBe(5);
    expect(r.runsLast7d).toBe(5);
    expect(r.errorsLast7d).toBe(1);
    expect(r.successLast7d).toBe(3);
    expect(r.successRate7d).toBe(60.0); // 3/5
    expect(r.avgDurationMs7d).toBe(200);
  });

  it('🚨 recentRuns limit 20 + ordered DESC', () => {
    for (let i = 0; i < 25; i++) {
      sqliteInst
        .prepare(
          `INSERT INTO runs (id, tenant_id, workflow_id, status, started_at) VALUES (?, 't-1', 'wf-1', 'success', ?)`,
        )
        .run(`r-extra-${i}`, new Date(Date.now() - i * 1000).toISOString());
    }
    const r = new AdminStatsService().tenantDashboard('t-1');
    expect(r.recentRuns.length).toBeLessThanOrEqual(20);
  });

  it('🚨 currentlyRunning = ended_at NULL only', () => {
    sqliteInst
      .prepare(
        `INSERT INTO runs (id, tenant_id, workflow_id, status, started_at, ended_at) VALUES ('inflight-1', 't-1', 'wf-1', 'running', ?, NULL)`,
      )
      .run(new Date().toISOString());
    sqliteInst
      .prepare(
        `INSERT INTO runs (id, tenant_id, workflow_id, status, started_at, ended_at) VALUES ('done-1', 't-1', 'wf-1', 'success', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    const r = new AdminStatsService().tenantDashboard('t-1');
    expect(r.currentlyRunning.find((c) => c.id === 'inflight-1')).toBeDefined();
    expect(r.currentlyRunning.find((c) => c.id === 'done-1')).toBeUndefined();
  });

  it('🚨 successRate=100 quando runs=0 (no zero-div)', () => {
    const r = new AdminStatsService().tenantDashboard('tenant-empty');
    expect(r.successRate7d).toBe(100);
  });

  it('🚨 avgDurationMs7d → 0 se nessun success', () => {
    sqliteInst.exec(`DELETE FROM runs WHERE status='success'`);
    const r = new AdminStatsService().tenantDashboard('t-1');
    expect(r.avgDurationMs7d).toBe(0);
  });
});
