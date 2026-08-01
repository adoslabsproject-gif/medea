/**
 * Test 2026-grade — executors/integrations/common.ts (shared infra).
 *
 * 🚨 IntegrationError: provider+code+httpStatus+retryable typed.
 *    Bug = errore generico Error vs IntegrationError → ux confusa, no telemetry.
 *
 * 🚨 withRetry: exponential backoff + jitter, retry ONLY su 5xx + retryable
 *    true + network errors (ETIMEDOUT/ECONNRESET/EAI_AGAIN/fetch failed).
 *    Bug = retry su 4xx → spam API + ban da provider per abuse.
 *
 * 🚨 requireIntegration: NOT_CONFIGURED throw structured message.
 *
 * 🚨 isOAuthExpiringSoon: margin 5 min (Google client default).
 *
 * 🚨 lazyRequire: MODULE_NOT_INSTALLED helpful error invece di crash boot.
 */
import type * as CryptoNS from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getIntegrationMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: getIntegrationMock,
}));

vi.mock('@/lib/logger.js');

const {
  IntegrationError, withRetry, requireIntegration, isOAuthExpiringSoon, lazyRequire,
} = await import('./common.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 IntegrationError — typed wrapper', () => {
  it('🚨 costruzione completa con tutti i campi', () => {
    const cause = new Error('upstream');
    const err = new IntegrationError({
      provider: 'gmail',
      code: 'OAUTH_REFRESH_FAILED',
      message: 'token rifiutato',
      cause,
      httpStatus: 401,
      retryable: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('IntegrationError');
    expect(err.provider).toBe('gmail');
    expect(err.code).toBe('OAUTH_REFRESH_FAILED');
    expect(err.message).toBe('token rifiutato');
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
  });

  it('🚨 default retryable=false', () => {
    const err = new IntegrationError({ provider: 'x' as never, code: 'C', message: 'm' });
    expect(err.retryable).toBe(false);
  });

  it('🚨 senza cause → cause undefined (no spread errato)', () => {
    const err = new IntegrationError({ provider: 'x' as never, code: 'C', message: 'm' });
    expect(err.cause).toBeUndefined();
  });

  it('🚨 provider "unknown" ammesso (fail-secure pre-lookup)', () => {
    const err = new IntegrationError({ provider: 'unknown', code: 'C', message: 'm' });
    expect(err.provider).toBe('unknown');
  });
});

describe('🚨 withRetry — exponential backoff + jitter', () => {
  it('🚨 success al primo tentativo → no retry', async () => {
    const op = vi.fn(async () => 'ok');
    const r = await withRetry(op);
    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('🚨 retryable=true → retry fino a success', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call < 3) {
        throw new IntegrationError({
          provider: 'x' as never, code: 'TRANSIENT', message: 'err', retryable: true,
        });
      }
      return 'eventually-ok';
    });
    const r = await withRetry(op, { baseDelayMs: 1, maxDelayMs: 5 });
    expect(r).toBe('eventually-ok');
    expect(call).toBe(3);
  });

  it('🚨 SECURITY: 4xx → NO retry (client error)', async () => {
    const op = vi.fn(async () => {
      throw new IntegrationError({
        provider: 'x' as never, code: 'BAD_REQ', message: 'm',
        httpStatus: 400, retryable: false,
      });
    });
    await expect(withRetry(op, { baseDelayMs: 1 })).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('🚨 5xx → retry (server error transient)', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call < 2) {
        throw new IntegrationError({
          provider: 'x' as never, code: 'SERVER_ERR', message: 'm', httpStatus: 503,
        });
      }
      return 'recovered';
    });
    const r = await withRetry(op, { baseDelayMs: 1, maxDelayMs: 5 });
    expect(r).toBe('recovered');
    expect(call).toBe(2);
  });

  it('🚨 retry exhausted → throw last error', async () => {
    const op = vi.fn(async () => {
      throw new IntegrationError({
        provider: 'x' as never, code: 'TRANSIENT', message: 'persistent', retryable: true,
      });
    });
    await expect(withRetry(op, { retries: 2, baseDelayMs: 1 })).rejects.toThrow(/persistent/);
    expect(op).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('🚨 network error: ETIMEDOUT → retry', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('connect ETIMEDOUT 192.168.1.1:443');
      return 'ok';
    });
    const r = await withRetry(op, { baseDelayMs: 1 });
    expect(r).toBe('ok');
  });

  it('🚨 network error: ECONNRESET → retry', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('socket: ECONNRESET');
      return 'ok';
    });
    await withRetry(op, { baseDelayMs: 1 });
    expect(call).toBe(2);
  });

  it('🚨 network error: EAI_AGAIN (DNS) → retry', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('getaddrinfo EAI_AGAIN api.x.com');
      return 'ok';
    });
    await withRetry(op, { baseDelayMs: 1 });
    expect(call).toBe(2);
  });

  it('🚨 network error: "fetch failed" → retry', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('fetch failed');
      return 'ok';
    });
    await withRetry(op, { baseDelayMs: 1 });
    expect(call).toBe(2);
  });

  it('🚨 network error: "socket hang up" → retry', async () => {
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      return 'ok';
    });
    await withRetry(op, { baseDelayMs: 1 });
    expect(call).toBe(2);
  });

  it('🚨 SECURITY: errore generico (NOT network NOT integration) → no retry', async () => {
    const op = vi.fn(async () => {
      throw new Error('TypeError: x.y is undefined');
    });
    await expect(withRetry(op, { baseDelayMs: 1 })).rejects.toThrow(/TypeError/);
    expect(op).toHaveBeenCalledTimes(1); // no retry su bug logic
  });

  it('🚨 BOUNDARY: retries=0 → 1 sola call, throw immediato', async () => {
    const op = vi.fn(async () => {
      throw new IntegrationError({
        provider: 'x' as never, code: 'C', message: 'm', retryable: true,
      });
    });
    await expect(withRetry(op, { retries: 0, baseDelayMs: 1 })).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('🚨 delay cap: maxDelayMs rispettato', async () => {
    // Verifico che con baseDelay alto e maxDelay basso, il delay sia capped
    // (indirect: tempo totale tra retry == ~maxDelay × retries)
    let call = 0;
    const op = vi.fn(async () => {
      call += 1;
      if (call < 3) throw new IntegrationError({
        provider: 'x' as never, code: 'C', message: 'm', retryable: true,
      });
      return 'ok';
    });
    const start = Date.now();
    await withRetry(op, { retries: 5, baseDelayMs: 10000, maxDelayMs: 50 });
    const elapsed = Date.now() - start;
    // 2 retry × max 50ms = 100ms upper bound + tolleranza scheduler
    expect(elapsed).toBeLessThan(500);
  });
});

