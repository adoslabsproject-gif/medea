import { describe, it, expect } from 'vitest';
import {
  NodeError,
  ValidationError,
  HttpError,
  NetworkError,
  TimeoutError,
  CircuitOpenError,
  IdempotencyConflictError,
  QuotaExceededError,
  AuthError,
  AbortedError,
  ConfigError,
  asNodeError,
  categoryOf,
  actionHintFor,
  isTransientCategory,
  parseRetryAfter,
  retryAfterMsOf,
} from './node-error.js';

describe('parseRetryAfter (RFC 7231)', () => {
  it('secondi → ms', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('  5 ')).toBe(5000);
  });
  it('data HTTP futura → delta ms', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(30_000);
  });
  it('data nel passato → null', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const past = new Date(now - 10_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBeNull();
  });
  it('assente/non valido → null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('garbage')).toBeNull();
  });
});

describe('HttpError retryAfterMs + retryAfterMsOf', () => {
  it('HttpError espone retryAfterMs nel context; retryAfterMsOf lo estrae', () => {
    const e = new HttpError({ status: 429, retryAfterMs: 60_000 });
    expect(e.context.retryAfterMs).toBe(60_000);
    expect(retryAfterMsOf(e)).toBe(60_000);
  });
  it('retryAfterMsOf null per errori senza retry-after', () => {
    expect(retryAfterMsOf(new HttpError({ status: 500 }))).toBeNull();
    expect(retryAfterMsOf(new Error('x'))).toBeNull();
    expect(retryAfterMsOf(null)).toBeNull();
  });
});

describe('NodeError — categorie semantiche + azione UI', () => {
  it('categoryOf raggruppa i code in famiglie', () => {
    expect(categoryOf({ code: 'VALIDATION_ERROR' })).toBe('validation');
    expect(categoryOf({ code: 'CONFIG_ERROR' })).toBe('validation');
    expect(categoryOf({ code: 'BODY_TOO_LARGE' })).toBe('validation');
    expect(categoryOf({ code: 'AUTH_ERROR' })).toBe('auth');
    expect(categoryOf({ code: 'NETWORK_ERROR' })).toBe('network');
    expect(categoryOf({ code: 'TIMEOUT' })).toBe('network');
    expect(categoryOf({ code: 'CIRCUIT_OPEN' })).toBe('network');
    expect(categoryOf({ code: 'QUOTA_EXCEEDED' })).toBe('rate_limit');
    expect(categoryOf({ code: 'IDEMPOTENCY_CONFLICT' })).toBe('business');
    expect(categoryOf({ code: 'ABORTED' })).toBe('aborted');
    expect(categoryOf({ code: 'INTERNAL_ERROR' })).toBe('internal');
  });

  it('HTTP_ERROR: 5xx/429 (retryable) → network, 4xx (non-retryable) → business', () => {
    expect(categoryOf({ code: 'HTTP_ERROR', retryable: true })).toBe('network');
    expect(categoryOf({ code: 'HTTP_ERROR', retryable: false })).toBe('business');
    // coerenza con le sottoclassi reali
    expect(categoryOf(new HttpError({ status: 503 }))).toBe('network');
    expect(categoryOf(new HttpError({ status: 404 }))).toBe('business');
    expect(categoryOf(new HttpError({ status: 429 }))).toBe('network');
  });

  it('actionHintFor dà un testo IT per ogni categoria', () => {
    for (const cat of [
      'validation',
      'auth',
      'network',
      'rate_limit',
      'business',
      'aborted',
      'internal',
    ] as const) {
      expect(actionHintFor(cat).length).toBeGreaterThan(10);
    }
    expect(actionHintFor('auth')).toMatch(/credenziali/iu);
  });

  it('isTransientCategory: solo network e rate_limit', () => {
    expect(isTransientCategory('network')).toBe(true);
    expect(isTransientCategory('rate_limit')).toBe(true);
    expect(isTransientCategory('validation')).toBe(false);
    expect(isTransientCategory('business')).toBe(false);
  });

  it("categoryOf accetta direttamente un'istanza NodeError", () => {
    expect(categoryOf(new AuthError({ reason: 'token scaduto' }))).toBe('auth');
    expect(categoryOf(new TimeoutError({ timeoutMs: 1000 }))).toBe('network');
  });
});

