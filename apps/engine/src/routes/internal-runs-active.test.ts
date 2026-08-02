/**
 * Tests runtime route /api/v1/internal/runs-active.
 *
 * Invarianti:
 *   - Token assente in env → 401
 *   - Header x-internal-token mancante → 401
 *   - Token sbagliato (stessa lunghezza, byte diversi) → 401
 *   - Token corretto → 200 { active: N } da RunService.getActiveRunCount()
 *   - Risposta sempre JSON, mai HTML/text
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  getActiveRunCount: vi.fn(),
  getActiveCronScheduleCount: vi.fn(),
  countEnabled: vi.fn(),
  setReadOnly: vi.fn(),
  setVectorQuota: vi.fn(),
  setEgress: vi.fn(),
  revokeWorkspaceUser: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/run.service.js', () => ({
  RunService: { getActiveRunCount: () => m.getActiveRunCount() },
}));
vi.mock('../services/scheduler.service.js', () => ({
  SchedulerService: { getActiveCronScheduleCount: () => m.getActiveCronScheduleCount() },
}));
vi.mock('../services/workflow.service.js', () => ({
  WorkflowService: class { countEnabled() { return m.countEnabled(); } },
}));
vi.mock('../adapters/event-bus-memory.js', () => ({
  InMemoryEventBus: class {},
}));
vi.mock('../lib/logger.js', () => ({ loggerFor: () => m.log }));
vi.mock('../services/readonly-flag.service.js', () => ({
  setWorkspaceReadOnly: (v: boolean) => m.setReadOnly(v),
}));
vi.mock('../services/vector-quota-flag.service.js', () => ({
  setVectorQuotaOverride: (o: unknown) => m.setVectorQuota(o),
}));
vi.mock('../lib/egress-policy.js', () => ({
  setEgressAllowlist: (csv: string) => m.setEgress(csv),
}));
vi.mock('../services/security/user-revocation.js', () => ({
  revokeWorkspaceUser: (input: unknown) => m.revokeWorkspaceUser(input),
}));

import { createInternalRunsActiveRoute } from './internal-runs-active.js';

const TOKEN = 'super-secret-internal-token-32chars';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1', createInternalRunsActiveRoute());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEDEA_INTERNAL_TOKEN = TOKEN;
  m.getActiveRunCount.mockReturnValue(0);
  m.getActiveCronScheduleCount.mockReturnValue(0);
  m.countEnabled.mockResolvedValue(0);
});

afterEach(() => {
  delete process.env.MEDEA_INTERNAL_TOKEN;
});

describe('GET /api/v1/internal/runs-active', () => {
  it('token env non configurato → 401 fail-closed (no crash)', async () => {
    delete process.env.MEDEA_INTERNAL_TOKEN;
    const res = await buildApp().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': TOKEN },
    });
    // Invariante di sicurezza: secret assente → 401 (mai 200, mai crash). Il
    // gate è ora `requireInternalToken` (lib/internal-token), primitivo puro: il
    // 401 fail-closed è la garanzia, non un log per-request (rimosso col refactor).
    expect(res.status).toBe(401);
  });

  it('header mancante → 401', async () => {
    const res = await buildApp().request('/api/v1/internal/runs-active');
    expect(res.status).toBe(401);
  });

  it('token lunghezza diversa → 401 (no crash su timingSafeEqual)', async () => {
    const res = await buildApp().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('token stessa lunghezza ma byte diversi → 401', async () => {
    const wrongSameLen = 'X'.repeat(TOKEN.length);
    const res = await buildApp().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': wrongSameLen },
    });
    expect(res.status).toBe(401);
  });

  it('token corretto + 0 run → 200 { active: 0 }', async () => {
    m.getActiveRunCount.mockReturnValueOnce(0);
    const res = await buildApp().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: 0 });
  });

  it('token corretto + 5 run inflight → 200 { active: 5 }', async () => {
    m.getActiveRunCount.mockReturnValueOnce(5);
    const res = await buildApp().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: 5 });
  });

  it('response sempre application/json', async () => {
    const res = await buildApp().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('GET /api/v1/internal/cron-schedules-count', () => {
  it('token mancante → 401', async () => {
    const res = await buildApp().request('/api/v1/internal/cron-schedules-count');
    expect(res.status).toBe(401);
  });

  it('token errato → 401', async () => {
    const res = await buildApp().request('/api/v1/internal/cron-schedules-count', {
      headers: { 'x-internal-token': 'X'.repeat(TOKEN.length) },
    });
    expect(res.status).toBe(401);
  });

  it('env token non configurato → 401', async () => {
    delete process.env.MEDEA_INTERNAL_TOKEN;
    const res = await buildApp().request('/api/v1/internal/cron-schedules-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it('token corretto + 0 cron schedules → 200 { count: 0 }', async () => {
    m.getActiveCronScheduleCount.mockReturnValueOnce(0);
    const res = await buildApp().request('/api/v1/internal/cron-schedules-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });

  it('token corretto + 7 cron schedules → 200 { count: 7 }', async () => {
    m.getActiveCronScheduleCount.mockReturnValueOnce(7);
    const res = await buildApp().request('/api/v1/internal/cron-schedules-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7 });
  });
});

describe('GET /api/v1/internal/workflows-enabled-count', () => {
  it('token mancante → 401', async () => {
    const res = await buildApp().request('/api/v1/internal/workflows-enabled-count');
    expect(res.status).toBe(401);
  });

  it('env token non configurato → 401', async () => {
    delete process.env.MEDEA_INTERNAL_TOKEN;
    const res = await buildApp().request('/api/v1/internal/workflows-enabled-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it('token corretto + 0 workflow enabled → 200 { count: 0 }', async () => {
    m.countEnabled.mockResolvedValueOnce(0);
    const res = await buildApp().request('/api/v1/internal/workflows-enabled-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });

  it('token corretto + 12 workflow enabled → 200 { count: 12 }', async () => {
    m.countEnabled.mockResolvedValueOnce(12);
    const res = await buildApp().request('/api/v1/internal/workflows-enabled-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 12 });
  });

  it('errore servizio → 200 { count: 0, error: ... } fail-safe', async () => {
    m.countEnabled.mockRejectedValueOnce(new Error('db unavailable'));
    const res = await buildApp().request('/api/v1/internal/workflows-enabled-count', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; error?: string };
    expect(body.count).toBe(0);
    expect(body.error).toBe('count failed');
  });
});

describe('🔒 POST /api/v1/internal/workspace/read-only — security + validazione', () => {
  function postReadOnly(headers: Record<string, string>, body: string) {
    return buildApp().request('/api/v1/internal/workspace/read-only', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  it('🔒 SENZA token → 401, flag NON toccato (anti-DoS: un toggle non-auth freezerebbe il tenant)', async () => {
    const res = await postReadOnly({}, JSON.stringify({ readOnly: true }));
    expect(res.status).toBe(401);
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it('🔒 token SBAGLIATO → 401, flag NON toccato', async () => {
    const res = await postReadOnly({ 'x-internal-token': 'wrong-token-of-same-len-aaaaaaa' }, JSON.stringify({ readOnly: true }));
    expect(res.status).toBe(401);
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it('token env non configurato → 401 (fail-safe, no crash)', async () => {
    delete process.env.MEDEA_INTERNAL_TOKEN;
    const res = await postReadOnly({ 'x-internal-token': TOKEN }, JSON.stringify({ readOnly: true }));
    expect(res.status).toBe(401);
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it('body senza readOnly boolean → 400, flag NON toccato', async () => {
    const res = await postReadOnly({ 'x-internal-token': TOKEN }, JSON.stringify({ foo: 'bar' }));
    expect(res.status).toBe(400);
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it('🔒 readOnly come STRINGA "true" (type-juggling) → 400, NON settato', async () => {
    const res = await postReadOnly({ 'x-internal-token': TOKEN }, JSON.stringify({ readOnly: 'true' }));
    expect(res.status).toBe(400);
    expect(m.setReadOnly).not.toHaveBeenCalled();
  });

  it('body non-JSON → 400 (no crash)', async () => {
    const res = await postReadOnly({ 'x-internal-token': TOKEN }, 'not json{{');
    expect(res.status).toBe(400);
  });

  it('token valido + readOnly:true → 200, setWorkspaceReadOnly(true)', async () => {
    const res = await postReadOnly({ 'x-internal-token': TOKEN }, JSON.stringify({ readOnly: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, readOnly: true });
    expect(m.setReadOnly).toHaveBeenCalledWith(true);
  });

  it('token valido + readOnly:false → 200, setWorkspaceReadOnly(false) (sblocco)', async () => {
    const res = await postReadOnly({ 'x-internal-token': TOKEN }, JSON.stringify({ readOnly: false }));
    expect(res.status).toBe(200);
    expect(m.setReadOnly).toHaveBeenCalledWith(false);
  });
});

describe('🔒 POST /api/v1/internal/workspace/vector-quota — security + validazione (Inc.6)', () => {
  function postQuota(headers: Record<string, string>, body: string) {
    return buildApp().request('/api/v1/internal/workspace/vector-quota', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  it('🔒 SENZA token → 401, override NON toccato (un set non-auth altererebbe la quota)', async () => {
    const res = await postQuota({}, JSON.stringify({ maxVectors: 100, maxDiskMb: 10 }));
    expect(res.status).toBe(401);
    expect(m.setVectorQuota).not.toHaveBeenCalled();
  });

  it('🔒 token SBAGLIATO (stessa lunghezza) → 401', async () => {
    const res = await postQuota({ 'x-internal-token': 'wrong-token-of-same-len-aaaaaaa' }, JSON.stringify({ maxVectors: 100, maxDiskMb: 10 }));
    expect(res.status).toBe(401);
    expect(m.setVectorQuota).not.toHaveBeenCalled();
  });

  it('token env non configurato → 401 (fail-safe)', async () => {
    delete process.env.MEDEA_INTERNAL_TOKEN;
    const res = await postQuota({ 'x-internal-token': TOKEN }, JSON.stringify({ maxVectors: 100, maxDiskMb: 10 }));
    expect(res.status).toBe(401);
    expect(m.setVectorQuota).not.toHaveBeenCalled();
  });

  it('🔒 type-juggling: maxVectors STRINGA "100" → 400, NON settato (no coercizione)', async () => {
    const res = await postQuota({ 'x-internal-token': TOKEN }, JSON.stringify({ maxVectors: '100', maxDiskMb: 10 }));
    expect(res.status).toBe(400);
    expect(m.setVectorQuota).not.toHaveBeenCalled();
  });

  it('🔒 maxVectors NEGATIVO → 400 (>=0 richiesto)', async () => {
    const res = await postQuota({ 'x-internal-token': TOKEN }, JSON.stringify({ maxVectors: -1, maxDiskMb: 10 }));
    expect(res.status).toBe(400);
    expect(m.setVectorQuota).not.toHaveBeenCalled();
  });

  it('campo mancante (solo maxVectors) → 400', async () => {
    const res = await postQuota({ 'x-internal-token': TOKEN }, JSON.stringify({ maxVectors: 100 }));
    expect(res.status).toBe(400);
    expect(m.setVectorQuota).not.toHaveBeenCalled();
  });

  it('body non-JSON → 400 (no crash)', async () => {
    const res = await postQuota({ 'x-internal-token': TOKEN }, 'nope{{');
    expect(res.status).toBe(400);
  });

  it('token valido + numeri → 200, setVectorQuotaOverride({maxVectors, maxDiskMb})', async () => {
    const res = await postQuota({ 'x-internal-token': TOKEN }, JSON.stringify({ maxVectors: 500, maxDiskMb: 50 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, maxVectors: 500, maxDiskMb: 50 });
    expect(m.setVectorQuota).toHaveBeenCalledWith({ maxVectors: 500, maxDiskMb: 50 });
  });

  it('token valido + null (illimitato, es. upgrade Enterprise) → 200, override illimitato', async () => {
    const res = await postQuota({ 'x-internal-token': TOKEN }, JSON.stringify({ maxVectors: null, maxDiskMb: null }));
    expect(res.status).toBe(200);
    expect(m.setVectorQuota).toHaveBeenCalledWith({ maxVectors: null, maxDiskMb: null });
  });
});

describe('🔒 [REGRESSION 2026-06-11] il gate internal NON deve bloccare route sorelle sotto /api/v1', () => {
  // Replica FEDELE del prod: la dashboard è un SUB-APP montato `app.route('/api/v1', ...)`
  // ACCANTO all'internal sub-app — come server.ts. La prima versione del test montava
  // la sorella come route diretta e NON beccava il leak (passava col fix insufficiente
  // `app.use('/internal/*')`, che in prod leakava lo stesso). Qui la sorella è un sub-app.
  const buildLikeProd = (): Hono => {
    const app = new Hono();
    const dashboard = new Hono();
    dashboard.get('/dashboard/workflows', (c) => c.json({ ok: true }));
    dashboard.get('/dashboard/stream', (c) => c.text('stream'));
    app.route('/api/v1', dashboard);                         // come createDashboardRoutes
    app.route('/api/v1', createInternalRunsActiveRoute());   // riga 263 server.ts
    return app;
  };

  it('GET /api/v1/dashboard/workflows (sub-app sorella, NO token) → 200, non 401', async () => {
    const res = await buildLikeProd().request('/api/v1/dashboard/workflows');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/v1/dashboard/stream (sub-app sorella, NO token) → 200, non 401', async () => {
    const res = await buildLikeProd().request('/api/v1/dashboard/stream');
    expect(res.status).toBe(200);
  });

  it('ma /api/v1/internal/* resta gated (401 senza token)', async () => {
    const res = await buildLikeProd().request('/api/v1/internal/runs-active');
    expect(res.status).toBe(401);
  });

  it('/api/v1/internal/* con token valido → 200 (il gate funziona)', async () => {
    const res = await buildLikeProd().request('/api/v1/internal/runs-active', {
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.status).toBe(200);
  });
});

describe('🔒 POST /api/v1/internal/workspace/egress-allowlist — security + validazione', () => {
  function post(headers: Record<string, string>, body: string) {
    return buildApp().request('/api/v1/internal/workspace/egress-allowlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  it('🔒 SENZA token → 401, setEgressAllowlist NON chiamato (autorizzazione privilegiata)', async () => {
    const res = await post({}, JSON.stringify({ hosts: 'erp.internal' }));
    expect(res.status).toBe(401);
    expect(m.setEgress).not.toHaveBeenCalled();
  });

  it('🔒 token errato (stessa lunghezza) → 401', async () => {
    const res = await post({ 'x-internal-token': 'X'.repeat(TOKEN.length) }, JSON.stringify({ hosts: 'erp.internal' }));
    expect(res.status).toBe(401);
    expect(m.setEgress).not.toHaveBeenCalled();
  });

  it('🚨 body senza hosts string → 400, NON chiamato', async () => {
    const res = await post({ 'x-internal-token': TOKEN }, JSON.stringify({ hosts: 123 }));
    expect(res.status).toBe(400);
    expect(m.setEgress).not.toHaveBeenCalled();
  });

  it('token valido + hosts CSV → 200, setEgressAllowlist chiamato con la CSV', async () => {
    const res = await post({ 'x-internal-token': TOKEN }, JSON.stringify({ hosts: 'erp.internal,*.svc.cluster.local' }));
    expect(res.status).toBe(200);
    expect(m.setEgress).toHaveBeenCalledWith('erp.internal,*.svc.cluster.local');
  });

  it('token valido + hosts vuoto (svuotamento) → 200, chiamato con stringa vuota', async () => {
    const res = await post({ 'x-internal-token': TOKEN }, JSON.stringify({ hosts: '' }));
    expect(res.status).toBe(200);
    expect(m.setEgress).toHaveBeenCalledWith('');
  });
});

// ── F3 (2026-07-06): propagazione revoca identità portal→runtime ──────────
describe('POST /api/v1/internal/workspace/user-revoked', () => {
  function postRevoke(headers: Record<string, string>, body: string) {
    return buildApp().request('/api/v1/internal/workspace/user-revoked', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  beforeEach(() => {
    m.revokeWorkspaceUser.mockReturnValue({ found: true, sessionsRevoked: true, piiScrubbed: false });
  });

  it('🔒 SENZA token → 401, revokeWorkspaceUser NON chiamato (endpoint privilegiato)', async () => {
    const res = await postRevoke({}, JSON.stringify({ email: 'a@b.it' }));
    expect(res.status).toBe(401);
    expect(m.revokeWorkspaceUser).not.toHaveBeenCalled();
  });

  it('🔒 token sbagliato (stessa lunghezza) → 401', async () => {
    const res = await postRevoke({ 'x-internal-token': 'X'.repeat(TOKEN.length) }, JSON.stringify({ email: 'a@b.it' }));
    expect(res.status).toBe(401);
    expect(m.revokeWorkspaceUser).not.toHaveBeenCalled();
  });

  it('email mancante → 400, servizio NON invocato', async () => {
    const res = await postRevoke({ 'x-internal-token': TOKEN }, JSON.stringify({ scrubPii: true }));
    expect(res.status).toBe(400);
    expect(m.revokeWorkspaceUser).not.toHaveBeenCalled();
  });

  it('email vuota → 400', async () => {
    const res = await postRevoke({ 'x-internal-token': TOKEN }, JSON.stringify({ email: '' }));
    expect(res.status).toBe(400);
  });

  it('body non-JSON → 400 (no crash)', async () => {
    const res = await postRevoke({ 'x-internal-token': TOKEN }, 'not-json');
    expect(res.status).toBe(400);
  });

  it('token valido + email → 200, revokeWorkspaceUser chiamato (scrubPii default false)', async () => {
    const res = await postRevoke({ 'x-internal-token': TOKEN }, JSON.stringify({ email: 'mario@acme.it' }));
    expect(res.status).toBe(200);
    expect(m.revokeWorkspaceUser).toHaveBeenCalledWith({ email: 'mario@acme.it', scrubPii: false });
    expect(await res.json()).toMatchObject({ ok: true, found: true, sessionsRevoked: true });
  });

  it('🚨 scrubPii=true propagato al servizio (rimozione/anonimizzazione)', async () => {
    m.revokeWorkspaceUser.mockReturnValueOnce({ found: true, sessionsRevoked: true, piiScrubbed: true });
    const res = await postRevoke({ 'x-internal-token': TOKEN }, JSON.stringify({ email: 'gdpr@acme.it', scrubPii: true }));
    expect(res.status).toBe(200);
    expect(m.revokeWorkspaceUser).toHaveBeenCalledWith({ email: 'gdpr@acme.it', scrubPii: true });
    expect(await res.json()).toMatchObject({ piiScrubbed: true });
  });

  it('scrubPii non-boolean (truthy string) → trattato come false (type-strict)', async () => {
    await postRevoke({ 'x-internal-token': TOKEN }, JSON.stringify({ email: 'x@y.it', scrubPii: 'yes' }));
    expect(m.revokeWorkspaceUser).toHaveBeenCalledWith({ email: 'x@y.it', scrubPii: false });
  });
});
