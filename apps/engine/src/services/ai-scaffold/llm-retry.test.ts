/**
 * Test 2026-grade — callLlmWithRetry (exponential-backoff transient guard).
 *
 * RETRY: 429/5xx/network → exponential backoff.
 * NO RETRY: 401/403/4xx-other → fail fast.
 * BUDGET: maxAttempts cap, ultimo errore re-thrown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { callLlmWithRetry } = await import('./llm-retry.js');

beforeEach(() => { vi.clearAllMocks(); });

describe('🚨 happy path', () => {
  it('🚨 success al primo tentativo → ritorna subito, NO retry', async () => {
    const fn = vi.fn().mockResolvedValueOnce('ok-response');
    const r = await callLlmWithRetry(fn, { maxAttempts: 4, baseDelayMs: 10 });
    expect(r).toBe('ok-response');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

describe('🚨 transient retries', () => {
  it.each(['429 Too Many Requests', '502 Bad Gateway', '503', '504 Gateway Timeout'])(
    '🚨 "%s" → retry attempted', async (errMsg) => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error(errMsg))
        .mockResolvedValueOnce('success');
      const r = await callLlmWithRetry(fn, { maxAttempts: 4, baseDelayMs: 1 });
      expect(r).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'fetch failed', 'network error'])(
    '🚨 network "%s" → retry', async (errMsg) => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error(errMsg))
        .mockResolvedValueOnce('ok');
      const r = await callLlmWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
      expect(r).toBe('ok');
    },
  );

  it('🚨 exhausted maxAttempts → last error re-thrown', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    await expect(callLlmWithRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }))
      .rejects.toThrow(/503/u);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('🚨 logger.warn invocato per ogni retry', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce('ok');
    await callLlmWithRetry(fn, { maxAttempts: 4, baseDelayMs: 1 });
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });
});

describe('🚨 fail-fast on auth/4xx', () => {
  it.each(['401 Unauthorized', '403 Forbidden', '404 Not Found'])(
    '🚨 "%s" → NO retry, throw immediately', async (errMsg) => {
      const fn = vi.fn().mockRejectedValueOnce(new Error(errMsg));
      await expect(callLlmWithRetry(fn, { maxAttempts: 5, baseDelayMs: 1 }))
        .rejects.toThrow(errMsg);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it('🚨 generic 400 → no retry', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('400 Bad Request'));
    await expect(callLlmWithRetry(fn, { maxAttempts: 5, baseDelayMs: 1 }))
      .rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('🚨 errore generico (no status code) → no retry (non match transient)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('Invalid input payload'));
    await expect(callLlmWithRetry(fn, { maxAttempts: 5, baseDelayMs: 1 }))
      .rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('🚨 non-Error throwables', () => {
  it('🚨 throw string → wrap in Error', async () => {
    const fn = vi.fn().mockRejectedValueOnce('plain-string-error');
    await expect(callLlmWithRetry(fn, { maxAttempts: 1, baseDelayMs: 1 }))
      .rejects.toThrow('plain-string-error');
  });
});

describe('🚨 exponential backoff timing', () => {
  it('🚨 ritardo cresce ad ogni attempt (2^N)', async () => {
    // Misura delay totale (con baseDelay piccolo per non rallentare test)
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce('ok');
    const start = Date.now();
    await callLlmWithRetry(fn, { maxAttempts: 4, baseDelayMs: 5 });
    const elapsed = Date.now() - start;
    // base=5, attempt 0→5, 1→10, 2→20 → min ~35ms (con jitter più alto)
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });
});
