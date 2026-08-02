/**
 * Test runtime-metrics-reporter — computePercentiles (pure) + reportOnce HTTP path.
 *
 * computePercentiles: pure function, nearest-rank percentile.
 *
 * reportOnce: cron task che chiama POST /api/v1/internal/runtime-metrics col
 *   payload aggregato. Test coprono:
 *   - skip se manca MEDEA_TENANT_ID O internal token
 *   - PORTAL_CALLBACK_TOKEN preferito su MEDEA_INTERNAL_TOKEN
 *   - URL costruita correttamente (MEDEA_PORTAL_URL + /api/v1/internal/runtime-metrics)
 *   - body JSON contiene workspaceId + tutti i campi percentile + lastRunAt ISO
 *   - AbortSignal.timeout 10s wired
 *   - 401/4xx/5xx response → log warn + NO throw
 *   - fetch reject (network) → log warn + NO throw
 *   - getAggregated runsTotal=0 → report con percentili null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { computePercentiles } from './runtime-metrics-reporter.js';

// ───────────────────────────────────────────────────────────────────────
// SUITE 1 — computePercentiles (pure, no mock needed)
// ───────────────────────────────────────────────────────────────────────

describe('computePercentiles — pure function', () => {
  it('empty sample → all null', () => {
    expect(computePercentiles([])).toEqual({ p50: null, p95: null, p99: null, max: null });
  });

  it('single value → tutti = quel valore', () => {
    expect(computePercentiles([1234])).toEqual({ p50: 1234, p95: 1234, p99: 1234, max: 1234 });
  });

  it('100 valori 1..100 → p50=50 p95=95 p99=99 max=100', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    const out = computePercentiles(arr);
    expect(out.p50).toBe(50);
    expect(out.p95).toBe(95);
    expect(out.p99).toBe(99);
    expect(out.max).toBe(100);
  });

  it('1000 valori monotoni → percentili lineari', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => (i + 1) * 10);
    const out = computePercentiles(arr);
    expect(out.p50).toBe(5000);
    expect(out.p99).toBe(9900);
    expect(out.max).toBe(10_000);
  });

  it('p99 con n=10 → outlier wins (idx 9)', () => {
    const arr = [100, 200, 300, 400, 500, 600, 700, 800, 900, 5000];
    const out = computePercentiles(arr);
    expect(out.p99).toBe(5000);
    expect(out.max).toBe(5000);
  });

  it('monotonia: p50 <= p95 <= p99 <= max sempre', () => {
    const arr = Array.from({ length: 500 }, (_, i) => i * 13 + 5);
    const out = computePercentiles(arr);
    expect(out.p50).toBeLessThanOrEqual(out.p95!);
    expect(out.p95).toBeLessThanOrEqual(out.p99!);
    expect(out.p99).toBeLessThanOrEqual(out.max!);
  });
});

// ───────────────────────────────────────────────────────────────────────
// SUITE 2 — reportOnce HTTP path (mock fetch + config + sqlite)
// ───────────────────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock('@/config.js', () => ({ loadConfig: () => m.loadConfig() }));
vi.mock('@/lib/logger.js');
vi.mock('@/storage/db.js', () => ({ getDatabase: () => m.getDatabase() }));

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  // Reset env
  delete process.env.PORTAL_CALLBACK_TOKEN;
  delete process.env.MEDEA_INTERNAL_TOKEN;
  delete process.env.npm_package_version;

  // Default config (override per test)
  m.loadConfig.mockReturnValue({
    MEDEA_TENANT_ID: 'ws-abc-1',
    MEDEA_PORTAL_URL: 'http://portal.local:3006',
  });

  // Default DB con 0 runs (empty workspace)
  const makePrepare = (rows: unknown) => ({
    get: () => rows,
    all: () => (Array.isArray(rows) ? rows : []),
  });
  m.getDatabase.mockReturnValue({
    sqlite: {
      prepare: (sql: string) => {
        if (sql.includes('COUNT(*)')) return makePrepare({ c: 0 });
        if (sql.includes('MAX(started_at)')) return makePrepare({ last: null });
        return makePrepare([]);
      },
    },
  });
});

afterEach(() => {
  Object.assign(process.env, ORIG_ENV);
});

describe('reportOnce — skip path', () => {
  it('senza MEDEA_TENANT_ID → skip + NO fetch', async () => {
    m.loadConfig.mockReturnValue({
      MEDEA_TENANT_ID: '',
      MEDEA_PORTAL_URL: 'http://portal.local:3006',
    });
    process.env.PORTAL_CALLBACK_TOKEN = 'token-ok';
    const stubFetch = vi.fn();
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    expect(stubFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger).debug).toHaveBeenCalledWith(
      expect.objectContaining({ hasTenantId: false }),
      expect.stringContaining('skipped'),
    );
  });

  it('senza token (no PORTAL_CALLBACK_TOKEN, no MEDEA_INTERNAL_TOKEN) → skip', async () => {
    // tenantId presente ma token assenti
    const stubFetch = vi.fn();
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    expect(stubFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger).debug).toHaveBeenCalledWith(
      expect.objectContaining({ hasInternalToken: false }),
      expect.stringContaining('skipped'),
    );
  });
});

describe('reportOnce — token precedence', () => {
  it('PORTAL_CALLBACK_TOKEN preferito a MEDEA_INTERNAL_TOKEN', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'PREFERRED-shared';
    process.env.MEDEA_INTERNAL_TOKEN = 'fallback-per-tenant';

    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    expect(stubFetch).toHaveBeenCalledTimes(1);
    const [, opts] = stubFetch.mock.calls[0]!;
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers['x-internal-token']).toBe('PREFERRED-shared');
  });

  it('Fallback a MEDEA_INTERNAL_TOKEN se PORTAL_CALLBACK_TOKEN assente', async () => {
    process.env.MEDEA_INTERNAL_TOKEN = 'fallback-per-tenant';

    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const [, opts] = stubFetch.mock.calls[0]!;
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers['x-internal-token']).toBe('fallback-per-tenant');
  });
});

describe('reportOnce — happy path body + URL', () => {
  it('URL = portalUrl + /api/v1/internal/runtime-metrics (trailing slash strip)', async () => {
    m.loadConfig.mockReturnValue({
      MEDEA_TENANT_ID: 'ws-abc-1',
      MEDEA_PORTAL_URL: 'https://flowforge.automazionezeli.com/', // trailing slash
    });
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    expect(stubFetch).toHaveBeenCalledTimes(1);
    const [url] = stubFetch.mock.calls[0]!;
    expect(url).toBe('https://flowforge.automazionezeli.com/api/v1/internal/runtime-metrics');
    // NO double slash
    expect(url).not.toContain('//api');
  });

  it('body JSON contiene workspaceId + percentili null (runsTotal=0)', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const [, opts] = stubFetch.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body) as {
      workspaceId: string;
      runsTotal7d: number;
      latencyP50Ms: number | null;
      lastRunAt: string | null;
    };
    expect(body.workspaceId).toBe('ws-abc-1');
    expect(body.runsTotal7d).toBe(0);
    expect(body.latencyP50Ms).toBeNull();
    expect(body.lastRunAt).toBeNull();
  });

  it('body con runs reali → percentili calcolati + lastRunAt ISO', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    // DB con 1000 runs, durate 10..10000 ms, last_run_at iso
    const lastIso = '2026-06-06T12:34:56.000Z';
    const sample = Array.from({ length: 1000 }, (_, i) => ({ d: (i + 1) * 10 }));
    m.getDatabase.mockReturnValue({
      sqlite: {
        prepare: (sql: string) => {
          if (sql.includes("status = 'error'")) {
            return { get: () => ({ c: 25 }), all: () => [] };
          }
          if (sql.includes("status = 'partial'")) {
            return { get: () => ({ c: 10 }), all: () => [] };
          }
          if (sql.includes('COUNT(*)')) return { get: () => ({ c: 1000 }), all: () => [] };
          if (sql.includes('MAX(started_at)'))
            return { get: () => ({ last: lastIso }), all: () => [] };
          // sample query
          return { get: () => undefined, all: () => sample };
        },
      },
    });
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const [, opts] = stubFetch.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body) as {
      runsTotal7d: number;
      runsErrored7d: number;
      runsPartial7d: number;
      latencyP50Ms: number;
      latencyP95Ms: number;
      latencyP99Ms: number;
      latencyMaxMs: number;
      lastRunAt: string;
    };
    expect(body.runsTotal7d).toBe(1000);
    expect(body.runsErrored7d).toBe(25);
    expect(body.runsPartial7d).toBe(10);
    // p99 di {(i+1)*10 for 0..999} = (idx 989) = 9900
    expect(body.latencyP99Ms).toBe(9900);
    expect(body.latencyP50Ms).toBe(5000);
    expect(body.latencyMaxMs).toBe(10000);
    expect(body.lastRunAt).toBe(lastIso);
  });

  it('runtimeVersion da npm_package_version se settato', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    process.env.npm_package_version = '1.2.3';
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const [, opts] = stubFetch.mock.calls[0]!;
    const body = JSON.parse((opts as { body: string }).body) as { runtimeVersion?: string };
    expect(body.runtimeVersion).toBe('1.2.3');
  });

  it('Content-Type application/json header settato', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const [, opts] = stubFetch.mock.calls[0]!;
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers['content-type']).toBe('application/json');
    expect((opts as { method: string }).method).toBe('POST');
  });

  it('AbortSignal.timeout(10000) wired sul fetch (no infinite hang)', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    const stubFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', stubFetch);

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const [, opts] = stubFetch.mock.calls[0]!;
    expect((opts as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });
});

describe('reportOnce — error paths', () => {
  it('response 401 → log warn con status + body snippet, NO throw', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve('{"error":{"code":"UNAUTHORIZED","message":"invalid internal token"}}'),
      }),
    );

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await expect(reportOnce()).resolves.toBeUndefined();

    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 401,
        tenantId: 'ws-abc-1',
        err: expect.stringContaining('UNAUTHORIZED'),
      }),
      expect.stringContaining('portal non-2xx'),
    );
  });

  it('response 5xx → log warn + NO throw', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('maintenance window'),
      }),
    );

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await expect(reportOnce()).resolves.toBeUndefined();

    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      expect.stringContaining('portal non-2xx'),
    );
  });

  it('response body snippet truncato a 200 char nel log', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    const huge = 'x'.repeat(500);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(huge),
      }),
    );

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await reportOnce();

    const warnCall = vi
      .mocked(logger)
      .warn.mock.calls.find((c) => typeof (c[0] as { err?: string })?.err === 'string');
    expect((warnCall![0] as { err: string }).err.length).toBeLessThanOrEqual(200);
  });

  it('fetch reject (network ECONNREFUSED) → log warn + NO throw esterno', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3006')));

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await expect(reportOnce()).resolves.toBeUndefined();

    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.stringContaining('ECONNREFUSED'),
        tenantId: 'ws-abc-1',
      }),
      expect.stringContaining('report failed'),
    );
  });

  it('response.text() reject (body stream broken) → log con err vuoto, no crash', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('stream consumed')),
      }),
    );

    const { reportOnce } = await import('./runtime-metrics-reporter.js');
    await expect(reportOnce()).resolves.toBeUndefined();

    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 502, err: '' }),
      expect.stringContaining('portal non-2xx'),
    );
  });
});
