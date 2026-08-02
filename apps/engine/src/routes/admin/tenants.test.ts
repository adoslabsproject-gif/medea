/**
 * Test 2026-grade — admin/tenants routes (10 endpoint multi-tenant CRUD).
 *
 * Coverage REALE:
 *  - GET /admin/stats: forward AdminStatsService.instance()
 *  - GET /admin/tenants: status/plan filter, include=stats merge, paginazione
 *  - GET /admin/tenants/:id: 404 TenantNotFoundError
 *  - GET /admin/tenants/:id/dashboard: 404 + stats merge
 *  - POST /admin/tenants: zod 400 slug invalido, password<12 → 400, 409 conflict,
 *    atomicita\` transaction (rollback su throw), audit log emesso DOPO commit,
 *    owner user inserito role=owner, passwordHash != plaintext, 201 con shape
 *  - PATCH: 404, undefined skipped (no overwrite)
 *  - suspend/activate/archive/delete: 404 + zod (reason min 3 char) +
 *    🚨 SECURITY: DELETE 'default' rifiutato (system tenant protezione)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => {
  class TenantNotFoundError extends Error { override name = 'TenantNotFoundError'; }
  class TenantSlugConflictError extends Error { override name = 'TenantSlugConflictError'; }
  return {
    instance: vi.fn(),
    tenants: vi.fn(),
    tenantDashboard: vi.fn(),
    // tenantService
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    suspend: vi.fn(),
    activate: vi.fn(),
    archive: vi.fn(),
    softDelete: vi.fn(),
    // db
    sqliteRun: vi.fn(),
    txn: vi.fn(),
    // audit + hash
    auditAppend: vi.fn(),
    hashPassword: vi.fn(),
    nanoid: vi.fn(),
    TenantNotFoundError,
    TenantSlugConflictError,
  };
});
const { TenantNotFoundError, TenantSlugConflictError } = m;

vi.mock('@/services/admin-stats.service.js', () => ({
  AdminStatsService: class {
    instance() { return m.instance(); }
    tenants() { return m.tenants(); }
    tenantDashboard(id: string) { return m.tenantDashboard(id); }
  },
}));

vi.mock('@/services/tenant.service.js', () => ({
  TenantNotFoundError: m.TenantNotFoundError,
  TenantSlugConflictError: m.TenantSlugConflictError,
  tenantService: {
    list: (opts: unknown) => m.list(opts),
    get: (id: string) => m.get(id),
    create: (input: unknown, actor: string | undefined) => m.create(input, actor),
    update: (id: string, patch: unknown, actor: string | undefined) => m.update(id, patch, actor),
    suspend: (id: string, reason: string, actor: string | undefined) => m.suspend(id, reason, actor),
    activate: (id: string, actor: string | undefined) => m.activate(id, actor),
    archive: (id: string, reason: string, actor: string | undefined) => m.archive(id, reason, actor),
    softDelete: (id: string, reason: string, actor: string | undefined) => m.softDelete(id, reason, actor),
  },
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      transaction: (fn: () => unknown) => () => {
        m.txn();
        return fn();
      },
      prepare: () => ({ run: (...args: unknown[]) => m.sqliteRun(args) }),
    },
  }),
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append(args: unknown) { return m.auditAppend(args); }
  },
}));

vi.mock('@medea/engine-auth-local', () => ({
  hashPassword: (pw: string) => m.hashPassword(pw),
}));

vi.mock('nanoid', () => ({
  nanoid: () => m.nanoid(),
}));

vi.mock('@/lib/logger.js');

import { registerTenantsRoutes } from './tenants.js';

import type { AuthContext } from '@/middleware/auth.js';

function buildApp(auth: AuthContext | null = {
  userId: 'admin-1', email: 'admin@x', role: 'superadmin', tenantId: 'platform',
} as AuthContext): Hono {
  const app = new Hono();
  if (auth) {
    app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  }
  registerTenantsRoutes(app);
  return app;
}

beforeEach(() => {
  Object.values(m).forEach((fn) => { if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset(); });
  m.hashPassword.mockResolvedValue('HASHED-PW');
  m.nanoid.mockReturnValue('user-new-id');
  m.auditAppend.mockResolvedValue(undefined);
});

describe('GET /admin/stats', () => {
  it('ritorna { instance: AdminStatsService.instance() }', async () => {
    m.instance.mockReturnValue({ tenants: 3, users: 12, workflows: 7 });
    const res = await buildApp().request('/admin/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instance: { tenants: 3, users: 12, workflows: 7 } });
  });
});

describe('GET /admin/tenants', () => {
  it('default: nessun filtro, limit=50 offset=0', async () => {
    m.list.mockReturnValue({ tenants: [{ id: 't1' }], total: 1 });
    const res = await buildApp().request('/admin/tenants');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenants: [{ id: 't1' }], total: 1, limit: 50, offset: 0 });
    expect(m.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it('filtra status=active + plan=pro', async () => {
    m.list.mockReturnValue({ tenants: [], total: 0 });
    await buildApp().request('/admin/tenants?status=active&plan=pro');
    expect(m.list).toHaveBeenCalledWith({ limit: 50, offset: 0, status: 'active', plan: 'pro' });
  });

  it('status="all" supportato (esplicito)', async () => {
    m.list.mockReturnValue({ tenants: [], total: 0 });
    await buildApp().request('/admin/tenants?status=all');
    expect(m.list.mock.calls[0]![0]).toMatchObject({ status: 'all' });
  });

  it('🚨 status invalido (es. "deleted") → NON inviato a tenantService (filtro silente)', async () => {
    m.list.mockReturnValue({ tenants: [], total: 0 });
    await buildApp().request('/admin/tenants?status=deleted');
    const args = m.list.mock.calls[0]![0] as { status?: string };
    expect(args.status).toBeUndefined();
  });

  it('plan invalido scartato', async () => {
    m.list.mockReturnValue({ tenants: [], total: 0 });
    await buildApp().request('/admin/tenants?plan=evil');
    const args = m.list.mock.calls[0]![0] as { plan?: string };
    expect(args.plan).toBeUndefined();
  });

  it('limit/offset custom', async () => {
    m.list.mockReturnValue({ tenants: [], total: 0 });
    await buildApp().request('/admin/tenants?limit=10&offset=20');
    expect(m.list).toHaveBeenCalledWith({ limit: 10, offset: 20 });
  });

  it('include=stats → merge stats per tenantId', async () => {
    m.list.mockReturnValue({ tenants: [{ id: 't1', plan: 'pro' }, { id: 't2', plan: 'free' }], total: 2 });
    m.tenants.mockReturnValue([
      { tenantId: 't1', userCount: 5, workflowCount: 3, activeWorkflows: 2, runsLast24h: 10, errorsLast24h: 0 },
    ]);
    const res = await buildApp().request('/admin/tenants?include=stats');
    const body = await res.json() as { tenants: { id: string; stats: unknown }[] };
    expect(body.tenants[0]!.stats).toMatchObject({ userCount: 5, runsLast24h: 10 });
    expect(body.tenants[1]!.stats).toBeNull(); // tenant senza stats
  });
});

describe('GET /admin/tenants/:tenantId', () => {
  it('happy path', async () => {
    m.get.mockReturnValue({ id: 't1', plan: 'pro' });
    const res = await buildApp().request('/admin/tenants/t1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: { id: 't1', plan: 'pro' } });
  });

  it('TenantNotFoundError → 404 con error message', async () => {
    m.get.mockImplementation(() => { throw new TenantNotFoundError('Tenant non trovato: "missing"'); });
    const res = await buildApp().request('/admin/tenants/missing');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain('non trovato');
  });

  it('errore inatteso rilanciato (NON 404)', async () => {
    m.get.mockImplementation(() => { throw new Error('db down'); });
    const res = await buildApp().request('/admin/tenants/t1');
    expect(res.status).toBe(500);
  });
});

describe('GET /admin/tenants/:tenantId/dashboard', () => {
  it('merge tenant + dashboard', async () => {
    m.get.mockReturnValue({ id: 't1' });
    m.tenantDashboard.mockReturnValue({ workflows: 5, runsLast24h: 0 });
    const res = await buildApp().request('/admin/tenants/t1/dashboard');
    const body = await res.json() as Record<string, unknown>;
    expect(body.tenantId).toBe('t1');
    expect(body.tenant).toEqual({ id: 't1' });
    expect(body.workflows).toBe(5);
  });

  it('404 se tenant non esiste', async () => {
    m.get.mockImplementation(() => { throw new TenantNotFoundError('nope'); });
    const res = await buildApp().request('/admin/tenants/nope/dashboard');
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/tenants — provision atomic + audit', () => {
  const validBody = {
    tenantSlug: 'acme-corp',
    ownerEmail: 'owner@acme.com',
    ownerName: 'Alice',
    ownerPassword: 'StrongPass2026!!',
  };

  it('happy path → 201 con tenant + owner + audit + transaction', async () => {
    m.create.mockReturnValue({ id: 'acme-corp', plan: 'enterprise' });
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; tenant: { plan: string }; owner: { email: string; displayName: string } };
    expect(body.ok).toBe(true);
    expect(body.tenant.plan).toBe('enterprise');
    expect(body.owner.email).toBe('owner@acme.com');
    expect(body.owner.displayName).toBe('Alice');

    // transaction wrapper invocato
    expect(m.txn).toHaveBeenCalledTimes(1);
    // tenantService.create chiamato con slug + actor
    expect(m.create).toHaveBeenCalledTimes(1);
    expect((m.create.mock.calls[0]![0] as { slug: string }).slug).toBe('acme-corp');
    expect(m.create.mock.calls[0]![1]).toBe('admin-1');
    // owner user insert (sqlite.prepare().run(...))
    expect(m.sqliteRun).toHaveBeenCalledTimes(1);
    const runArgs = m.sqliteRun.mock.calls[0]![0] as unknown[];
    expect(runArgs).toContain('owner@acme.com');
    expect(runArgs).toContain('owner');
    expect(runArgs).toContain('HASHED-PW');
    // password plaintext NON in run args (security)
    expect(runArgs).not.toContain('StrongPass2026!!');
    // audit DOPO commit (await)
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    expect(m.auditAppend.mock.calls[0]![0]).toMatchObject({
      tenantId: 'acme-corp',
      action: 'tenant.provision',
      resourceType: 'tenant',
    });
  });

  it('zod 400 — slug invalido (uppercase)', async () => {
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, tenantSlug: 'ACME' }),
    });
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('zod 400 — slug troppo corto', async () => {
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, tenantSlug: 'ab' }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 — password < 12 char', async () => {
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerPassword: 'short' }),
    });
    expect(res.status).toBe(400);
    expect(m.hashPassword).not.toHaveBeenCalled();
  });

  it('zod 400 — email invalida', async () => {
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, ownerEmail: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('TenantSlugConflictError → 409', async () => {
    m.create.mockImplementation(() => { throw new TenantSlugConflictError('Slug "acme-corp" già in uso'); });
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain('già in uso');
    // 🚨 audit NON emesso (transazione fallita)
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('errore generico in txn → 500 + NO audit (rollback)', async () => {
    m.create.mockImplementation(() => { throw new Error('db error'); });
    const res = await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(500);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('displayName default = tenantSlug', async () => {
    m.create.mockReturnValue({ id: 'acme-corp', plan: 'enterprise' });
    await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect((m.create.mock.calls[0]![0] as { displayName: string }).displayName).toBe('acme-corp');
  });

  it('displayName custom passato a service', async () => {
    m.create.mockReturnValue({ id: 'acme-corp', plan: 'enterprise' });
    await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validBody, displayName: 'ACME Corp Ltd' }),
    });
    expect((m.create.mock.calls[0]![0] as { displayName: string }).displayName).toBe('ACME Corp Ltd');
  });

  it('campi opzionali undefined NON inviati (spread condizionale)', async () => {
    m.create.mockReturnValue({ id: 'acme-corp', plan: 'enterprise' });
    await buildApp().request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const input = m.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('vatNumber');
    expect(input).not.toHaveProperty('billingEmail');
    expect(input).not.toHaveProperty('plan');
  });

  it('auth assente → actor undefined in service', async () => {
    m.create.mockReturnValue({ id: 'acme-corp', plan: 'enterprise' });
    const app = new Hono();
    registerTenantsRoutes(app);
    await app.request('/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(m.create.mock.calls[0]![1]).toBeUndefined();
  });
});

describe('PATCH /admin/tenants/:tenantId', () => {
  it('happy path', async () => {
    m.update.mockReturnValue({ id: 't1', plan: 'pro' });
    const res = await buildApp().request('/admin/tenants/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro', displayName: 'New Name' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: { id: 't1', plan: 'pro' } });
    const patch = m.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.plan).toBe('pro');
    expect(patch.displayName).toBe('New Name');
  });

  it('undefined valori NON copiati nel patch (no overwrite con undefined)', async () => {
    m.update.mockReturnValue({ id: 't1' });
    await buildApp().request('/admin/tenants/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    const patch = m.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['displayName']);
  });

  it('null preservato (clear field GDPR)', async () => {
    m.update.mockReturnValue({ id: 't1' });
    await buildApp().request('/admin/tenants/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vatNumber: null }),
    });
    const patch = m.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.vatNumber).toBeNull();
  });

  it('404 TenantNotFoundError', async () => {
    m.update.mockImplementation(() => { throw new TenantNotFoundError('Tenant non trovato'); });
    const res = await buildApp().request('/admin/tenants/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('zod 400 — plan invalido', async () => {
    const res = await buildApp().request('/admin/tenants/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'platinum' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/tenants/:tenantId/suspend', () => {
  it('happy path', async () => {
    m.suspend.mockReturnValue({ id: 't1', status: 'suspended' });
    const res = await buildApp().request('/admin/tenants/t1/suspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'TOS violation: spam' }),
    });
    expect(res.status).toBe(200);
    expect(m.suspend).toHaveBeenCalledWith('t1', 'TOS violation: spam', 'admin-1');
  });

  it('zod 400 — reason < 3 char (required minimum)', async () => {
    const res = await buildApp().request('/admin/tenants/t1/suspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no' }),
    });
    expect(res.status).toBe(400);
    expect(m.suspend).not.toHaveBeenCalled();
  });

  it('zod 400 — reason mancante', async () => {
    const res = await buildApp().request('/admin/tenants/t1/suspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('404 quando tenant non esiste', async () => {
    m.suspend.mockImplementation(() => { throw new TenantNotFoundError('nope'); });
    const res = await buildApp().request('/admin/tenants/nope/suspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'GDPR request' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/tenants/:tenantId/activate', () => {
  it('happy path', async () => {
    m.activate.mockReturnValue({ id: 't1', status: 'active' });
    const res = await buildApp().request('/admin/tenants/t1/activate', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(m.activate).toHaveBeenCalledWith('t1', 'admin-1');
  });

  it('404 TenantNotFoundError', async () => {
    m.activate.mockImplementation(() => { throw new TenantNotFoundError('nope'); });
    const res = await buildApp().request('/admin/tenants/nope/activate', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/tenants/:tenantId/archive', () => {
  const withReason = (reason = 'contract ended, no renewal') => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });

  it('happy path — reason passato al service (audit #5)', async () => {
    m.archive.mockReturnValue({ id: 't1', status: 'archived' });
    const res = await buildApp().request('/admin/tenants/t1/archive', withReason());
    expect(res.status).toBe(200);
    expect(m.archive).toHaveBeenCalledWith('t1', 'contract ended, no renewal', 'admin-1');
  });

  it('🚨 reason mancante → 400 (obbligatorio) e service NON chiamato', async () => {
    const res = await buildApp().request('/admin/tenants/t1/archive', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(m.archive).not.toHaveBeenCalled();
  });

  it('🚨 reason < 3 char → 400', async () => {
    const res = await buildApp().request('/admin/tenants/t1/archive', withReason('no'));
    expect(res.status).toBe(400);
    expect(m.archive).not.toHaveBeenCalled();
  });

  it('404', async () => {
    m.archive.mockImplementation(() => { throw new TenantNotFoundError('x'); });
    const res = await buildApp().request('/admin/tenants/x/archive', withReason());
    expect(res.status).toBe(404);
  });
});

describe('DELETE /admin/tenants/:tenantId — soft delete + protezione "default"', () => {
  const withReason = (reason = 'GDPR erasure request, art.17') => ({
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });

  it('happy path soft-delete — reason passato al service (audit #5)', async () => {
    m.softDelete.mockReturnValue(undefined);
    const res = await buildApp().request('/admin/tenants/t1', withReason());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.softDelete).toHaveBeenCalledWith('t1', 'GDPR erasure request, art.17', 'admin-1');
  });

  it('🚨 reason mancante → 400 e service NON chiamato', async () => {
    const res = await buildApp().request('/admin/tenants/t1', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(m.softDelete).not.toHaveBeenCalled();
  });

  it('🚨 tenant "default" → 400 non eliminabile (sistema) — anche con reason valida', async () => {
    const res = await buildApp().request('/admin/tenants/default', withReason());
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('sistema');
    expect(m.softDelete).not.toHaveBeenCalled();
  });

  it('404 TenantNotFoundError', async () => {
    m.softDelete.mockImplementation(() => { throw new TenantNotFoundError('nope'); });
    const res = await buildApp().request('/admin/tenants/nope', withReason());
    expect(res.status).toBe(404);
  });

  it('errore generico rilanciato', async () => {
    m.softDelete.mockImplementation(() => { throw new Error('db lock'); });
    const res = await buildApp().request('/admin/tenants/t1', withReason());
    expect(res.status).toBe(500);
  });
});
