/**
 * Tests per ai-interactions.ts.
 *
 * Copre:
 *  - N4 audit (header injection bypass fix): reviewerUserId da getActorId, NON header.
 *  - RBAC (2026-06-20): export massivo + toggle consenso = owner; lettura dataset
 *    + review = editor; signals aggregati = pubblici. Mutation-verify: rimuovere
 *    un requireRole fa virare il test del ruolo-insufficiente da 403 a 200.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { _resetRateLimitState } from '@/middleware/rate-limit.js';

const m = vi.hoisted(() => ({
  updateReview: vi.fn().mockReturnValue({ id: 'i1' }),
  updateOutcome: vi.fn(),
  create: vi.fn(),
  list: vi.fn().mockReturnValue({ items: [], total: 0 }),
  get: vi.fn().mockReturnValue({ id: 'i1' }),
  getCaptureSettings: vi.fn().mockReturnValue({ captureEnabled: false, retentionDays: 90 }),
  setCapturePreference: vi.fn(),
  exportJsonl: vi.fn().mockReturnValue(''),
  getActorId: vi.fn(),
  getTenantId: vi.fn().mockReturnValue('tenant-a'),
  signalsStats: vi.fn(),
}));

vi.mock('@/services/ai-interactions.service.js', () => ({
  AIInteractionsService: class {
    updateReview = m.updateReview;
    updateOutcome = m.updateOutcome;
    create = m.create;
    list = m.list;
    get = m.get;
    getCaptureSettings = m.getCaptureSettings;
    setCapturePreference = m.setCapturePreference;
    exportJsonl = m.exportJsonl;
  },
}));

vi.mock('@/services/ai-signals.service.js', () => ({
  AISignalsService: class {
    stats = m.signalsStats;
  },
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: unknown) => m.getTenantId(c),
}));

vi.mock('@/lib/actor.js', () => ({
  getActorId: (c: unknown) => m.getActorId(c),
}));

/** Monta le route dietro un middleware che inietta un `auth` col ruolo dato
 *  (replica ciò che authMiddleware fa in produzione). role=null → nessun auth. */
async function appWithRole(role: string | null) {
  const { createAiInteractionsRoutes } = await import('./ai-interactions.js');
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role !== null) c.set('auth', { role, tenantId: 'tenant-a', userId: 'u' } as never);
    await next();
  });
  app.route('/', createAiInteractionsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitState(); // sliding-window è singleton di modulo → reset tra test
  m.updateReview.mockReturnValue({ id: 'i1' });
  m.list.mockReturnValue({ items: [], total: 0 });
  m.get.mockReturnValue({ id: 'i1' });
  m.getCaptureSettings.mockReturnValue({ captureEnabled: false, retentionDays: 90 });
  m.exportJsonl.mockReturnValue('');
});

describe('ai-interactions.ts — Track A /signals/stats (aggregati non-personali, no RBAC)', () => {
  it('🚨 GET /signals/stats → tenant-scoped, accessibile senza ruolo elevato', async () => {
    m.signalsStats.mockReturnValueOnce({
      total: 3,
      byOutcome: { pending: 3 },
      byInteractionType: { node_generate: 3 },
    });
    const app = await appWithRole('viewer');
    const res = await app.request('/signals/stats');
    expect(res.status).toBe(200);
    expect(m.signalsStats).toHaveBeenCalledWith('tenant-a');
  });
});

describe('ai-interactions.ts — N4: reviewerUserId da auth context, NON da header', () => {
  it('review path usa getActorId (auth.userId) come reviewerUserId', async () => {
    m.getActorId.mockReturnValueOnce('user-from-auth');
    const app = await appWithRole('editor');
    const res = await app.request('/i1/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'evil-from-header' },
      body: JSON.stringify({ qualityScore: 4 }),
    });
    expect(res.status).toBe(200);
    expect(m.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerUserId: 'user-from-auth' }),
    );
    expect(m.updateReview).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewerUserId: 'evil-from-header' }),
    );
  });

  it('senza actor → reviewerUserId = "anonymous" (no fallback su header)', async () => {
    m.getActorId.mockReturnValueOnce(null);
    const app = await appWithRole('editor');
    const res = await app.request('/i1/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'attacker' },
      body: JSON.stringify({ qualityScore: 4 }),
    });
    expect(res.status).toBe(200);
    expect(m.updateReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerUserId: 'anonymous' }),
    );
    expect(m.updateReview).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewerUserId: 'attacker' }),
    );
  });

  it('tenantId viene da getTenantId(c)', async () => {
    m.getActorId.mockReturnValueOnce('u1');
    m.getTenantId.mockReturnValueOnce('tenant-X');
    const app = await appWithRole('editor');
    await app.request('/i1/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qualityScore: 4 }),
    });
    expect(m.updateReview).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-X' }));
  });
});

describe('🔴 RBAC — gating per ruolo (anti-regressione: mutation rimuove requireRole → 200)', () => {
  it('🔴 export.jsonl: operator → 403, owner → 200', async () => {
    expect((await (await appWithRole('operator')).request('/export.jsonl')).status).toBe(403);
    expect((await (await appWithRole('editor')).request('/export.jsonl')).status).toBe(403);
    expect((await (await appWithRole('owner')).request('/export.jsonl')).status).toBe(200);
  });

  it('🔴 export.jsonl: senza auth → 401 (mai dataset a non autenticati)', async () => {
    expect((await (await appWithRole(null)).request('/export.jsonl')).status).toBe(401);
  });

  it('🔴 PUT /settings (toggle consenso): editor → 403, owner → 200', async () => {
    const body = JSON.stringify({ captureEnabled: true });
    const headers = { 'content-type': 'application/json' };
    expect(
      (await (await appWithRole('editor')).request('/settings', { method: 'PUT', headers, body }))
        .status,
    ).toBe(403);
    expect(
      (await (await appWithRole('owner')).request('/settings', { method: 'PUT', headers, body }))
        .status,
    ).toBe(200);
    expect(m.setCapturePreference).toHaveBeenCalledTimes(1); // solo l'owner è passato
  });

  it('🔴 lettura dataset (GET / e /:id): viewer → 403, editor → 200', async () => {
    expect((await (await appWithRole('viewer')).request('/')).status).toBe(403);
    expect((await (await appWithRole('viewer')).request('/i1')).status).toBe(403);
    expect((await (await appWithRole('editor')).request('/')).status).toBe(200);
    expect((await (await appWithRole('editor')).request('/i1')).status).toBe(200);
  });

  it('🔴 review: viewer → 403, editor → 200', async () => {
    const body = JSON.stringify({ qualityScore: 4 });
    const headers = { 'content-type': 'application/json' };
    expect(
      (await (await appWithRole('viewer')).request('/i1/review', { method: 'POST', headers, body }))
        .status,
    ).toBe(403);
    expect(
      (await (await appWithRole('editor')).request('/i1/review', { method: 'POST', headers, body }))
        .status,
    ).toBe(200);
  });

  it('🚨 export.jsonl: minQuality non-numerico → 400 (no NaN nel filtro SQL)', async () => {
    const res = await (await appWithRole('owner')).request('/export.jsonl?minQuality=INVALID');
    expect(res.status).toBe(400);
    expect(m.exportJsonl).not.toHaveBeenCalled();
  });

  it('🔴 N3 rate-limit: export.jsonl oltre 5/min/user → 429', async () => {
    const app = await appWithRole('owner');
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/export.jsonl')).status).toBe(200);
    }
    const limited = await app.request('/export.jsonl');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe('rate_limit_exceeded');
  });
});
