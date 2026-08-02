/**
 * Test 2026-grade — rbac middleware.
 *
 * Coverage REALE per i 3 guard:
 *  - requireRole(minRole): viewer < operator < editor < owner < superadmin
 *  - requireTenant(tenantId): cross-tenant isolation
 *  - requireSuperAdmin(): platform-level guard
 *
 * Verifica TUTTI i path (auth assente=401, role insufficiente=403, ok=200),
 * error message ESATTO (machine + human friendly), role hierarchy matriciale.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireRole, requireTenant, requireSuperAdmin } from './rbac.js';
import type { AuthContext } from './auth.js';

type Role = NonNullable<AuthContext>['role'];

/** Helper: app con auth injected via middleware sintetico precedente. */
function appWithAuth(
  auth: AuthContext | null,
  middleware: Parameters<typeof requireRole>[0] | 'super' | { kind: 'tenant'; tenantId: string },
): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  if (middleware === 'super') {
    app.use('*', requireSuperAdmin());
  } else if (typeof middleware === 'object' && middleware.kind === 'tenant') {
    app.use('*', requireTenant(middleware.tenantId));
  } else {
    app.use('*', requireRole(middleware as Role));
  }
  app.get('/protected', (c) => c.json({ ok: true }));
  return app;
}

const fakeAuth = (role: Role, tenantId = 'tenant-1'): AuthContext =>
  ({
    userId: 'user-1',
    tenantId,
    role,
  }) as AuthContext;