describe('🚨 requireIntegration — fail-loud', () => {
  it('🚨 integration found → ritorna record', () => {
    const record = { provider: 'gmail', credentials: { token: 'x' }, tenantId: 't1' };
    getIntegrationMock.mockReturnValue(record);
    const r = requireIntegration({ provider: 'gmail' as never, tenantId: 't1' });
    expect(r).toBe(record);
  });

  it('🚨 integration MISSING → IntegrationError NOT_CONFIGURED', () => {
    getIntegrationMock.mockReturnValue(null);
    expect(() => requireIntegration({ provider: 'slack' as never, tenantId: 't1' })).toThrow(IntegrationError);
    try {
      requireIntegration({ provider: 'slack' as never, tenantId: 't1' });
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.code).toBe('NOT_CONFIGURED');
      expect(err.provider).toBe('slack');
      expect(err.message).toContain('slack');
      expect(err.message).toContain('not configured');
    }
  });

  it('🚨 con label → label nel messaggio per UX', () => {
    getIntegrationMock.mockReturnValue(null);
    try {
      requireIntegration({ provider: 'gmail' as never, tenantId: 't1', label: 'work-account' });
    } catch (e) {
      expect((e as Error).message).toContain('label="work-account"');
    }
  });

  it('🚨 label null/undefined → no labelHint', () => {
    getIntegrationMock.mockReturnValue(null);
    try {
      requireIntegration({ provider: 'gmail' as never, tenantId: 't1' });
    } catch (e) {
      expect((e as Error).message).not.toContain('label=');
    }
  });
});

describe('🚨 isOAuthExpiringSoon — 5min safety margin', () => {
  it('🚨 expiresAt null → false (no refresh needed)', () => {
    expect(isOAuthExpiringSoon(null)).toBe(false);
    expect(isOAuthExpiringSoon(undefined)).toBe(false);
    expect(isOAuthExpiringSoon(0)).toBe(false);
  });

  it('🚨 expiresAt > 5min nel futuro → false', () => {
    expect(isOAuthExpiringSoon(Date.now() + 10 * 60 * 1000)).toBe(false);
  });

  it('🚨 expiresAt < 5min nel futuro → true (refresh imminente)', () => {
    expect(isOAuthExpiringSoon(Date.now() + 2 * 60 * 1000)).toBe(true);
  });

  it('🚨 expiresAt nel passato → true (token gia\' scaduto)', () => {
    expect(isOAuthExpiringSoon(Date.now() - 1000)).toBe(true);
  });

  it('🚨 boundary: exactly 5min → false (margin esatto)', () => {
    expect(isOAuthExpiringSoon(Date.now() + 5 * 60 * 1000)).toBe(false);
  });

  it('🚨 boundary: 5min - 1ms → true', () => {
    expect(isOAuthExpiringSoon(Date.now() + 5 * 60 * 1000 - 100)).toBe(true);
  });
});

describe('🚨 lazyRequire — graceful module load', () => {
  it('🚨 module loadable → ritorna module', async () => {
    // 'node:crypto' è sempre disponibile in Node 22
    const mod = await lazyRequire<typeof CryptoNS>('node:crypto', 'crypto', 'gmail' as never);
    expect(mod).toBeDefined();
    expect(typeof mod.randomBytes).toBe('function');
  });

  it('🚨 module MANCANTE → IntegrationError MODULE_NOT_INSTALLED', async () => {
    await expect(lazyRequire('@flowforge/non-existent-package-xyz', 'fake-package', 'slack' as never))
      .rejects.toThrow(IntegrationError);
    try {
      await lazyRequire('@flowforge/non-existent-package-xyz', 'fake-package', 'slack' as never);
    } catch (e) {
      const err = e as InstanceType<typeof IntegrationError>;
      expect(err.code).toBe('MODULE_NOT_INSTALLED');
      expect(err.provider).toBe('slack');
      expect(err.message).toContain('fake-package');
      expect(err.message).toContain('pnpm install');
      expect(err.cause).toBeDefined();
    }
  });
});
