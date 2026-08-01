/**
 * Test 2026-grade — httpMiddlewarePreset (ready-to-use stack HTTP nodes).
 *
 * 🚨 PIPELINE ORDER (outer → inner):
 *   1. withErrorMapping   — throw → NodeError tipato
 *   2. withAbortGuard     — short-circuit cancel
 *   3. withTelemetry      — OTel span http.* attrs
 *   4. withConditionalIdempotency — POST/PUT/PATCH/DELETE lock
 *   5. withHostBreaker    — per-host 5 fail → open 30s
 *
 * 🚨 OPTIONS propagation: urlFrom + methodFrom + breaker + idempotency
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  composeMock,
  withTelemetryMock,
  withConditionalIdempotencyMock,
  withHostBreakerMock,
  withErrorMappingMock,
  withAbortGuardMock,
  httpSpanAttrsMock,
} = vi.hoisted(() => ({
  composeMock: vi.fn(),
  withTelemetryMock: vi.fn(() => 'TELEMETRY_MW'),
  withConditionalIdempotencyMock: vi.fn(() => 'IDEMPOTENCY_MW'),
  withHostBreakerMock: vi.fn(() => 'BREAKER_MW'),
  withErrorMappingMock: vi.fn(() => 'ERROR_MAPPING_MW'),
  withAbortGuardMock: vi.fn(() => 'ABORT_GUARD_MW'),
  httpSpanAttrsMock: vi.fn((method: string, url: string) => ({
    'http.method': method,
    'http.url': url,
  })),
}));

vi.mock('./compose.js', async () => {
  const real = await vi.importActual<typeof import('./compose.js')>('./compose.js');
  return {
    ...real,
    compose: (...args: unknown[]) => {
      composeMock(...args);
      return real.compose(args[0] as never);
    },
  };
});

vi.mock('./telemetry.js', () => ({ withTelemetry: withTelemetryMock }));
vi.mock('./idempotency.js', () => ({ withConditionalIdempotency: withConditionalIdempotencyMock }));
vi.mock('./host-breaker.js', () => ({ withHostBreaker: withHostBreakerMock }));
vi.mock('./error-handling.js', () => ({
  withErrorMapping: withErrorMappingMock,
  withAbortGuard: withAbortGuardMock,
}));
vi.mock('../telemetry.js', () => ({ httpSpanAttrs: httpSpanAttrsMock }));

const { httpMiddlewarePreset } = await import('./presets.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 httpMiddlewarePreset — pipeline order', () => {
  it('🚨 compose chiamato con [errorMapping, abortGuard, telemetry, idempotency, breaker]', () => {
    httpMiddlewarePreset({
      urlFrom: () => 'https://x.com',
    });
    expect(composeMock).toHaveBeenCalledTimes(1);
    const middlewareList = composeMock.mock.calls[0]![0] as string[];
    expect(middlewareList).toEqual([
      'ERROR_MAPPING_MW',
      'ABORT_GUARD_MW',
      'TELEMETRY_MW',
      'IDEMPOTENCY_MW',
      'BREAKER_MW',
    ]);
  });

  it('🚨 telemetry spanName "node.http.request" + dynamicAttrs', () => {
    httpMiddlewarePreset({
      urlFrom: () => 'https://api.example.com/v1',
    });
    const telemetryOpts = withTelemetryMock.mock.calls[0]![0] as { spanName: string; dynamicAttrs: (cfg: Record<string, unknown>) => Record<string, unknown> };
    expect(telemetryOpts.spanName).toBe('node.http.request');
    expect(typeof telemetryOpts.dynamicAttrs).toBe('function');
  });

  it('🚨 dynamicAttrs invoca httpSpanAttrs con method + url', () => {
    const preset = httpMiddlewarePreset({
      urlFrom: () => 'https://api.x.com/users',
      methodFrom: () => 'POST',
    });
    expect(preset).toBeDefined();
    // Estrai dynamicAttrs e invoca manualmente
    const telemetryOpts = withTelemetryMock.mock.calls[0]![0] as { dynamicAttrs: (cfg: Record<string, unknown>) => Record<string, unknown> };
    const attrs = telemetryOpts.dynamicAttrs({});
    expect(httpSpanAttrsMock).toHaveBeenCalledWith('POST', 'https://api.x.com/users');
    expect(attrs).toEqual({ 'http.method': 'POST', 'http.url': 'https://api.x.com/users' });
  });

  it('🚨 urlFrom returns undefined → dynamicAttrs ritorna {} (no httpSpanAttrs call)', () => {
    httpMiddlewarePreset({
      urlFrom: () => undefined,
    });
    const telemetryOpts = withTelemetryMock.mock.calls[0]![0] as { dynamicAttrs: (cfg: Record<string, unknown>) => Record<string, unknown> };
    const attrs = telemetryOpts.dynamicAttrs({});
    expect(attrs).toEqual({});
    expect(httpSpanAttrsMock).not.toHaveBeenCalled();
  });
});

describe('🚨 methodFrom default = GET (RFC 7231 safe)', () => {
  it('🚨 methodFrom omesso → default GET', () => {
    httpMiddlewarePreset({
      urlFrom: () => 'https://x.com',
    });
    const idempotencyOpts = withConditionalIdempotencyMock.mock.calls[0]![0] as { methodFrom: (cfg: Record<string, unknown>) => string };
    expect(idempotencyOpts.methodFrom({})).toBe('GET');
  });

  it('🚨 methodFrom custom propagato a idempotency', () => {
    httpMiddlewarePreset({
      urlFrom: () => 'https://x.com',
      methodFrom: (cfg) => (cfg as { httpMethod?: string }).httpMethod ?? 'POST',
    });
    const idempotencyOpts = withConditionalIdempotencyMock.mock.calls[0]![0] as { methodFrom: (cfg: Record<string, unknown>) => string };
    expect(idempotencyOpts.methodFrom({ httpMethod: 'DELETE' })).toBe('DELETE');
    expect(idempotencyOpts.methodFrom({})).toBe('POST');
  });
});

describe('🚨 OPTIONAL options spread (conditional)', () => {
  it('🚨 idempotencyStore omesso → idempotency opts NON include store', () => {
    httpMiddlewarePreset({ urlFrom: () => '' });
    const opts = withConditionalIdempotencyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('store');
  });

  it('🚨 idempotencyStore presente → propagato', () => {
    const fakeStore = {} as never;
    httpMiddlewarePreset({
      urlFrom: () => '',
      idempotencyStore: fakeStore,
    });
    const opts = withConditionalIdempotencyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.store).toBe(fakeStore);
  });

  it('🚨 idempotencyTtlMs propagato', () => {
    httpMiddlewarePreset({
      urlFrom: () => '',
      idempotencyTtlMs: 3600_000,
    });
    const opts = withConditionalIdempotencyMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.ttlMs).toBe(3600_000);
  });

  it('🚨 breaker options propagati a withHostBreaker', () => {
    httpMiddlewarePreset({
      urlFrom: () => '',
      breaker: {
        failureThreshold: 10,
        openMs: 60_000,
      } as never,
    });
    const breakerOpts = withHostBreakerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(breakerOpts.failureThreshold).toBe(10);
    expect(breakerOpts.openMs).toBe(60_000);
  });

  it('🚨 breaker omesso → defaults empty object', () => {
    httpMiddlewarePreset({ urlFrom: () => '' });
    const breakerOpts = withHostBreakerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(breakerOpts.urlFrom).toBeDefined();
  });

  it('🚨 urlFrom propagato a withHostBreaker (per-host bucketing)', () => {
    const urlFromFn = (cfg: Record<string, unknown>): string => (cfg as { url: string }).url;
    httpMiddlewarePreset({ urlFrom: urlFromFn });
    const breakerOpts = withHostBreakerMock.mock.calls[0]![0] as { urlFrom: (cfg: Record<string, unknown>) => string };
    expect(breakerOpts.urlFrom).toBe(urlFromFn);
  });
});
