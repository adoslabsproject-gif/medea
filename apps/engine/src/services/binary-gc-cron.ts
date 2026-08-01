/**
 * Cron orario: GC dei blob binari orfani del BinaryStore (GAP 2, residuo A#1).
 *
 * Ogni ora: collect live-refs da SQLite → `BinaryStore.gc()` (con grace 24h
 * sui blob giovani) → `sweepStaleTemp()` dei temp/staging da crash. Senza
 * questo cron i blob de-referenziati (run archiviate/cancellate) si accumulano
 * sul loop ext4 del tenant fino all'ENOSPC.
 *
 * Schedule: ogni 60 min, primo fire ~15 min dopo il boot jitterato di ±5 min
 * per non far convergere tutti i container tenant allo stesso secondo.
 * Idempotente: doppia `startBinaryGcCron()` non duplica il timer (pattern
 * allineato a `runs-archive-cron`).
 */
import { runBinaryGcOnce } from './binary-gc.service.js';
import { logger } from '@/lib/logger.js';

const HOUR_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let firstFireTimer: ReturnType<typeof setTimeout> | null = null;

async function runOnce(): Promise<void> {
  try {
    const res = await runBinaryGcOnce();
    if (res.deleted > 0 || res.tempDeleted > 0) {
      logger.info?.(res, '[binary-gc-cron] blob orfani rimossi');
    } else {
      logger.debug?.(res, '[binary-gc-cron] niente da rimuovere');
    }
  } catch (e) {
    logger.warn?.({ err: e }, '[binary-gc-cron] cycle failed');
  }
}

export function startBinaryGcCron(): void {
  if (timer) return;
  // Jitter ±5 min sul primo run per anti-convergence multi-tenant.
  const jitterMs = Math.floor((Math.random() - 0.5) * 10 * 60 * 1000);
  const firstFire = 15 * 60 * 1000 + jitterMs; // 15min nominal ± 5min
  firstFireTimer = setTimeout(() => { void runOnce(); }, firstFire);
  firstFireTimer.unref?.();
  timer = setInterval(() => { void runOnce(); }, HOUR_MS);
  timer.unref?.();
  logger.info?.({ firstFireMs: firstFire }, 'binary-gc-cron started');
}

export function stopBinaryGcCron(): void {
  // Il first-fire pendente va cancellato ANCHE lui: start→stop→start senza
  // questo accoderebbe due first-fire (l'idempotenza guarda solo `timer`).
  if (firstFireTimer) {
    clearTimeout(firstFireTimer);
    firstFireTimer = null;
  }
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
