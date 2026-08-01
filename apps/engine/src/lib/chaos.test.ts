/**
 * Chaos test fixtures — primitive per simulare guasti transient nelle
 * dipendenze esterne (network, LLM provider, DB adapter).
 *
 * Usato dai test che vogliono verificare resilience (retry, circuit
 * breaker, graceful degradation). Esempio:
 *
 *   import { transientFailure, networkDrop, rateLimitBurst } from './chaos';
 *
 *   it('retries on 502', async () => {
 *     const fetchMock = transientFailure(2, '502 Bad Gateway');
 *     await expect(myService(fetchMock)).resolves.toBeDefined();
 *     expect(fetchMock).toHaveBeenCalledTimes(3);  // 2 fail + 1 success
 *   });
 *
 * Phase 2 refactor — A+ resilience grade. Senza chaos fixtures i test
 * "happy path" non garantiscono comportamento sotto stress reale.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * Wrapper che fallisce le prime N invocazioni con `errorMessage`, poi
 * delega a `realImpl` (default: ritorna stringa "OK"). Simula upstream
 * transient errors come 502/503/504.
 */
export function transientFailure<T>(
  failCount: number,
  errorMessage: string,
  realImpl: () => Promise<T> = (() => Promise.resolve('OK' as T)),
): () => Promise<T> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failCount) throw new Error(errorMessage);
    return realImpl();
  };
}

/**
 * Simula network drop ECONNRESET. Il consumer dovrebbe trattarlo come
 * transient (retry), non come fatal.
 */
export function networkDrop<T = string>(failCount = 1): () => Promise<T> {
  return transientFailure<T>(failCount, 'ECONNRESET: socket hang up');
}

/**
 * Simula rate limit burst (HTTP 429). Il consumer dovrebbe respect
 * Retry-After header o usare exponential backoff.
 */
export function rateLimitBurst<T = string>(failCount = 2): () => Promise<T> {
  return transientFailure<T>(failCount, 'HTTP 429: Too Many Requests');
}

/**
 * Simula auth failure (401/403). Il consumer dovrebbe fail-fast, NO retry.
 * Se il consumer ritenta su 401, è un bug — i test devono catturarlo.
 */
export function authFailure<T = string>(): () => Promise<T> {
  return () => Promise.reject(new Error('HTTP 401: Unauthorized'));
}

/**
 * Simula timeout: la promise pende per `ms` millisecondi prima di
 * risolversi. Combinata con `AbortSignal.timeout()` permette di testare
 * il graceful cancellation.
 */
export function slowResponse<T = string>(ms: number, value: T = 'OK' as T): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ─────────────────────────────────────────────────────────────────────────
// Self-tests: garantiscono che le fixtures stesse facciano quel che dicono
// ─────────────────────────────────────────────────────────────────────────

describe('chaos fixtures', () => {
  it('transientFailure: throws first N times, then succeeds', async () => {
    const fn = transientFailure(2, '502 Bad Gateway', () => Promise.resolve('result'));
    await expect(fn()).rejects.toThrow('502 Bad Gateway');
    await expect(fn()).rejects.toThrow('502 Bad Gateway');
    await expect(fn()).resolves.toBe('result');
    await expect(fn()).resolves.toBe('result');
  });

  it('networkDrop: throws ECONNRESET by default once', async () => {
    const fn = networkDrop();
    await expect(fn()).rejects.toThrow(/ECONNRESET/);
    await expect(fn()).resolves.toBe('OK');
  });

  it('rateLimitBurst: throws 429 N times', async () => {
    const fn = rateLimitBurst(3);
    for (let i = 0; i < 3; i++) await expect(fn()).rejects.toThrow(/429/);
    await expect(fn()).resolves.toBe('OK');
  });

  it('authFailure: ALWAYS throws 401 (no recovery)', async () => {
    const fn = authFailure();
    await expect(fn()).rejects.toThrow(/401/);
    await expect(fn()).rejects.toThrow(/401/);
    await expect(fn()).rejects.toThrow(/401/);
  });

  it('slowResponse: resolves after ms', async () => {
    const start = Date.now();
    const fn = slowResponse(50);
    await fn();
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('integrates with vi.fn() for spy', async () => {
    const inner = vi.fn(() => Promise.resolve('hit'));
    const fn = transientFailure(1, 'fail', inner);
    await fn().catch(() => undefined);
    await fn();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