describe('requireRole — 401 quando auth assente', () => {
  it('no auth context → 401 "Unauthorized"', async () => {
    const res = await appWithAuth(null, 'viewer').request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('requireRole — role hierarchy (viewer < operator < editor < owner < superadmin)', () => {
  const cases: { minRole: Role; userRole: Role; expectPass: boolean }[] = [
    // minRole=viewer accetta tutti
    { minRole: 'viewer', userRole: 'viewer', expectPass: true },
    { minRole: 'viewer', userRole: 'operator', expectPass: true },
    { minRole: 'viewer', userRole: 'editor', expectPass: true },
    { minRole: 'viewer', userRole: 'owner', expectPass: true },
    { minRole: 'viewer', userRole: 'superadmin', expectPass: true },
    // minRole=operator: viewer rejected
    { minRole: 'operator', userRole: 'viewer', expectPass: false },
    { minRole: 'operator', userRole: 'operator', expectPass: true },
    { minRole: 'operator', userRole: 'editor', expectPass: true },
    { minRole: 'operator', userRole: 'owner', expectPass: true },
    { minRole: 'operator', userRole: 'superadmin', expectPass: true },
    // minRole=editor: viewer + operator rejected
    { minRole: 'editor', userRole: 'viewer', expectPass: false },
    { minRole: 'editor', userRole: 'operator', expectPass: false },
    { minRole: 'editor', userRole: 'editor', expectPass: true },
    { minRole: 'editor', userRole: 'owner', expectPass: true },
    { minRole: 'editor', userRole: 'superadmin', expectPass: true },
    // minRole=owner: solo owner + superadmin
    { minRole: 'owner', userRole: 'viewer', expectPass: false },
    { minRole: 'owner', userRole: 'operator', expectPass: false },
    { minRole: 'owner', userRole: 'editor', expectPass: false },
    { minRole: 'owner', userRole: 'owner', expectPass: true },
    { minRole: 'owner', userRole: 'superadmin', expectPass: true },
    // minRole=superadmin: solo superadmin
    { minRole: 'superadmin', userRole: 'viewer', expectPass: false },
    { minRole: 'superadmin', userRole: 'operator', expectPass: false },
    { minRole: 'superadmin', userRole: 'editor', expectPass: false },
    { minRole: 'superadmin', userRole: 'owner', expectPass: false },
    { minRole: 'superadmin', userRole: 'superadmin', expectPass: true },
  ];

  for (const { minRole, userRole, expectPass } of cases) {
    it(`min=${minRole} user=${userRole} → ${expectPass ? 'PASS (200)' : 'BLOCK (403)'}`, async () => {
      const res = await appWithAuth(fakeAuth(userRole), minRole).request('/protected');
      if (expectPass) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } else {
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain(`requires role ${minRole} or higher`);
        expect(body.error).toContain(`you are ${userRole}`);
      }
    });
  }
});

describe('🚨 requireRole — FAIL-CLOSED su ruolo fuori union (fix gap #3 2026-06-12)', () => {
  // verifySessionToken non valida il payload con zod → un ruolo alieno
  // ('admin'/'super_admin' dal portal pre-normalizzazione, o garbage da token
  // alterato) può arrivare fino a requireRole. Pre-fix ROLE_RANK[ignoto] era
  // undefined e `undefined < rank` è false → il gate PASSAVA (fail-OPEN).
  const aliens: string[] = ['admin', 'super_admin', 'root', '', 'OWNER', 'hacker'];
  for (const alien of aliens) {
    it(`ruolo "${alien || '<vuoto>'}" su minRole owner → 403 (mai fail-open)`, async () => {
      const res = await appWithAuth(fakeAuth(alien as Role), 'owner').request('/protected');
      expect(res.status).toBe(403);
    });
    it(`ruolo "${alien || '<vuoto>'}" anche su minRole viewer (il più basso) → 403`, async () => {
      const res = await appWithAuth(fakeAuth(alien as Role), 'viewer').request('/protected');
      expect(res.status).toBe(403);
    });
  }
});

describe('requireTenant — cross-tenant isolation', () => {
  it('no auth → 401 "Unauthorized"', async () => {
    const res = await appWithAuth(null, { kind: 'tenant', tenantId: 'acme' }).request('/protected');
    expect(res.status).toBe(401);
  });

  it('auth.tenantId matcha → pass 200', async () => {
    const res = await appWithAuth(fakeAuth('viewer', 'acme'), {
      kind: 'tenant',
      tenantId: 'acme',
    }).request('/protected');
    expect(res.status).toBe(200);
  });

  it('auth.tenantId NON matcha → 403 "cross-tenant access blocked"', async () => {
    const res = await appWithAuth(fakeAuth('owner', 'acme'), {
      kind: 'tenant',
      tenantId: 'evil-corp',
    }).request('/protected');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: cross-tenant access blocked' });
  });

  it('🚨 superadmin con tenantId diverso → BLOCKED comunque (no implicit cross-tenant)', async () => {
    // requireTenant non ha esonero superadmin: anche superadmin deve essere
    // sul tenantId esatto. Cross-tenant per superadmin va via x-tenant-id
    // header gestito altrove (getTenantId helper).
    const res = await appWithAuth(fakeAuth('superadmin', 'acme'), {
      kind: 'tenant',
      tenantId: 'evil-corp',
    }).request('/protected');
    expect(res.status).toBe(403);
  });

  it('case-sensitive tenant id ("Acme" != "acme") → 403', async () => {
    const res = await appWithAuth(fakeAuth('owner', 'Acme'), {
      kind: 'tenant',
      tenantId: 'acme',
    }).request('/protected');
    expect(res.status).toBe(403);
  });
});

describe('requireSuperAdmin — platform-level guard', () => {
  it('no auth → 401 "Unauthorized"', async () => {
    const res = await appWithAuth(null, 'super').request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('viewer → 403 "Forbidden: superadmin only"', async () => {
    const res = await appWithAuth(fakeAuth('viewer'), 'super').request('/protected');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: superadmin only' });
  });

  it('owner → 403 (owner non è superadmin!)', async () => {
    // Owner ha role rank 3 ma NON è superadmin. requireSuperAdmin fa check
    // ESATTO sul role, non sul rank. Importante: tenant owner != platform owner.
    const res = await appWithAuth(fakeAuth('owner'), 'super').request('/protected');
    expect(res.status).toBe(403);
  });

  it('editor → 403', async () => {
    const res = await appWithAuth(fakeAuth('editor'), 'super').request('/protected');
    expect(res.status).toBe(403);
  });

  it('operator → 403', async () => {
    const res = await appWithAuth(fakeAuth('operator'), 'super').request('/protected');
    expect(res.status).toBe(403);
  });

  it('superadmin → pass 200', async () => {
    const res = await appWithAuth(fakeAuth('superadmin'), 'super').request('/protected');
    expect(res.status).toBe(200);
  });
});

describe('rbac — composability (chain di middleware)', () => {
  it('requireRole + requireTenant insieme: passa solo se ENTRAMBI ok', async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', fakeAuth('editor', 'acme'));
      await next();
    });
    app.use('*', requireRole('editor'));
    app.use('*', requireTenant('acme'));
    app.get('/p', (c) => c.json({ ok: true }));
    const res = await app.request('/p');
    expect(res.status).toBe(200);
  });

  it('requireRole pass MA requireTenant fail → 403 tenant', async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', fakeAuth('editor', 'acme'));
      await next();
    });
    app.use('*', requireRole('editor'));
    app.use('*', requireTenant('different'));
    app.get('/p', (c) => c.json({ ok: true }));
    const res = await app.request('/p');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: cross-tenant access blocked' });
  });

  it('requireRole fail (auth viewer su minRole editor) → 403 role, NON arriva a requireTenant', async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', fakeAuth('viewer', 'acme'));
      await next();
    });
    app.use('*', requireRole('editor'));
    app.use('*', requireTenant('acme'));
    app.get('/p', (c) => c.json({ ok: true }));
    const res = await app.request('/p');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('requires role editor');
  });
});
