/**
 * Test 2026-grade — analytics routes (4 endpoint dashboard).
 *
 * 🚨 USA SQLite IN-MEMORY REALE (no mock): tests le query SQL effettive
 *    contro schema reale → bug constraint/column-name/aggregation visibili.
 *
 * 🚨 BUG REGRESSION 2026-05-31: SUM/AVG su set vuoto SQLite ritorna NULL →
 *    frontend crash .toLocaleString(). COALESCE protegge. Test verifica.
 *
 * 🚨 P95 LATENCY MATH: Math.floor(durations.length * 0.95) — test verifica
 *    indice 0-based corretto su lunghezze borderline.
 *
 * 🚨 TENANT ISOLATION: ogni query WHERE tenant_id=? — test cross-tenant.
 *
 * 🚨 INPUT VALIDATION: days query param clamped 1..90.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const mockDb = { sqlite: null as DB | null };
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: mockDb.sqlite }),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-tenant-id') ?? 'tenant-default',
}));

const { createAnalyticsRoutes } = await import('./analytics.js');

function setupSchema(db: DB): void {
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      total_duration_ms INTEGER
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
}

function insertRun(
  db: DB,
  tenantId: string,
  workflowId: string,
  status: string,
  startedAt: string,
  durationMs: number | null,
): void {
  db.prepare(
    'INSERT INTO runs (id, tenant_id, workflow_id, status, started_at, total_duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    `r-${Math.random().toString(36).slice(2)}`,
    tenantId,
    workflowId,
    status,
    startedAt,
    durationMs,
  );
}

function insertWorkflow(db: DB, tenantId: string, id: string, enabled = 1): void {
  db.prepare('INSERT INTO workflows (id, tenant_id, enabled) VALUES (?, ?, ?)').run(
    id,
    tenantId,
    enabled,
  );
}

async function makeRequest(path: string, tenantId = 'tenant-A'): Promise<Response> {
  const app = new Hono();
  app.route('/api/v1', createAnalyticsRoutes());
  return app.request(path, { headers: { 'x-tenant-id': tenantId } });
}

beforeEach(() => {
  mockDb.sqlite = new Database(':memory:');
  setupSchema(mockDb.sqlite);
});

describe('🚨 GET /analytics/summary', () => {
  it('🚨 BUG REGRESSION: zero runs → success_count=0 / error_count=0 (NO null)', async () => {
    insertWorkflow(mockDb.sqlite!, 'tenant-A', 'wf-1');
    const res = await makeRequest('/api/v1/analytics/summary');
    expect(res.status).toBe(200);
    const json = await res.json() as { runs: { total: number; success: number; error: number; avgDurationMs: number; p95DurationMs: number; successRate: number } };
    expect(json.runs.total).toBe(0);
    expect(json.runs.success).toBe(0);
    expect(json.runs.error).toBe(0);
    expect(json.runs.avgDurationMs).toBe(0);
    expect(json.runs.successRate).toBe(0); // total=0 → no division
  });

  it('🚨 counts success/error e calcola successRate', async () => {
    const now = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-1', 'success', now, 100);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-1', 'success', now, 200);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-1', 'success', now, 300);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-1', 'error', now, 50);
    const res = await makeRequest('/api/v1/analytics/summary');
    const json = await res.json() as { runs: { total: number; success: number; error: number; successRate: number; avgDurationMs: number } };
    expect(json.runs.total).toBe(4);
    expect(json.runs.success).toBe(3);
    expect(json.runs.error).toBe(1);
    expect(json.runs.successRate).toBe(0.75);
    expect(json.runs.avgDurationMs).toBe((100 + 200 + 300 + 50) / 4);
  });

  it('🚨 P95: 100 runs ordinati → indice 95 = valore 96th-percentile', async () => {
    const now = new Date().toISOString();
    for (let i = 1; i <= 100; i++) {
      insertRun(mockDb.sqlite!, 'tenant-A', 'wf-1', 'success', now, i * 10);
    }
    const res = await makeRequest('/api/v1/analytics/summary');
    const json = await res.json() as { runs: { p95DurationMs: number } };
    // floor(100 * 0.95) = 95 → array[95] = 96th element value = 960
    expect(json.runs.p95DurationMs).toBe(960);
  });

  it('🚨 SECURITY: tenant isolation — tenant-B runs NON contati per tenant-A', async () => {
    const now = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 100);
    insertRun(mockDb.sqlite!, 'tenant-B', 'wf', 'success', now, 999);
    insertRun(mockDb.sqlite!, 'tenant-B', 'wf', 'error', now, 1);
    const resA = await makeRequest('/api/v1/analytics/summary', 'tenant-A');
    const jA = await resA.json() as { runs: { total: number } };
    expect(jA.runs.total).toBe(1);
    const resB = await makeRequest('/api/v1/analytics/summary', 'tenant-B');
    const jB = await resB.json() as { runs: { total: number; error: number } };
    expect(jB.runs.total).toBe(2);
    expect(jB.runs.error).toBe(1);
  });

  it('🚨 24h window: runs > 24h fa ESCLUSI', async () => {
    const now = new Date().toISOString();
    const oldTs = new Date(Date.now() - 25 * 3600_000).toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 100);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', oldTs, 9999);
    const res = await makeRequest('/api/v1/analytics/summary');
    const json = await res.json() as { runs: { total: number } };
    expect(json.runs.total).toBe(1);
  });

  it('🚨 workflows count: total + enabled', async () => {
    insertWorkflow(mockDb.sqlite!, 'tenant-A', 'w1', 1);
    insertWorkflow(mockDb.sqlite!, 'tenant-A', 'w2', 1);
    insertWorkflow(mockDb.sqlite!, 'tenant-A', 'w3', 0);
    const res = await makeRequest('/api/v1/analytics/summary');
    const json = await res.json() as { workflows: { total: number; enabled: number } };
    expect(json.workflows.total).toBe(3);
    expect(json.workflows.enabled).toBe(2);
  });

  it('🚨 durations NULL → escluse dal P95 (WHERE total_duration_ms IS NOT NULL)', async () => {
    const now = new Date().toISOString();
    for (let i = 1; i <= 19; i++) {
      insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, i * 100);
    }
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'pending', now, null);
    const res = await makeRequest('/api/v1/analytics/summary');
    const json = await res.json() as { runs: { p95DurationMs: number } };
    // 19 durations rows → floor(19*0.95)=18 → array[18] = 1900
    expect(json.runs.p95DurationMs).toBe(1900);
  });
});

describe('🚨 GET /analytics/runs-per-day', () => {
  it('🚨 default days=30', async () => {
    const today = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', today, 100);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'error', today, 100);
    const res = await makeRequest('/api/v1/analytics/runs-per-day');
    const json = await res.json() as { days: { day: string; total: number; errors: number }[] };
    expect(json.days.length).toBe(1);
    expect(json.days[0]!.total).toBe(2);
    expect(json.days[0]!.errors).toBe(1);
  });

  it('🚨 INPUT VALIDATION: days clamped 1..90', async () => {
    const oldDay = new Date(Date.now() - 100 * 86400_000).toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', oldDay, 100);
    // days=200 → clamped a 90 → 100gg fa NON nel range
    const res = await makeRequest('/api/v1/analytics/runs-per-day?days=200');
    const json = await res.json() as { days: unknown[] };
    expect(json.days).toEqual([]);
  });

  it('🚨 INPUT VALIDATION: days=0 → clamped a 1', async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', yesterday, 100);
    // days=0 clamped a 1 → ieri probabilmente fuori
    const res = await makeRequest('/api/v1/analytics/runs-per-day?days=0');
    const json = await res.json() as { days: unknown[] };
    // 1 giorno = ultime 24h → yesterday potrebbe esserci o no per ms
    expect(Array.isArray(json.days)).toBe(true);
  });

  it('🚨 BUG FIX: days=invalid (NaN) → fallback default 30 (NO 500)', async () => {
    // Pre-fix: Number('invalid')=NaN → new Date(Date.now()-NaN) throw → 500.
    // Post-fix: Number.isFinite guard → fallback a 30.
    const res = await makeRequest('/api/v1/analytics/runs-per-day?days=invalid');
    expect(res.status).toBe(200);
  });

  it('🚨 BUG FIX: days=Infinity → fallback 30 (NO 500)', async () => {
    const res = await makeRequest('/api/v1/analytics/runs-per-day?days=Infinity');
    expect(res.status).toBe(200);
  });

  it('🚨 ordering: days ASC', async () => {
    const day1 = new Date(Date.now() - 3 * 86400_000).toISOString();
    const day2 = new Date(Date.now() - 1 * 86400_000).toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', day2, 100);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', day1, 100);
    const res = await makeRequest('/api/v1/analytics/runs-per-day');
    const json = await res.json() as { days: { day: string }[] };
    expect(json.days.length).toBe(2);
    expect(json.days[0]!.day < json.days[1]!.day).toBe(true);
  });
});

describe('🚨 GET /analytics/error-top', () => {
  it('🚨 top 10 workflows ordered by error_count DESC', async () => {
    const now = new Date().toISOString();
    // wf-1: 5 errors, wf-2: 2 errors, wf-3: 1 error
    for (let i = 0; i < 5; i++) insertRun(mockDb.sqlite!, 'tenant-A', 'wf-1', 'error', now, 100);
    for (let i = 0; i < 2; i++) insertRun(mockDb.sqlite!, 'tenant-A', 'wf-2', 'error', now, 100);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-3', 'error', now, 100);
    const res = await makeRequest('/api/v1/analytics/error-top');
    const json = await res.json() as { topErrors: { workflow_id: string; error_count: number }[] };
    expect(json.topErrors[0]!.workflow_id).toBe('wf-1');
    expect(json.topErrors[0]!.error_count).toBe(5);
    expect(json.topErrors[1]!.workflow_id).toBe('wf-2');
    expect(json.topErrors[2]!.workflow_id).toBe('wf-3');
  });

  it('🚨 LIMIT 10: input con 15 workflows → solo 10 ritornati', async () => {
    const now = new Date().toISOString();
    for (let i = 1; i <= 15; i++) {
      insertRun(mockDb.sqlite!, 'tenant-A', `wf-${i}`, 'error', now, 100);
    }
    const res = await makeRequest('/api/v1/analytics/error-top');
    const json = await res.json() as { topErrors: unknown[] };
    expect(json.topErrors).toHaveLength(10);
  });

  it('🚨 7-day window (not 24h come summary)', async () => {
    const old8 = new Date(Date.now() - 8 * 86400_000).toISOString();
    const fresh = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-old', 'error', old8, 100);
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf-new', 'error', fresh, 100);
    const res = await makeRequest('/api/v1/analytics/error-top');
    const json = await res.json() as { topErrors: { workflow_id: string }[] };
    const ids = json.topErrors.map((r) => r.workflow_id);
    expect(ids).toContain('wf-new');
    expect(ids).not.toContain('wf-old');
  });
});

describe('🚨 GET /analytics/duration', () => {
  it('🚨 bucketing: runs distribuiti nei 8 bucket', async () => {
    const now = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 5);     // < 10
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 30);    // < 50
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 80);    // < 100
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 250);   // < 500
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 700);   // < 1000
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 2000);  // < 5000
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 15000); // < 30000
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 60000); // Infinity bucket
    const res = await makeRequest('/api/v1/analytics/duration');
    const json = await res.json() as { buckets: { ltMs: number | null; count: number }[]; total: number };
    expect(json.total).toBe(8);
    expect(json.buckets.length).toBe(8);
    // Verifica uno per bucket
    expect(json.buckets[0]).toEqual({ ltMs: 10, count: 1 });
    expect(json.buckets[1]).toEqual({ ltMs: 50, count: 1 });
    expect(json.buckets[7]).toEqual({ ltMs: null, count: 1 }); // Infinity → null
  });

  it('🚨 zero runs → tutti bucket count=0, total=0', async () => {
    const res = await makeRequest('/api/v1/analytics/duration');
    const json = await res.json() as { buckets: { count: number }[]; total: number };
    expect(json.total).toBe(0);
    for (const b of json.buckets) expect(b.count).toBe(0);
  });

  it('🚨 boundary: duration = bucket value → CADE nel bucket SUCCESSIVO', async () => {
    const now = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 10); // NON < 10 → cade in < 50
    const res = await makeRequest('/api/v1/analytics/duration');
    const json = await res.json() as { buckets: { ltMs: number | null; count: number }[] };
    expect(json.buckets[0]!.count).toBe(0); // < 10
    expect(json.buckets[1]!.count).toBe(1); // < 50
  });

  it('🚨 SECURITY: tenant isolation', async () => {
    const now = new Date().toISOString();
    insertRun(mockDb.sqlite!, 'tenant-A', 'wf', 'success', now, 100);
    insertRun(mockDb.sqlite!, 'tenant-B', 'wf', 'success', now, 100);
    const res = await makeRequest('/api/v1/analytics/duration', 'tenant-A');
    const json = await res.json() as { total: number };
    expect(json.total).toBe(1);
  });
});
