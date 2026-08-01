/**
 * Workflow execution analytics dashboard endpoints.
 *  - GET /api/v1/analytics/summary       overall counts + p95 latency over 24h
 *  - GET /api/v1/analytics/runs-per-day  histogram for the last 30 days
 *  - GET /api/v1/analytics/error-top     top 10 workflows by error count
 *  - GET /api/v1/analytics/duration      latency distribution buckets
 */

import { Hono } from 'hono';
import { getDatabase } from '@/storage/db.js';
import { getTenantId } from '@/lib/tenant.js';

export function createAnalyticsRoutes(): Hono {
  const app = new Hono();

  app.get('/analytics/summary', (c) => {
    const tenantId = getTenantId(c);
    const { sqlite } = getDatabase();
    const since24 = new Date(Date.now() - 86_400_000).toISOString();
    // COALESCE su SUM/AVG: SQLite ritorna NULL su set vuoto. Senza COALESCE,
    // il frontend riceve null e crasha al .toLocaleString() (bug user 2026-05-31).
    const totals = sqlite
      .prepare(
        `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error_count,
          COALESCE(AVG(total_duration_ms), 0) as avg_duration_ms
        FROM runs WHERE tenant_id = ? AND started_at >= ?`,
      )
      .get(tenantId, since24) as { total: number; success_count: number; error_count: number; avg_duration_ms: number };

    const durations = sqlite
      .prepare(`SELECT total_duration_ms FROM runs WHERE tenant_id = ? AND started_at >= ? AND total_duration_ms IS NOT NULL ORDER BY total_duration_ms`)
      .all(tenantId, since24) as { total_duration_ms: number }[];
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[p95Index]?.total_duration_ms ?? 0;

    const workflowsCount = (sqlite
      .prepare('SELECT COUNT(*) as c FROM workflows WHERE tenant_id = ?')
      .get(tenantId) as { c: number }).c;
    const enabledCount = (sqlite
      .prepare('SELECT COUNT(*) as c FROM workflows WHERE tenant_id = ? AND enabled = 1')
      .get(tenantId) as { c: number }).c;

    // Defensive Number(): la riga SQLite arriva via better-sqlite3 con tipi a
    // volte sorprendenti (BigInt | string per certi driver), e i vecchi container
    // pre-COALESCE potrebbero ancora avere null in cache. Number(null|undefined)=NaN
    // ma ?? 0 lo blocca.
    const totalCount = Number(totals.total ?? 0);
    const successCount = Number(totals.success_count ?? 0);
    const errorCount = Number(totals.error_count ?? 0);
    const avgMs = Number(totals.avg_duration_ms ?? 0);
    return c.json({
      window: '24h',
      runs: {
        total: totalCount,
        success: successCount,
        error: errorCount,
        successRate: totalCount > 0 ? successCount / totalCount : 0,
        avgDurationMs: avgMs,
        p95DurationMs: p95,
      },
      workflows: { total: workflowsCount, enabled: enabledCount },
    });
  });

  app.get('/analytics/runs-per-day', (c) => {
    const tenantId = getTenantId(c);
    // Number('invalid') = NaN → propaga in new Date(NaN) → throw 500.
    // Fallback a 30 (default) per input non parseable.
    const daysRaw = Number(c.req.query('days') ?? 30);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
    const { sqlite } = getDatabase();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = sqlite
      .prepare(
        `SELECT substr(started_at, 1, 10) as day,
                COUNT(*) as total,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
         FROM runs WHERE tenant_id = ? AND started_at >= ?
         GROUP BY day ORDER BY day`,
      )
      .all(tenantId, since) as { day: string; total: number; errors: number }[];
    return c.json({ days: rows });
  });

  app.get('/analytics/error-top', (c) => {
    const tenantId = getTenantId(c);
    const { sqlite } = getDatabase();
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = sqlite
      .prepare(
        `SELECT workflow_id,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                COUNT(*) as total
         FROM runs WHERE tenant_id = ? AND started_at >= ?
         GROUP BY workflow_id ORDER BY error_count DESC LIMIT 10`,
      )
      .all(tenantId, since) as { workflow_id: string; error_count: number; total: number }[];
    return c.json({ topErrors: rows });
  });

  app.get('/analytics/duration', (c) => {
    const tenantId = getTenantId(c);
    const { sqlite } = getDatabase();
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const buckets = [10, 50, 100, 500, 1000, 5000, 30_000, Infinity];
    const counts: number[] = new Array(buckets.length).fill(0) as number[];
    const rows = sqlite
      .prepare(`SELECT total_duration_ms FROM runs WHERE tenant_id = ? AND started_at >= ? AND total_duration_ms IS NOT NULL`)
      .all(tenantId, since) as { total_duration_ms: number }[];
    for (const r of rows) {
      for (let i = 0; i < buckets.length; i += 1) {
        if (r.total_duration_ms < (buckets[i] ?? Infinity)) {
          counts[i] = (counts[i] ?? 0) + 1;
          break;
        }
      }
    }
    return c.json({
      buckets: buckets.map((b, i) => ({ ltMs: b === Infinity ? null : b, count: counts[i] ?? 0 })),
      total: rows.length,
    });
  });

  return app;
}
