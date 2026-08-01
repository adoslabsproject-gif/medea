/**
 * Batch send scheduler — pure orchestration.
 *
 * Splits responsibility from the executor for two reasons:
 *
 *  1. The throttling math (delay between sends, backoff window after a
 *     429, retry budget) is non-trivial and benefits from unit tests
 *     with a fake clock — not from running 100 SMTP sends in a vitest.
 *  2. The same scheduler is the loop body for `email_send_tracked_batch`
 *     AND can be reused by future scheduled-broadcast workflows.
 *
 * Pattern note
 * ────────────
 * We pace by **steady-state interval**, not "burst then sleep".
 * Gmail's per-account rate limit is a 60-second rolling window;
 * sending 60 in 5 seconds then idling fails the window check the
 * SECOND minute. Steady cadence with a small jitter (±20% by default)
 * stays under any provider's watermark.
 *
 * @module actions/email_send_tracked_batch/scheduler
 */

export interface BatchItem {
  /** Index in the input array — preserved in the result for caller-side rejoin. */
  index: number;
  /** Per-recipient overrides merged with the batch-wide config. */
  overrides: Record<string, unknown>;
}

export interface BatchResult {
  index: number;
  ok: boolean;
  messageId?: string;
  sendId?: string;
  error?: string;
  /** Did this attempt land in the retry queue? */
  requeued?: boolean;
  /** Number of attempts spent (1..maxAttempts). */
  attempts: number;
}

export interface BatchStats {
  sent: number;
  failed: number;
  retried: number;
  totalMs: number;
  effectiveRatePerHour: number;
}

export interface SchedulerOptions {
  /** Items to process, in the order the caller provided. */
  items: BatchItem[];
  /** Target rate as an UPPER bound. Default 60 = one per minute. */
  ratePerHour: number;
  /** Random jitter applied to each delay (0…1 fraction). Default 0.2 = ±20%. */
  jitter?: number;
  /** Per-item attempt budget (initial + retries). Default 3. */
  maxAttempts?: number;
  /**
   * Backoff base in ms applied between attempts of the same item. The
   * actual delay is `backoffBaseMs * 2^(attempt-1)` capped at 60s.
   * Default 5_000 (5s base → 5, 10, 20).
   */
  backoffBaseMs?: number;
  /**
   * Total budget in ms. When exceeded the scheduler returns immediately
   * with whatever it has — remaining items get `requeued=true`. Default:
   * (items.length / ratePerHour) * 3600_000 * 2 (≈ 2x the ideal time).
   */
  budgetMs?: number;
  /**
   * Caller-supplied attempt function. Return:
   *   - { ok: true, messageId, sendId } on success
   *   - { ok: false, retry: true, error } to retry within maxAttempts
   *   - { ok: false, retry: false, error } to give up immediately
   *
   * Must be IDEMPOTENT under retry — typically backed by a sendId
   * generated upstream.
   */
  attempt: (item: BatchItem, attemptIndex: number) => Promise<AttemptResult>;
  /** Sleep function — injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source — injectable for tests. */
  random?: () => number;
  /** Clock — injectable for tests. */
  now?: () => number;
  /** AbortSignal. When aborted we stop after the in-flight item completes. */
  signal?: AbortSignal;
}

export type AttemptResult =
  | { ok: true; messageId: string; sendId: string }
  | { ok: false; retry: boolean; error: string };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runBatch(opts: SchedulerOptions): Promise<{ stats: BatchStats; results: BatchResult[] }> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const jitter = clamp(opts.jitter ?? 0.2, 0, 0.95);
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
  const backoffBaseMs = Math.max(500, opts.backoffBaseMs ?? 5_000);
  const ratePerHour = Math.max(1, Math.floor(opts.ratePerHour));
  // Steady-state interval between sends. ratePerHour=60 → 60_000ms = 1/min.
  const baseIntervalMs = Math.floor(3_600_000 / ratePerHour);
  // Budget: by default give us ~2x the ideal "everything sends first try"
  // time. Caller can tighten or loosen.
  const idealMs = Math.ceil(baseIntervalMs * opts.items.length);
  const budgetMs = Math.max(1_000, opts.budgetMs ?? idealMs * 2);

  const startTs = now();
  const results: BatchResult[] = [];
  let sent = 0;
  let failed = 0;
  let retried = 0;

  for (let i = 0; i < opts.items.length; i++) {
    if (opts.signal?.aborted) {
      // Remaining items + this one are requeued.
      for (let k = i; k < opts.items.length; k++) {
        results.push({ index: opts.items[k]!.index, ok: false, requeued: true, attempts: 0, error: 'aborted' });
      }
      break;
    }
    if (now() - startTs > budgetMs) {
      for (let k = i; k < opts.items.length; k++) {
        results.push({ index: opts.items[k]!.index, ok: false, requeued: true, attempts: 0, error: 'budget-exceeded' });
      }
      break;
    }

    const item = opts.items[i]!;
    const r = await attemptWithRetries(item, opts.attempt, maxAttempts, backoffBaseMs, sleep, opts.signal);
    results.push(r);
    if (r.ok) sent += 1;
    else failed += 1;
    if (r.attempts > 1 && r.ok) retried += 1;

    // Pace before the NEXT item (not after the last).
    if (i < opts.items.length - 1) {
      const jittered = applyJitter(baseIntervalMs, jitter, random);
      await sleep(jittered);
    }
  }

  const totalMs = now() - startTs;
  const effectiveRatePerHour = totalMs > 0
    ? Math.round((sent / totalMs) * 3_600_000)
    : 0;

  return {
    stats: { sent, failed, retried, totalMs, effectiveRatePerHour },
    results,
  };
}

async function attemptWithRetries(
  item: BatchItem,
  attempt: SchedulerOptions['attempt'],
  maxAttempts: number,
  backoffBaseMs: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<BatchResult> {
  let lastError = '';
  for (let a = 1; a <= maxAttempts; a++) {
    if (signal?.aborted) return { index: item.index, ok: false, attempts: a - 1, requeued: true, error: 'aborted' };
    let res: AttemptResult;
    try {
      res = await attempt(item, a);
    } catch (err) {
      res = { ok: false, retry: true, error: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) {
      return { index: item.index, ok: true, messageId: res.messageId, sendId: res.sendId, attempts: a };
    }
    lastError = res.error;
    if (!res.retry || a === maxAttempts) {
      return { index: item.index, ok: false, attempts: a, error: lastError };
    }
    // Exponential backoff capped at 60s.
    const back = Math.min(60_000, backoffBaseMs * (2 ** (a - 1)));
    await sleep(back);
  }
  return { index: item.index, ok: false, attempts: maxAttempts, error: lastError };
}

function applyJitter(baseMs: number, jitter: number, rnd: () => number): number {
  if (jitter <= 0) return baseMs;
  const span = baseMs * jitter;     // ± span
  const delta = (rnd() * 2 - 1) * span;
  return Math.max(0, Math.floor(baseMs + delta));
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
