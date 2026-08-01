/**
 * Retry strategy generica — exponential backoff con jitter opzionale.
 *
 * Engine ha gia\` retry policy in NodeExecutorStrategy ma a livello ESECUTORE
 * (intera invocazione). Questo helper e\` per retry INTERNI ad un executor:
 * es. http.ts ritenta sulla singola request prima di considerare l'intera
 * pagination un fallimento.
 *
 * shouldRetry callback: il caller decide se l'errore (o il valore non-error)
 * meritano retry. Default `() => true` (retry su qualunque throw).
 */

import { sleep } from './sleep.js';

export interface RetryOptions<T> {
  /** N° di retry AGGIUNTIVI (0 = no retry, solo 1 attempt). Default 0. */
  count?: number;
  /** Delay iniziale ms. Default 500. */
  initialDelayMs?: number;
  /** Fattore exponential (delay × factor^(attempt-1)). Default 2. */
  factor?: number;
  /** Max delay cap (ms). Default 30000 (30s). */
  maxDelayMs?: number;
  /** Jitter ±0..1 (0 = nessuno, 1 = ±100%). Default 0. */
  jitter?: number;
  /** Predicate su error → retry yes/no. Default: retry su throw. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Predicate su success value → retry yes/no (es. status 429). Default no. */
  shouldRetryOnResult?: (value: T, attempt: number) => boolean;
  /** Abort signal — interrompe lo sleep tra retry. */
  signal?: AbortSignal;
  /** Hook chiamato a ogni retry. Util per logging/telemetry. */
  onRetry?: (info: { attempt: number; delay: number; err?: unknown; result?: T }) => void;
}

/**
 * Run an async op with retry. Throws the last error if all retries exhausted.
 */
export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions<T> = {}): Promise<T> {
  const count = Math.max(0, opts.count ?? 0);
  const initial = Math.max(0, opts.initialDelayMs ?? 500);
  const factor = Math.max(1, opts.factor ?? 2);
  const max = Math.max(initial, opts.maxDelayMs ?? 30_000);
  const jitter = Math.max(0, Math.min(1, opts.jitter ?? 0));
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let attempt = 0;
  let lastError: unknown = null;
  while (attempt <= count) {
    try {
      const result = await op();
      if (opts.shouldRetryOnResult && attempt < count && opts.shouldRetryOnResult(result, attempt + 1)) {
        const delay = computeDelay(initial, factor, attempt, max, jitter);
        opts.onRetry?.({ attempt: attempt + 1, delay, result });
        await sleep(delay, opts.signal);
        attempt += 1;
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt >= count || !shouldRetry(err, attempt + 1)) {
        throw err;
      }
      const delay = computeDelay(initial, factor, attempt, max, jitter);
      opts.onRetry?.({ attempt: attempt + 1, delay, err });
      await sleep(delay, opts.signal);
      attempt += 1;
    }
  }
  // Defensive — should be unreachable since we throw or return inside the loop.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Compute delay con cap + optional jitter. Esportata per test. */
export function computeDelay(initial: number, factor: number, attempt: number, max: number, jitter: number): number {
  const base = Math.min(max, initial * Math.pow(factor, attempt));
  if (jitter === 0) return base;
  const j = (Math.random() * 2 - 1) * jitter * base; // ± jitter%
  return Math.max(0, Math.round(base + j));
}
