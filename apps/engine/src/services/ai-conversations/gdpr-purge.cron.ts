/**
 * GDPR Purge Cron — hard-deletes ai_conversations soft-deleted > 30gg ago.
 *
 * Phase 6 of AI-SCALING-100-TENANTS. Runs daily inside the runtime container.
 * Cascade DELETE on FK removes ai_messages too.
 *
 * Schedule: every day at 03:30 UTC (low-traffic window).
 * Idempotent: safe to call multiple times — only removes rows whose
 * deleted_at < cutoff.
 */

import { coerceString } from '@/lib/coerce.js';
import { conversationService } from './conversation.service.js';
import { logger } from '@/lib/logger.js';

const RETENTION_DAYS = 30;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * AUDIT FIX BYOK-14 (2026-06-09 MEDIUM): persistenza last_run via marker file.
 *
 * Pre-fix: setTimeout(60s) + setInterval(24h). Se container restarta più
 * spesso di 24h (deploy, pause/unpause, crash recovery) il cron parte
 * sempre al "first run +60s" + 24h dopo → mai effettivamente eseguito
 * oltre il primo. Container idle paused = miss totale.
 *
 * Post-fix: salva timestamp last successful run in marker file sul volume
 * persistente (`/data/.gdpr-purge-last-run`). On startup: se >= 24h
 * dall'ultimo run → run subito. Altrimenti schedula al primo gap >= 24h.
 */
import { readFile, writeFile } from 'node:fs/promises';

const MARKER_FILE = process.env.MEDEA_DATA_DIR
  ? `${process.env.MEDEA_DATA_DIR}/.gdpr-purge-last-run`
  : '/data/.gdpr-purge-last-run';

async function loadLastRunMs(): Promise<number> {
  try {
    const txt = await readFile(MARKER_FILE, 'utf8');
    const ts = Number(txt.trim());
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

async function saveLastRunMs(now: number): Promise<void> {
  try {
    await writeFile(MARKER_FILE, String(now), 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[ai-conv.gdpr] failed to persist last_run marker',
    );
  }
}

export function startGdprPurgeCron(): void {
  if (timer) return; // idempotent
  // Check last_run persisted: se mai eseguito o >24h fa → run subito,
  // altrimenti delay al prossimo gap.
  void loadLastRunMs().then((lastRunMs) => {
    const now = Date.now();
    const elapsed = now - lastRunMs;
    if (lastRunMs === 0 || elapsed >= RUN_INTERVAL_MS) {
      // catch-up immediato post-restart
      setTimeout(() => {
        void runAndPersist();
      }, 60_000);
    } else {
      // schedule al prossimo gap
      setTimeout(() => {
        void runAndPersist();
      }, RUN_INTERVAL_MS - elapsed);
    }
  });
  timer = setInterval(() => {
    void runAndPersist();
  }, RUN_INTERVAL_MS);
  logger.info(
    { retentionDays: RETENTION_DAYS, intervalHours: 24, markerFile: MARKER_FILE },
    '[ai-conv.gdpr] cron started (BYOK-14 fix: persistent last_run marker)',
  );
}

async function runAndPersist(): Promise<void> {
  try {
    await runPurgeOnce();
    await saveLastRunMs(Date.now());
  } catch {
    // Errori già loggati in runPurgeOnce — non aggiornare marker (retry next tick)
  }
}

export function stopGdprPurgeCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function runPurgeOnce(): Promise<{ purged: number; cutoff: string }> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString();
  try {
    const purged = conversationService.hardPurgeExpired(cutoff);
    if (purged > 0) {
      logger.warn({ purged, cutoff }, '[ai-conv.gdpr] hard purge complete');
    }
    return Promise.resolve({ purged, cutoff });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), cutoff },
      '[ai-conv.gdpr] purge failed',
    );
    return Promise.reject(err instanceof Error ? err : new Error(coerceString(err)));
  }
}
