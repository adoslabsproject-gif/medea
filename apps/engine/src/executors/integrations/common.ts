/**
 * Shared infrastructure for integration executors:
 *   • IntegrationError      — typed error wrapper with `cause` propagation
 *   • withRetry              — exponential-backoff retry around 5xx + network errors
 *   • requireIntegration     — fetch + decrypt + assert presence, throws IntegrationError if missing
 *   • isOAuthExpiringSoon    — true if an OAuth access_token is within 5min of expiry
 *
 * Used by gmail.ts / whatsapp.ts / stripe.ts / google-drive.ts / ocr.ts.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '@/lib/logger.js';
import {
  getIntegration,
  type IntegrationProvider,
  type IntegrationRecord,
} from '@/services/integrations/store.js';

/**
 * Typed error for integration executors. Always carries:
 *   • provider           — which integration failed
 *   • code               — short machine-readable identifier (e.g. 'NOT_CONFIGURED',
 *                          'OAUTH_REFRESH_FAILED', 'API_ERROR', 'INVALID_PAYLOAD')
 *   • cause              — original error if any (e.g. axios/got/Error)
 *   • httpStatus?        — upstream HTTP status when applicable
 *   • retryable?         — hint for engine-side retry policy
 */
export class IntegrationError extends Error {
  readonly provider: IntegrationProvider | 'unknown';
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  // Override Error.cause with a typed accessor (Error.cause is unknown by default).
  declare readonly cause: unknown;

  constructor(args: {
    provider: IntegrationProvider | 'unknown';
    code: string;
    message: string;
    cause?: unknown;
    httpStatus?: number;
    retryable?: boolean;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'IntegrationError';
    this.provider = args.provider;
    this.code = args.code;
    this.httpStatus = args.httpStatus;
    this.retryable = args.retryable ?? false;
  }
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 8000;

/**
 * Retry an async operation with exponential backoff + jitter. Retries on:
 *   • IntegrationError where retryable=true
 *   • Errors whose `code` looks like a transient network error (ETIMEDOUT,
 *     ECONNRESET, EAI_AGAIN, fetch network errors)
 *   • IntegrationError with httpStatus >= 500
 *
 * NEVER retries on 4xx (configuration / permission / payload errors).
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      if (!retryable || attempt === retries) {
        throw err;
      }
      // Exponential backoff: base * 2^attempt with ±25% jitter, capped at max.
      const exp = baseDelayMs * 2 ** attempt;
      const jitter = exp * (0.75 + Math.random() * 0.5);
      const delay = Math.min(Math.round(jitter), maxDelayMs);
      logger.warn(
        { label: opts.label ?? 'withRetry', attempt: attempt + 1, retries, delayMs: delay, err: errMessage(err) },
        'Retrying after transient failure',
      );
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws — but TS needs it.
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof IntegrationError) {
    if (err.retryable) return true;
    if (err.httpStatus !== undefined && err.httpStatus >= 500) return true;
    return false;
  }
  // Plain Error from fetch / undici / network layers
  const msg = errMessage(err).toLowerCase();
  if (msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('eai_again')) return true;
  if (msg.includes('socket hang up') || msg.includes('network')) return true;
  if (msg.includes('fetch failed')) return true;
  return false;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Look up + decrypt a tenant integration; throw a structured error if missing.
 *
 * Why this helper: every executor starts with the same 3-line dance
 * (lookup, null-check, throw with a useful message). Centralized.
 */
export function requireIntegration(args: {
  provider: IntegrationProvider;
  tenantId: string;
  label?: string | null;
}): IntegrationRecord {
  const integration = getIntegration({
    provider: args.provider,
    tenantId: args.tenantId,
    label: args.label ?? null,
  });
  if (!integration) {
    const labelHint = args.label ? ` (label="${args.label}")` : '';
    throw new IntegrationError({
      provider: args.provider,
      code: 'NOT_CONFIGURED',
      message:
        `Integration "${args.provider}"${labelHint} is not configured for this tenant. ` +
        `Connect it from Settings → Integrations before using this node.`,
    });
  }
  return integration;
}

/**
 * True when an OAuth access_token expires within the safety margin (default 5min).
 *
 * Why 5min: typical workflow steps take 1-3s; the token must outlive at least
 * the current network round-trip plus the per-request budget. 5min is the
 * value Google's own client libraries use as the default.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export function isOAuthExpiringSoon(expiresAt: number | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

/**
 * Lazy-require + helpful error if an optional native module is missing.
 *
 * Background: the integration executors are tree-shaken bundled by tsup. When
 * a user upgrades the runtime but skips `pnpm install`, an `import` at the
 * top of an executor would crash the WHOLE registry on first node load.
 * A lazy require defers the crash to the first call to that executor and
 * lets us print a useful "run pnpm install" message instead of a stack trace.
 */
export async function lazyRequire<T>(modulePath: string, friendlyName: string, provider: IntegrationProvider): Promise<T> {
  try {
    const mod = (await import(modulePath)) as T;
    return mod;
  } catch (err) {
    throw new IntegrationError({
      provider,
      code: 'MODULE_NOT_INSTALLED',
      message:
        `Required module "${friendlyName}" is not installed for the ${provider} executor. ` +
        `Run "pnpm install" in the FlowForge runtime (or pin a wheel for on-prem) and restart.`,
      cause: err,
    });
  }
}
