/**
 * In-process sliding-window rate limit middleware for Hono routes.
 *
 * Purpose: every endpoint that triggers an LLM call costs real money. A
 * malicious or buggy client can rack up thousands of calls in minutes. This
 * middleware caps invocations per (tenant, user) sliding window.
 *
 * Algorithm: fixed-window with O(1) memory per (key, window-bucket). Each key
 * has a Map<bucketStart, count>; we keep at most 2 buckets (current + prev)
 * and approximate the sliding window using the standard
 * "weighted prev + current" formula:
 *
 *     effective_count ≈ prev_count * fraction_of_prev_window_remaining + current_count
 *
 * This is the same algorithm Cloudflare uses for their L7 rate limit. It's
 * less accurate than a true sliding-window log (which would store every
 * timestamp), but uses constant memory and works without Redis.
 *
 * For multi-worker deployments, swap the in-memory store with a Redis-backed
 * implementation (atomic INCR + EXPIRE per bucket). The middleware shape is
 * unchanged — callers just pass a different `store` adapter.
 *
 * Why this exists: a senior reviewer's first question about any LLM endpoint
 * is "how do you stop a $1000 bill from one rogue script?". This is the
 * answer. NOT optional.
 */

import type { Context, Next } from 'hono';
import { counterInc } from '@/lib/metrics-store.js';

export interface RateLimitOptions {
  /** Window size in milliseconds. */
  windowMs: number;
  /** Max requests per window per tenant (across all users). */
  perTenant?: number;
  /** Max requests per window per (tenant, user) pair. Stricter than perTenant. */
  perUser?: number;
  /**
   * Override how we identify the tenant. Default: read `X-Tenant-Id` header
   * or `default`. Customize if your tenant identification lives elsewhere.
   */
  tenantFrom?: (c: Context) => string;
  /** Override how we identify the user. Default: `X-User-Id` header or 'anon'. */
  userFrom?: (c: Context) => string;
  /** Friendly label for logs and error messages (e.g. "ai-assistant"). */
  label: string;
}

interface WindowBucket {
  count: number;
  start: number; // ms timestamp of bucket start
}

interface KeyState {
  prev: WindowBucket;
  current: WindowBucket;
}

/**
 * In-memory store. Single process. For multi-worker, replace with Redis.
 * Module-level singleton so concurrent middleware instances share counters
 * (which is what you want for "30 req/min per tenant").
 */
const STATE = new Map<string, KeyState>();

function nowBucketStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function incrementAndScore(key: string, windowMs: number, now: number): number {
  const bucketStart = nowBucketStart(now, windowMs);
  const existing = STATE.get(key);

  if (!existing) {
    STATE.set(key, {
      prev: { count: 0, start: bucketStart - windowMs },
      current: { count: 1, start: bucketStart },
    });
    return 1;
  }

  // Advance windows: if current bucket is in the past, slide forward.
  if (existing.current.start !== bucketStart) {
    if (existing.current.start === bucketStart - windowMs) {
      // shift by one
      existing.prev = existing.current;
    } else {
      // gap > 1 window, both are stale
      existing.prev = { count: 0, start: bucketStart - windowMs };
    }
    existing.current = { count: 0, start: bucketStart };
  }

  existing.current.count += 1;

  // Weighted prev contribution = how much of the prev window still overlaps
  // the trailing window (the last `windowMs` ms). When now is at bucketStart,
  // 100% of prev contributes; when now is at bucketStart + windowMs, 0%.
  const elapsedInCurrent = now - existing.current.start;
  const prevWeight = Math.max(0, 1 - elapsedInCurrent / windowMs);
  return existing.prev.count * prevWeight + existing.current.count;
}

/**
 * Periodic GC of stale keys — kept simple: every minute, sweep entries whose
 * current.start is more than 2 windows behind. Prevents unbounded memory
 * growth from tenants who hit the endpoint once and disappear.
 */
const GC_INTERVAL_MS = 60_000;
const gcTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, st] of STATE) {
    const ageMs = now - st.current.start;
    if (ageMs > 5 * 60_000) STATE.delete(key);
  }
}, GC_INTERVAL_MS);
gcTimer.unref();

