/**
 * Exponential-backoff retry wrapper per LLM call dell'AI Scaffold.
 *
 * Retries SOLO su transient upstream failure (429/502/503/504/network).
 * 4xx-other e 401/403 fail fast — non ha senso ritentare auth/quota.
 *
 * Budget default 4 attempts ≈ 11s worst case (0.75 + 1.5 + 3 + 6 con
 * fino al 30% jitter ognuno). Oltre, l'errore bubble up al caller (agent
 * loop) che gestisce il graceful failure.
 *
 * Estratto da ai-scaffold.service.ts in Phase 2 refactor.
 */
import { logger } from '@/lib/logger.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export async function callLlmWithRetry(
  fn: () => Promise<string>,
  opts: RetryOptions,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const m = /\b(429|5\d\d)\b/.exec(msg);
      const isTransient =
        /\b(429|502|503|504|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network)\b/i.test(msg);
      // 401/403/4xx-other are NOT retried.
      if (!isTransient || /\b40[134]\b/.test(msg)) throw e;
      if (attempt === opts.maxAttempts - 1) break;
      const code = m?.[1] ?? 'transient';
      const delay = Math.floor(opts.baseDelayMs * Math.pow(2, attempt) * (1 + Math.random() * 0.3));
      logger.warn(
        { attempt: attempt + 1, max: opts.maxAttempts, delayMs: delay, code },
        'AiScaffold LLM transient error — retrying',
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
