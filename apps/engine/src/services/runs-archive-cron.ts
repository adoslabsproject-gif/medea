/**
 * Cron settimanale: archivia runs vecchi → .jsonl.gz HMAC-firmati,
 * libera spazio dal DB attivo. (F3 Cappella 2026-06-07 sera)
 *
 * Schedule: ogni 7 giorni (604800000 ms), jitterato di ±5 minuti al boot
 * per non far convergere TUTTI i container tenant alla stessa secondo.
 *
 * Idempotente: doppia chiamata `startRunsArchiveCron()` non duplica il
 * timer (pattern allineato a `runtime-metrics-reporter`).
 *
 * Threshold di default: 30 giorni. Configurabile via env
 * `FLOWFORGE_RUNS_ARCHIVE_DAYS` per ambienti di test.
 */
import { archiveAllWorkflows } from './runs-archive.service.js';
import { logger } from '@/lib/logger.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

function readRetentionDays(): number {
  const raw = process.env.FLOWFORGE_RUNS_ARCHIVE_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

let timer: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  const retentionDays = readRetentionDays();
  try {
    const res = await archiveAllWorkflows(retentionDays);
    if (res.workflowsArchived > 0) {
      logger.info?.(
        { ...res, retentionDays },
        '[runs-archive-cron] batch completed',
      );
    }
  } catch (e) {
    logger.warn?.({ err: e }, '[runs-archive-cron] cycle failed');
  }
}

export function startRunsArchiveCron(): void {
  if (timer) return;
  // Jitter ±5 min sul primo run per anti-convergence multi-tenant.
  const jitterMs = Math.floor((Math.random() - 0.5) * 10 * 60 * 1000);
  const firstFire = 10 * 60 * 1000 + jitterMs; // 10min nominal ± 5min
  setTimeout(() => { void runOnce(); }, firstFire).unref?.();
  timer = setInterval(() => { void runOnce(); }, WEEK_MS);
  timer.unref?.();
  logger.info?.({ retentionDays: readRetentionDays(), firstFireMs: firstFire },
    'runs-archive-cron started');
}

export function stopRunsArchiveCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