describe('NodeError hierarchy', () => {
  describe('NodeError base', () => {
    it('exposes code/retryable/context + toJSON', () => {
      const e = new NodeError({
        code: 'INTERNAL_ERROR',
        message: 'x',
        retryable: true,
        context: { a: 1 },
      });
      expect(e.code).toBe('INTERNAL_ERROR');
      expect(e.retryable).toBe(true);
      expect(e.context).toEqual({ a: 1 });
      expect(e.toJSON()).toEqual({
        name: 'NodeError',
        code: 'INTERNAL_ERROR',
        message: 'x',
        retryable: true,
        context: { a: 1 },
      });
    });

    it('chains cause via Error.cause', () => {
      const cause = new Error('root');
      const e = new NodeError({ code: 'INTERNAL_ERROR', message: 'wrapper', cause });
      expect(e.cause).toBe(cause);
    });

    it('defaults retryable=false, context={}', () => {
      const e = new NodeError({ code: 'INTERNAL_ERROR', message: 'x' });
      expect(e.retryable).toBe(false);
      expect(e.context).toEqual({});
    });
  });

  describe('ValidationError', () => {
    it('always non-retryable', () => {
      expect(new ValidationError('missing url').retryable).toBe(false);
      expect(new ValidationError('bad').code).toBe('VALIDATION_ERROR');
    });
  });

  describe('HttpError', () => {
    it('5xx is retryable, 4xx is not', () => {
      expect(new HttpError({ status: 500 }).retryable).toBe(true);
      expect(new HttpError({ status: 502 }).retryable).toBe(true);
      expect(new HttpError({ status: 404 }).retryable).toBe(false);
      expect(new HttpError({ status: 401 }).retryable).toBe(false);
    });

    it('429 + 408 are retryable (rate-limit + req-timeout)', () => {
      expect(new HttpError({ status: 429 }).retryable).toBe(true);
      expect(new HttpError({ status: 408 }).retryable).toBe(true);
    });

    it('exposes status + url + truncates bodyExcerpt to 500', () => {
      const big = 'x'.repeat(2000);
      const e = new HttpError({
        status: 500,
        statusText: 'oops',
        url: 'https://e.com',
        bodyExcerpt: big,
      });
      expect(e.status).toBe(500);
      expect(e.context.url).toBe('https://e.com');
      expect((e.context.bodyExcerpt as string).length).toBe(500);
    });
  });

  describe('NetworkError', () => {
    it('is retryable', () => {
      expect(new NetworkError('ECONNRESET').retryable).toBe(true);
    });

    it('passes url + cause', () => {
      const cause = new Error('underlying');
      const e = new NetworkError('boom', { url: 'https://x.com', cause });
      expect(e.context.url).toBe('https://x.com');
      expect(e.cause).toBe(cause);
    });
  });

  describe('TimeoutError', () => {
    it('is retryable + includes ms', () => {
      const e = new TimeoutError({ timeoutMs: 5000 });
      expect(e.retryable).toBe(true);
      expect(e.context.timeoutMs).toBe(5000);
      expect(e.message).toContain('5000');
    });
  });

  describe('CircuitOpenError', () => {
    it('is NOT retryable (waste of work)', () => {
      const e = new CircuitOpenError({ breakerName: 'liara', nextProbeAt: 1000 });
      expect(e.retryable).toBe(false);
      expect(e.context.breakerName).toBe('liara');
    });
  });

  describe('IdempotencyConflictError', () => {
    it('is non-retryable + includes ISO timestamp in message', () => {
      const ts = Date.UTC(2026, 0, 1);
      const e = new IdempotencyConflictError({ key: 'run1:node1', previousAt: ts });
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('2026-01-01');
    });
  });

  describe('QuotaExceededError', () => {
    it('encodes limit + used', () => {
      const e = new QuotaExceededError({ quotaName: 'http_per_min', limit: 100, used: 150 });
      expect(e.retryable).toBe(false);
      expect(e.context.limit).toBe(100);
      expect(e.context.used).toBe(150);
    });
  });

  describe('AuthError', () => {
    it('is non-retryable', () => {
      const e = new AuthError({ reason: 'invalid token' });
      expect(e.retryable).toBe(false);
    });
  });

  describe('AbortedError', () => {
    it('default reason + non-retryable', () => {
      const e = new AbortedError();
      expect(e.message).toMatch(/cancelled/);
      expect(e.code).toBe('ABORTED');
    });
  });

  describe('ConfigError', () => {
    it('captures fieldKey', () => {
      const e = new ConfigError('bad', { fieldKey: 'url' });
      expect(e.context.fieldKey).toBe('url');
    });
  });

  describe('asNodeError', () => {
    it('passes through existing NodeError', () => {
      const orig = new ValidationError('x');
      expect(asNodeError(orig)).toBe(orig);
    });

    it('classifies timeout messages', () => {
      const e = asNodeError(new Error('Request timeout after 5s'));
      expect(e.code).toBe('TIMEOUT');
    });

    it('#223 preserves original message when timeout ms NOT extractable (no "Timeout dopo 0ms" mascheramento)', () => {
      const e = asNodeError(new Error('timeout while connecting'));
      expect(e.code).toBe('TIMEOUT');
      // Il messaggio originale è preservato — niente "Timeout dopo 0ms" mascheramento
      expect(e.message).toBe('timeout while connecting');
      expect(e.message).not.toMatch(/Timeout dopo 0ms/);
      expect(e.retryable).toBe(true);
    });

    it('#223 extracts timeoutMs from "Nms" pattern e usa TimeoutError reale', () => {
      const e = asNodeError(new Error('http timeout 5000ms exceeded'));
      expect(e.code).toBe('TIMEOUT');
      expect(e.name).toBe('TimeoutError');
      expect(e.message).toMatch(/5000ms/);
    });

    it('#223 zero-ms NON produce TimeoutError (mantiene messaggio originale)', () => {
      const e = asNodeError(new Error('AbortSignal timeout 0ms triggered'));
      expect(e.code).toBe('TIMEOUT');
      // L'estrazione vede "0ms" ma 0 NON è > 0 → preserva messaggio
      expect(e.message).toBe('AbortSignal timeout 0ms triggered');
    });

    it('wraps generic Error into INTERNAL_ERROR', () => {
      const e = asNodeError(new Error('boom'));
      expect(e.code).toBe('INTERNAL_ERROR');
      expect(e.message).toBe('boom');
      expect(e.retryable).toBe(false);
    });

    it('wraps non-Error throws', () => {
      const e = asNodeError('plain string');
      expect(e.code).toBe('INTERNAL_ERROR');
      expect(e.message).toBe('plain string');
    });
  });
});
