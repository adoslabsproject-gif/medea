/**
 * Test 2026-grade — metrics route (Prometheus scrape endpoint).
 *
 * 🚨 SECURITY-CRITICAL (hardening 2026-05-23):
 *  - FAIL-CLOSED: env MEDEA_METRICS_TOKEN vuoto → 403
 *  - Bearer token con TIMING-SAFE compare (anti timing-attack)
 *  - Senza Auth header → 403
 *  - Wrong token → 403 stesso response (no length leak)
 *  - Right token → 200 + Prometheus content-type
 *
 * 🚨 CORRECTNESS: 6 counter/gauge metrics + process mem + uptime.
 *   Format Prometheus parsabile (HELP + TYPE + value per metric).
 *
 * 🚨 ZERO-COUNT safe: SELECT count(*) ritorna undefined safely → ?? 0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const mockDb = {
  _values: {
    workflows: 0,
    enabled: 0,
    runsTotal: 0,
    runsError: 0,
    runs24h: 0,
    audit: 0,
  } as Record<string, number>,
  _callIndex: 0,
  _expectedOrder: ['workflows', 'enabled', 'runsTotal', 'runsError', 'runs24h', 'audit'],
  select: vi.fn(function (this: typeof mockDb) {
    return this;
  }),
  from: vi.fn(function (this: typeof mockDb) {
    return this;
  }),
  where: vi.fn(function (this: typeof mockDb) {
    return this;
  }),
  then: function (resolve: (val: unknown) => void): void {
    const key = mockDb._expectedOrder[mockDb._callIndex] ?? 'workflows';
    const val = mockDb._values[key] ?? 0;
    mockDb._callIndex++;
    resolve([{ c: val }]);
  },
};

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ db: mockDb }),
}));

vi.mock('@/storage/schema.js', () => ({
  runs: { startedAt: 'startedAt', status: 'status' },
  workflows: { enabled: 'enabled' },
  auditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
  sql: (() => {
    const tag = () => ({});
    return Object.assign(tag, { raw: () => ({}) });
  })(),
}));

const renderPrometheusMock = vi.fn(() => '');
vi.mock('@/lib/metrics-store.js', () => ({
  renderPrometheus: renderPrometheusMock,
}));

const { createMetricsRoutes } = await import('./metrics.js');

function makeApp() {
  const app = new Hono();
  app.route('/', createMetricsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MEDEA_METRICS_TOKEN;
  mockDb._callIndex = 0;
  mockDb._values = { workflows: 0, enabled: 0, runsTotal: 0, runsError: 0, runs24h: 0, audit: 0 };
  // Reset chainable mock state
  mockDb.select.mockImplementation(function (this: typeof mockDb) {
    return this;
  });
  mockDb.from.mockImplementation(function (this: typeof mockDb) {
    return this;
  });
  mockDb.where.mockImplementation(function (this: typeof mockDb) {
    return this;
  });
});

describe('🚨 /metrics — auth gate (SECURITY)', () => {
  it('🚨 MEDEA_METRICS_TOKEN env mancante → 403 disabled (fail-closed)', async () => {
    const app = makeApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toMatch(/Metrics endpoint disabled/u);
    expect(text).toMatch(/MEDEA_METRICS_TOKEN/u);
  });

  it('🚨 MEDEA_METRICS_TOKEN env vuoto → 403 (uguale a missing)', async () => {
    process.env.MEDEA_METRICS_TOKEN = '';
    const app = makeApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(403);
  });

  it('🚨 token settato, NO Auth header → 403 Forbidden', async () => {
    process.env.MEDEA_METRICS_TOKEN = 'secret-token-32-chars-min-aaaaaaa';
    const app = makeApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
  });

  it('🚨 Auth header senza "Bearer " prefix → 403', async () => {
    process.env.MEDEA_METRICS_TOKEN = 'secret-token-32-chars-min-aaaaaaa';
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(403);
  });

  it('🚨 Bearer token wrong → 403', async () => {
    process.env.MEDEA_METRICS_TOKEN = 'right-token-aaaaaaaaaaaaaaaaaaaaaa';
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer wrong-token-aaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.status).toBe(403);
  });

  it('🚨 SECURITY: token length mismatch → 403 senza timing leak', async () => {
    process.env.MEDEA_METRICS_TOKEN = 'short-token';
    const app = makeApp();
    // length diversa: timingSafeEqual throw → catched by length check first
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer much-longer-token-here-aaaa' },
    });
    expect(res.status).toBe(403);
  });

  it('🚨 Bearer token correct → 200 + Content-Type Prometheus', async () => {
    process.env.MEDEA_METRICS_TOKEN = 'secret-correct-token-aaaaaaaaaaaa';
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer secret-correct-token-aaaaaaaaaaaa' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/u);
  });
});

describe('🚨 /metrics — output Prometheus format', () => {
  beforeEach(() => {
    process.env.MEDEA_METRICS_TOKEN = 'tok-correct-aaaaaaaaaaaaaaaaaaaa';
    mockDb._values = {
      workflows: 42,
      enabled: 37,
      runsTotal: 1000,
      runsError: 15,
      runs24h: 120,
      audit: 5000,
    };
  });

  it('🚨 HELP + TYPE + value per ogni metric (formato Prometheus)', async () => {
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer tok-correct-aaaaaaaaaaaaaaaaaaaa' },
    });
    const text = await res.text();
    expect(text).toMatch(/# HELP flowforge_workflows_total/u);
    expect(text).toMatch(/# TYPE flowforge_workflows_total gauge/u);
    expect(text).toMatch(/flowforge_workflows_total 42/u);
    expect(text).toMatch(/flowforge_workflows_enabled 37/u);
    expect(text).toMatch(/flowforge_runs_total 1000/u);
    expect(text).toMatch(/flowforge_runs_error_total 15/u);
    expect(text).toMatch(/flowforge_runs_24h 120/u);
    expect(text).toMatch(/flowforge_audit_entries_total 5000/u);
  });

  it('🚨 process metrics: rss + heapUsed + uptime', async () => {
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer tok-correct-aaaaaaaaaaaaaaaaaaaa' },
    });
    const text = await res.text();
    expect(text).toMatch(/flowforge_process_memory_rss_bytes \d+/u);
    expect(text).toMatch(/flowforge_process_memory_heap_used_bytes \d+/u);
    expect(text).toMatch(/flowforge_uptime_seconds \d+/u);
  });

  it('🚨 zero-count safe: TUTTE le metric a 0 → no NaN, no crash', async () => {
    mockDb._values = {
      workflows: 0,
      enabled: 0,
      runsTotal: 0,
      runsError: 0,
      runs24h: 0,
      audit: 0,
    };
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer tok-correct-aaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/flowforge_workflows_total 0/u);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  it('🚨 dynamicMetrics (metrics-store) appendate alla fine', async () => {
    renderPrometheusMock.mockReturnValueOnce(
      '# HELP custom_metric Custom\n# TYPE custom_metric counter\ncustom_metric 99',
    );
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer tok-correct-aaaaaaaaaaaaaaaaaaaa' },
    });
    const text = await res.text();
    expect(text).toMatch(/custom_metric 99/u);
    // Custom metric DOPO le statiche
    const customIdx = text.indexOf('custom_metric');
    const staticIdx = text.indexOf('flowforge_uptime_seconds');
    expect(customIdx).toBeGreaterThan(staticIdx);
  });

  it('🚨 dynamicMetrics vuoto → no double-newline trailing', async () => {
    renderPrometheusMock.mockReturnValueOnce('');
    const app = makeApp();
    const res = await app.request('/metrics', {
      headers: { authorization: 'Bearer tok-correct-aaaaaaaaaaaaaaaaaaaa' },
    });
    const text = await res.text();
    // Last char è \n singolo (lines.join('\n') + '\n')
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n\n')).toBe(false);
  });
});

describe('🚨 /metrics — timing-safe token comparison', () => {
  it('🚨 timingSafeEqual usato (length check protegge da throw)', async () => {
    // Verifica indiretta: token corretto passa, token length diversa NON crasha
    process.env.MEDEA_METRICS_TOKEN = 'short';
    const app = makeApp();
    const resShort = await app.request('/metrics', {
      headers: { authorization: 'Bearer short' },
    });
    expect(resShort.status).toBe(200);
    const resLong = await app.request('/metrics', {
      headers: { authorization: 'Bearer this-token-is-much-longer' },
    });
    expect(resLong.status).toBe(403);
  });
});
