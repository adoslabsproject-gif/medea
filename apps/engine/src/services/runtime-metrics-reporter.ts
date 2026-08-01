/**
 * Runtime metrics reporter — calcola p50/p95/p99 + error rate dei `runs`
 * locali (SQLite tenant) e POSTa al portal `/api/v1/internal/runtime-metrics`.
 *
 * Strategy:
 *  - finestra: ultimi 7 giorni rolling (allineato banner SLA portal)
 *  - sampling: SELECT total_duration_ms FROM runs WHERE started_at >= cutoff
 *    AND total_duration_ms IS NOT NULL ORDER BY total_duration_ms ASC
 *  - percentile: ordinato → indice = ceil(N * pct / 100) - 1
 *
 * Cron 10min. Non-blocking. Failure logged senza abort.
 * Cap query: max 50000 rows samplati per evitare spike memoria su tenant
 * super attivi (50k punti → percentile preciso al 0.002%, oltre serve solo
 * a inflate stats senza valore informativo).
 *
 * Auth: X-Internal-Token shared (FLOWFORGE_INTERNAL_TOKEN).
 * Tenant: workspaceId da config.FLOWFORGE_TENANT_ID.
 */

import { loadConfig } from '@/config.js';
import { readTextTruncated } from '@/lib/capped-response.js';
import { logger } from '@/lib/logger.js';
import { getDatabase } from '@/storage/db.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';

const REPORT_INTERVAL_MS = 10 * 60_000;
const WINDOW_DAYS = 7;
const SAMPLE_CAP = 50_000;

interface AggregatedMetrics {
  runsTotal7d: number;
  runsErrored7d: number;
  runsPartial7d: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  latencyMaxMs: number | null;
  lastRunAt: Date | null;
}

/**
 * Compute aggregated metrics dal DB locale. Pure function (testabile in iso).
 *
 * @param sampleAsc durations in ms, sorted asc, no nulls. Vuoto = no runs.
 */
export function computePercentiles(sampleAsc: number[]): {
  p50: number | null; p95: number | null; p99: number | null; max: number | null;
} {
  if (sampleAsc.length === 0) {
    return { p50: null, p95: null, p99: null, max: null };
  }
  const n = sampleAsc.length;
  // Index per percentile (nearest-rank). 1-indexed → -1 per zero-indexed array.
  const idx = (pct: number): number => Math.min(n - 1, Math.max(0, Math.ceil((n * pct) / 100) - 1));
  return {
    p50: sampleAsc[idx(50)] ?? null,
    p95: sampleAsc[idx(95)] ?? null,
    p99: sampleAsc[idx(99)] ?? null,
    max: sampleAsc[n - 1] ?? null,
  };
}

interface CountRow { c: number }
interface DurationRow { d: number }
interface LastRunRow { last: string | null }

function getAggregated(): AggregatedMetrics {
  const { sqlite } = getDatabase();
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  // Count totale runs (status diverso)
  const totalRow = sqlite.prepare(
    'SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?',
  ).get(cutoff) as CountRow | undefined;
  const runsTotal = totalRow?.c ?? 0;

  if (runsTotal === 0) {
    return {
      runsTotal7d: 0,
      runsErrored7d: 0,
      runsPartial7d: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
      latencyP99Ms: null,
      latencyMaxMs: null,
      lastRunAt: null,
    };
  }

  const erroredRow = sqlite.prepare(
    "SELECT COUNT(*) AS c FROM runs WHERE started_at >= ? AND status = 'error'",
  ).get(cutoff) as CountRow | undefined;
  const partialRow = sqlite.prepare(
    "SELECT COUNT(*) AS c FROM runs WHERE started_at >= ? AND status = 'partial'",
  ).get(cutoff) as CountRow | undefined;
  const lastRow = sqlite.prepare(
    'SELECT MAX(started_at) AS last FROM runs WHERE started_at >= ?',
  ).get(cutoff) as LastRunRow | undefined;

  // Sample for percentile (cap 50k)
  const sampleRows = sqlite.prepare(
    `SELECT total_duration_ms AS d FROM runs
     WHERE started_at >= ? AND total_duration_ms IS NOT NULL
     ORDER BY total_duration_ms ASC
     LIMIT ?`,
  ).all(cutoff, SAMPLE_CAP) as DurationRow[];
  const sample = sampleRows.map((r) => r.d);
  const { p50, p95, p99, max } = computePercentiles(sample);

  return {
    runsTotal7d: runsTotal,
    runsErrored7d: erroredRow?.c ?? 0,
    runsPartial7d: partialRow?.c ?? 0,
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    latencyP99Ms: p99,
    latencyMaxMs: max,
    lastRunAt: lastRow?.last ? new Date(lastRow.last) : null,
  };
}

export async function reportOnce(): Promise<void> {
  const cfg = loadConfig();
  const tenantId = cfg.FLOWFORGE_TENANT_ID;
  // 2026-06-06 fix portal-callback-token: il portal valida i webhook interni
  // con il SUO global secret (FLOWFORGE_INTERNAL_TOKEN del portal env), NON
  // con il per-tenant token random generato in onboarding. Pattern shared via
  // env var PORTAL_CALLBACK_TOKEN (vedi memory/project_portal_callback_token_fix.md).
  // Fallback per-tenant solo per dev / unit test.
  const internalToken = getOutboundPortalToken();

  if (!tenantId || !internalToken) {
    logger.debug?.(
      { hasTenantId: !!tenantId, hasInternalToken: !!internalToken },
      'runtime-metrics-reporter skipped (missing env)',
    );
    return;
  }

  const agg = getAggregated();
  const url = `${cfg.FLOWFORGE_PORTAL_URL.replace(/\/$/, '')}/api/v1/internal/runtime-metrics`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': internalToken,
      },
      body: JSON.stringify({
        workspaceId: tenantId,
        runsTotal7d: agg.runsTotal7d,
        runsErrored7d: agg.runsErrored7d,
        runsPartial7d: agg.runsPartial7d,
        latencyP50Ms: agg.latencyP50Ms,
        latencyP95Ms: agg.latencyP95Ms,
        latencyP99Ms: agg.latencyP99Ms,
        latencyMaxMs: agg.latencyMaxMs,
        lastRunAt: agg.lastRunAt?.toISOString() ?? null,
        runtimeVersion: process.env.npm_package_version ?? undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = (await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text;
      logger.warn?.(
        { status: res.status, err: errText.slice(0, 200), tenantId },
        '[runtime-metrics] portal non-2xx',
      );
      return;
    }
    logger.debug?.(
      { tenantId, runsTotal7d: agg.runsTotal7d, p99: agg.latencyP99Ms },
      '[runtime-metrics] reported OK',
    );
  } catch (err) {
    logger.warn?.(
      { err: err instanceof Error ? err.message : String(err), tenantId },
      '[runtime-metrics] report failed',
    );
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start cron. Idempotent — chiamate ripetute non duplicano il timer.
 * Primo report dopo 60s (per evitare contesa col boot di altre cron).
 */
export function startRuntimeMetricsReporter(): void {
  if (timer) return;

  // First report after 60s (let other boot tasks finish first)
  setTimeout(() => { void reportOnce(); }, 60_000).unref?.();

  timer = setInterval(() => { void reportOnce(); }, REPORT_INTERVAL_MS);
  timer.unref?.();

  logger.info?.(
    { intervalMin: REPORT_INTERVAL_MS / 60_000, windowDays: WINDOW_DAYS },
    'runtime-metrics-reporter started',
  );
}

export function stopRuntimeMetricsReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