/**
 * Create the Hono middleware. Apply with `app.use(rateLimit({ ... }))` or
 * scoped to a specific route group.
 *
 * Returns 429 Too Many Requests with a structured JSON body when exceeded.
 */
export function rateLimit(
  opts: RateLimitOptions,
): (c: Context, next: Next) => Promise<Response | void> {
  const windowMs = opts.windowMs;
  const perTenant = opts.perTenant;
  const perUser = opts.perUser;
  // HIGH (2026-05-29): identity source HARDENING.
  //
  // Pre-fix: leggere `x-tenant-id` / `x-user-id` da header significa che il
  // CLIENT decide il proprio bucket. Un attaccante puo\` mandare un header
  // diverso ad ogni request e ottenere quote illimitate (bypass rate-limit
  // su LLM gateway = costo a noi).
  //
  // Fix: identity preferenzialmente dal contesto `auth` (settato dal
  // middleware di authn DOPO verifica JWE/cookie). Solo se l'opts dichiara
  // esplicitamente `userFrom`/`tenantFrom` (override esplicito controllato)
  // accettiamo. Niente fallback su header.
  const tenantFrom =
    opts.tenantFrom ??
    ((c: Context) => {
      const auth = c.get('auth') as { tenantId?: string } | undefined;
      return auth?.tenantId ?? 'default';
    });
  const userFrom =
    opts.userFrom ??
    ((c: Context) => {
      const auth = c.get('auth') as { userId?: string; sub?: string } | undefined;
      return auth?.userId ?? auth?.sub ?? 'anon';
    });

  return async (c, next) => {
    const tenant = tenantFrom(c);
    const user = userFrom(c);
    const now = Date.now();

    // Tenant-level check (broader bucket — applies to all users of the tenant)
    if (perTenant !== undefined) {
      const score = incrementAndScore(`${opts.label}:tenant:${tenant}`, windowMs, now);
      if (score > perTenant) {
        counterInc({
          name: 'flowforge_rate_limit_exceeded_total',
          help: 'Rate limit exceeded events by label + scope',
          tags: { label: opts.label, scope: 'tenant' },
        });
        return c.json(
          {
            error: 'rate_limit_exceeded',
            scope: 'tenant',
            message: `Troppe richieste per il tenant. Limite ${perTenant.toString()}/${(windowMs / 1000).toFixed(0)}s. Riprova tra poco.`,
            retryAfterSeconds: Math.ceil(windowMs / 1000),
          },
          429,
        );
      }
    }

    // User-level check (stricter — per single user within the tenant)
    if (perUser !== undefined) {
      const score = incrementAndScore(`${opts.label}:user:${tenant}:${user}`, windowMs, now);
      if (score > perUser) {
        counterInc({
          name: 'flowforge_rate_limit_exceeded_total',
          help: 'Rate limit exceeded events by label + scope',
          tags: { label: opts.label, scope: 'user' },
        });
        return c.json(
          {
            error: 'rate_limit_exceeded',
            scope: 'user',
            message: `Troppe richieste per il tuo account. Limite ${perUser.toString()}/${(windowMs / 1000).toFixed(0)}s. Riprova tra poco.`,
            retryAfterSeconds: Math.ceil(windowMs / 1000),
          },
          429,
        );
      }
    }

    await next();
  };
}

/**
 * Standard preset for LLM-spending endpoints. Calibrated as a starting point:
 * - 30 req/min per tenant (1 req/2s sustained — covers normal usage)
 * - 10 req/min per user   (1 req/6s — prevents single-user denial-of-budget)
 *
 * Tighten if your LLM costs are high (Anthropic Opus). Loosen for cheap
 * providers (Liara/Ollama free).
 */
export function llmRateLimit(label: string): (c: Context, next: Next) => Promise<Response | void> {
  return rateLimit({
    windowMs: 60_000,
    perTenant: 30,
    perUser: 10,
    label,
  });
}

/** Hard-reset all counters — exposed for tests. */
export function _resetRateLimitState(): void {
  STATE.clear();
}
