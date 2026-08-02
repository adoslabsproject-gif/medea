/**
 * Rate-limit del fan-out error-workflow (AUDIT WE-14) — leaky-bucket in-memory
 * per (source workflowId): max N fan-out per 60s per source.
 *
 * Pre-fix: nessun cap → un workflow che fallisce 1000/sec triggerava 1000/sec di
 * error-handler run = self-DoS. Post-fix: oltre soglia → drop.
 *
 * RELOCATO (2026-06-19) da run.service alla pipeline outbox: ora che il fan-out è
 * DUREVOLE, il cap vive accanto al fanout dispatcher (lo invoca via wiring). Comportamento
 * IDENTICO al precedente (stessa env MEDEA_ERROR_FANOUT_MAX_PER_MIN, default 60).
 *
 * Cleanup: i bucket scaduti (windowStart > 60s fa) vengono GC'ati su accesso → niente
 * memory leak da workflow rimossi.
 */

interface ErrorFanoutBucket {
  count: number;
  windowStart: number;
}

const errorFanoutBuckets = new Map<string, ErrorFanoutBucket>();

export function checkErrorFanoutRateLimit(sourceWorkflowId: string): boolean {
  const max = Number(process.env.MEDEA_ERROR_FANOUT_MAX_PER_MIN ?? '60');
  const windowMs = 60_000;
  const now = Date.now();
  const bucket = errorFanoutBuckets.get(sourceWorkflowId);
  if (!bucket || now - bucket.windowStart > windowMs) {
    errorFanoutBuckets.set(sourceWorkflowId, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count++;
  return true;
}

/** Esposto per i test (nessun cambio di comportamento). */
export const __testHooks__ = { checkErrorFanoutRateLimit, errorFanoutBuckets };
