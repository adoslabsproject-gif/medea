/**
 * Prometheus-format metrics endpoint at GET /metrics.
 *
 * SECURITY (hardening 2026-05-23):
 *   • Protetto da bearer token via `MEDEA_METRICS_TOKEN` env var.
 *   • Se la env è VUOTA, l'endpoint è chiuso (403). Per scrapare, settare:
 *       MEDEA_METRICS_TOKEN=<random-32+chars>
 *     in /etc/flowforge.env e configurare il Prometheus job con
 *       authorization: { type: Bearer, credentials: <token> }
 *   • Anche con token corretto, raccomandato comunque restringere via
 *     nginx allowlist all'IP del server Prometheus (defense in depth).
 *
 * Prima di questo fix, /metrics era pubblico — chiunque su Internet
 * poteva leggere workflow_count, runs_total, runs_error, uptime, memoria.
 * Info aggregate, no PII, ma rivelano pattern di uso aziendale (load
 * patterns, orari di picco, churn rate). Per un prodotto enterprise
 * questa è informazione che deve stare dietro a un layer di accesso.
 */

import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { runs, workflows, auditLog } from '@/storage/schema.js';
import { renderPrometheus } from '@/lib/metrics-store.js';

function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function createMetricsRoutes(): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  app.get('/metrics', async (c) => {
    // Auth gate: bearer token deve combaciare con MEDEA_METRICS_TOKEN.
    // Se la env è vuota, endpoint chiuso (403) — fail-closed by design.
    const expected = process.env.MEDEA_METRICS_TOKEN ?? '';
    if (!expected) {
      return c.text('Metrics endpoint disabled: set MEDEA_METRICS_TOKEN env var to enable scraping.', 403);
    }
    const header = c.req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!tokenOk(provided, expected)) {
      return c.text('Forbidden', 403);
    }
    const { db } = getDatabase();

    const [workflowsCount] = await db.select({ c: sql<number>`count(*)` }).from(workflows);
    const [enabledCount] = await db.select({ c: sql<number>`count(*)` }).from(workflows).where(eq(workflows.enabled, true));
    const [runsTotal] = await db.select({ c: sql<number>`count(*)` }).from(runs);
    const [runsError] = await db.select({ c: sql<number>`count(*)` }).from(runs).where(eq(runs.status, 'error'));
    const [runs24h] = await db
      .select({ c: sql<number>`count(*)` })
      .from(runs)
      .where(sql`${runs.startedAt} > datetime('now', '-1 day')`);
    const [auditTotal] = await db.select({ c: sql<number>`count(*)` }).from(auditLog);

    const mem = process.memoryUsage();
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);

    const lines = [
      '# HELP flowforge_workflows_total Total number of workflows',
      '# TYPE flowforge_workflows_total gauge',
      `flowforge_workflows_total ${(workflowsCount?.c ?? 0).toString()}`,
      '# HELP flowforge_workflows_enabled Number of enabled workflows',
      '# TYPE flowforge_workflows_enabled gauge',
      `flowforge_workflows_enabled ${(enabledCount?.c ?? 0).toString()}`,
      '# HELP flowforge_runs_total Total workflow runs (lifetime)',
      '# TYPE flowforge_runs_total counter',
      `flowforge_runs_total ${(runsTotal?.c ?? 0).toString()}`,
      '# HELP flowforge_runs_error_total Total failed workflow runs',
      '# TYPE flowforge_runs_error_total counter',
      `flowforge_runs_error_total ${(runsError?.c ?? 0).toString()}`,
      '# HELP flowforge_runs_24h Workflow runs in the last 24 hours',
      '# TYPE flowforge_runs_24h gauge',
      `flowforge_runs_24h ${(runs24h?.c ?? 0).toString()}`,
      '# HELP flowforge_audit_entries_total Total audit log entries',
      '# TYPE flowforge_audit_entries_total counter',
      `flowforge_audit_entries_total ${(auditTotal?.c ?? 0).toString()}`,
      '# HELP flowforge_process_memory_rss_bytes Resident set size of the runtime process',
      '# TYPE flowforge_process_memory_rss_bytes gauge',
      `flowforge_process_memory_rss_bytes ${mem.rss.toString()}`,
      '# HELP flowforge_process_memory_heap_used_bytes V8 heap used',
      '# TYPE flowforge_process_memory_heap_used_bytes gauge',
      `flowforge_process_memory_heap_used_bytes ${mem.heapUsed.toString()}`,
      '# HELP flowforge_uptime_seconds Uptime in seconds',
      '# TYPE flowforge_uptime_seconds counter',
      `flowforge_uptime_seconds ${uptimeSec.toString()}`,
    ];

    // Append the live metrics store (counters/histograms emitted by AI
    // endpoints, rate-limit middleware, etc.)
    const dynamicMetrics = renderPrometheus();

    return new Response(`${lines.join('\n')}\n${dynamicMetrics ? `${dynamicMetrics}\n` : ''}`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  });

  return app;
}
