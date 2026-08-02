/**
 * Bug-bounty — routes/admin/users.ts. CRUD cross-tenant degli utenti, l'UNICO
 * modo per promuovere a superadmin via UI → security-sensitive. sqlite + audit
 * mockati.
 *
 * Invarianti coperti:
 *   - enum ruolo chiuso (ruolo inventato → 400, no escalation fantasma)
 *   - 404 su utente inesistente
 *   - audit DURABILE (await) su role.change E su enabled.change (audit #2)
 *   - toggle enabled 1/0, mapping enabled→boolean
 *   - anti-lockout superadmin (audit #6): self-demote/self-disable → 403,
 *     demote/disable ULTIMO superadmin attivo → 403
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const sqliteState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  getResult: undefined as Record<string, unknown> | undefined,
  superadminCount: 5, // COUNT(*) enabled superadmins — abbondante di default
  runCalls: [] as { sql: string; args: unknown[] }[],
}));
const auditAppendMock = vi.hoisted(() => vi.fn());

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      prepare: (sql: string) => ({
        all: () => sqliteState.rows,
        // Il COUNT dei superadmin attivi e la SELECT del target usano lo stesso
        // handle: distinguiamo per SQL (il COUNT non deve tornare la user-row).
        get: () =>
          /COUNT\(\*\)/i.test(sql) ? { n: sqliteState.superadminCount } : sqliteState.getResult,
        run: (...args: unknown[]) => {
          sqliteState.runCalls.push({ sql, args });
          return { changes: 1 };
        },
      }),
    },
  }),
}));
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append = auditAppendMock;
  },
}));

import { registerUsersRoutes } from './users.js';

function buildApp(
  auth: { userId: string; email: string } | null = { userId: 'admin-1', email: 'admin@t.it' },
): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    return next();
  });
  registerUsersRoutes(app);
  return app;
}

beforeEach(() => {
  sqliteState.rows = [];
  sqliteState.getResult = undefined;
  sqliteState.superadminCount = 5;
  sqliteState.runCalls = [];
  auditAppendMock.mockReset();
  auditAppendMock.mockResolvedValue(undefined);
});

const patch = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const updateEnabledCall = () =>
  sqliteState.runCalls.find((c) => c.sql.includes('UPDATE users SET enabled'));
const updateRoleCall = () =>
  sqliteState.runCalls.find((c) => c.sql.includes('UPDATE users SET role'));

describe('GET /admin/users', () => {
  it('mappa le righe DB → camelCase + enabled INTERO→boolean', async () => {
    sqliteState.rows = [
      {
        id: 'u1',
        tenant_id: 'ta',
        email: 'a@x.it',
        display_name: 'A',
        role: 'owner',
        enabled: 1,
        created_at: 't',
        last_login_at: null,
      },
      {
        id: 'u2',
        tenant_id: 'tb',
        email: 'b@x.it',
        display_name: 'B',
        role: 'viewer',
        enabled: 0,
        created_at: 't',
        last_login_at: 't2',
      },
    ];
    const data = (await (await buildApp().request('/admin/users')).json()) as {
      users: { id: string; enabled: boolean; tenantId: string }[];
    };
    expect(data.users).toHaveLength(2);
    expect(data.users[0]).toMatchObject({ id: 'u1', tenantId: 'ta', enabled: true });
    expect(data.users[1]!.enabled).toBe(false);
  });
});

describe('PATCH /admin/users/:id/role — promozione (incl. superadmin)', () => {
  it('ruolo FUORI enum → 400, niente UPDATE (no escalation a ruolo fantasma)', async () => {
    const res = await patch(buildApp(), '/admin/users/u1/role', { role: 'god-mode' });
    expect(res.status).toBe(400);
    expect(sqliteState.runCalls).toHaveLength(0);
  });

  it('utente inesistente → 404, niente UPDATE né audit', async () => {
    sqliteState.getResult = undefined;
    const res = await patch(buildApp(), '/admin/users/u-ignoto/role', { role: 'owner' });
    expect(res.status).toBe(404);
    expect(sqliteState.runCalls).toHaveLength(0);
    expect(auditAppendMock).not.toHaveBeenCalled();
  });

  it('promozione a superadmin → UPDATE + audit DURABILE con from/to e actor', async () => {
    sqliteState.getResult = {
      id: 'u1',
      email: 'a@x.it',
      role: 'owner',
      tenant_id: 'ta',
      enabled: 1,
    };
    const res = await patch(
      buildApp({ userId: 'admin-1', email: 'admin@t.it' }),
      '/admin/users/u1/role',
      { role: 'superadmin' },
    );
    expect(res.status).toBe(200);
    expect(updateRoleCall()?.args[0]).toBe('superadmin');
    expect(auditAppendMock).toHaveBeenCalledTimes(1);
    const auditArg = auditAppendMock.mock.calls[0]![0] as {
      action: string;
      metadata: { from: string; to: string };
      actorId: string;
    };
    expect(auditArg.action).toBe('user.role.change');
    expect(auditArg.metadata).toMatchObject({ from: 'owner', to: 'superadmin' });
    expect(auditArg.actorId).toBe('admin-1');
  });

  it('tutti i 5 ruoli validi sono accettati (target viewer → nessun rischio lockout)', async () => {
    sqliteState.getResult = {
      id: 'u1',
      email: 'a@x.it',
      role: 'viewer',
      tenant_id: 'ta',
      enabled: 1,
    };
    for (const role of ['superadmin', 'owner', 'editor', 'operator', 'viewer']) {
      const res = await patch(buildApp(), '/admin/users/u1/role', { role });
      expect(res.status, role).toBe(200);
    }
  });

  // ── anti-lockout (audit #6) ──────────────────────────────────────────
  it('🚨 self-demote superadmin → 403 self_target, niente UPDATE né audit', async () => {
    sqliteState.getResult = {
      id: 'admin-1',
      email: 'admin@t.it',
      role: 'superadmin',
      tenant_id: 'ta',
      enabled: 1,
    };
    const res = await patch(
      buildApp({ userId: 'admin-1', email: 'admin@t.it' }),
      '/admin/users/admin-1/role',
      { role: 'owner' },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe('self_target');
    expect(updateRoleCall()).toBeUndefined();
    expect(auditAppendMock).not.toHaveBeenCalled();
  });

  it('🚨 demote ULTIMO superadmin attivo → 403 last_superadmin', async () => {
    sqliteState.getResult = {
      id: 'u1',
      email: 'a@x.it',
      role: 'superadmin',
      tenant_id: 'ta',
      enabled: 1,
    };
    sqliteState.superadminCount = 1;
    const res = await patch(buildApp(), '/admin/users/u1/role', { role: 'owner' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe('last_superadmin');
    expect(updateRoleCall()).toBeUndefined();
  });

  it('demote superadmin quando ne restano altri → 200', async () => {
    sqliteState.getResult = {
      id: 'u1',
      email: 'a@x.it',
      role: 'superadmin',
      tenant_id: 'ta',
      enabled: 1,
    };
    sqliteState.superadminCount = 2;
    const res = await patch(buildApp(), '/admin/users/u1/role', { role: 'owner' });
    expect(res.status).toBe(200);
    expect(updateRoleCall()?.args[0]).toBe('owner');
  });
});

describe('PATCH /admin/users/:id/enabled — lockout', () => {
  const viewerRow = { id: 'u1', role: 'viewer', enabled: 1, tenant_id: 'ta' };

  it('utente inesistente → 404', async () => {
    sqliteState.getResult = undefined;
    const res = await patch(buildApp(), '/admin/users/u-x/enabled', { enabled: false });
    expect(res.status).toBe(404);
    expect(updateEnabledCall()).toBeUndefined();
  });

  it('enabled:false → UPDATE con 0 + audit DURABILE (audit #2)', async () => {
    sqliteState.getResult = { ...viewerRow };
    const res = await patch(buildApp(), '/admin/users/u1/enabled', { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(updateEnabledCall()?.args[0]).toBe(0);
    // 🚨 prima NON scriveva audit — ora deve, con enabled + actor
    expect(auditAppendMock).toHaveBeenCalledTimes(1);
    const a = auditAppendMock.mock.calls[0]![0] as {
      action: string;
      metadata: { enabled: boolean };
      actorId: string;
      resourceId: string;
    };
    expect(a.action).toBe('user.enabled.change');
    expect(a.metadata.enabled).toBe(false);
    expect(a.actorId).toBe('admin-1');
    expect(a.resourceId).toBe('u1');
  });

  it('enabled:true → UPDATE con 1 + audit', async () => {
    sqliteState.getResult = { ...viewerRow, enabled: 0 };
    await patch(buildApp(), '/admin/users/u1/enabled', { enabled: true });
    expect(updateEnabledCall()?.args[0]).toBe(1);
    expect(auditAppendMock).toHaveBeenCalledTimes(1);
    expect(auditAppendMock.mock.calls[0]![0]!.metadata.enabled).toBe(true);
  });

  it('enabled non-boolean → 400 (zod), niente UPDATE', async () => {
    const res = await patch(buildApp(), '/admin/users/u1/enabled', { enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(updateEnabledCall()).toBeUndefined();
  });

  // ── anti-lockout (audit #6) ──────────────────────────────────────────
  it('🚨 self-disable superadmin → 403 self_target, niente UPDATE né audit', async () => {
    sqliteState.getResult = { id: 'admin-1', role: 'superadmin', enabled: 1, tenant_id: 'ta' };
    const res = await patch(
      buildApp({ userId: 'admin-1', email: 'admin@t.it' }),
      '/admin/users/admin-1/enabled',
      { enabled: false },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe('self_target');
    expect(updateEnabledCall()).toBeUndefined();
    expect(auditAppendMock).not.toHaveBeenCalled();
  });

  it('🚨 disable ULTIMO superadmin attivo → 403 last_superadmin', async () => {
    sqliteState.getResult = { id: 'u1', role: 'superadmin', enabled: 1, tenant_id: 'ta' };
    sqliteState.superadminCount = 1;
    const res = await patch(buildApp(), '/admin/users/u1/enabled', { enabled: false });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe('last_superadmin');
    expect(updateEnabledCall()).toBeUndefined();
  });

  it('abilitare un superadmin disabilitato è sempre permesso (non rimuovente)', async () => {
    sqliteState.getResult = { id: 'u1', role: 'superadmin', enabled: 0, tenant_id: 'ta' };
    sqliteState.superadminCount = 0;
    const res = await patch(buildApp(), '/admin/users/u1/enabled', { enabled: true });
    expect(res.status).toBe(200);
    expect(updateEnabledCall()?.args[0]).toBe(1);
  });
});
