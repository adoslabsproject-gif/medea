/**
 * Tests runtime auth routes (#203 P0-4, #204 P0-5).
 *
 * Coverage:
 *  - P0-4: /auth/bootstrap NON ritorna `token` nel body (solo `user`)
 *  - P0-4: /auth/bootstrap senza cookie ff_session → 401
 *  - P0-5: container-mode (MEDEA_TENANT_ID set) → /auth/register 403
 *  - P0-5: container-mode → /auth/signup 403 anche con MEDEA_ALLOW_SIGNUP=1
 *  - non-container-mode: /auth/register passa il container gate (resta blocked
 *    da altri gate, ma il CONTAINER_MODE_NO_REGISTER NON appare)
 *  - /auth/me con auth → ritorna user
 *  - /auth/status pubblico → JSON ok
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  sqliteAll: vi.fn(),
  sqliteGet: vi.fn(),
  sqliteRun: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      exec: vi.fn(),
      prepare: (_sql: string) => ({
        all: () => m.sqliteAll(),
        get: (...args: unknown[]) => m.sqliteGet(...args),
        run: (...args: unknown[]) => m.sqliteRun(...args),
      }),
    },
  }),
}));

vi.mock('@medea/engine-auth-local', () => ({
  hashPassword: (...a: unknown[]) => m.hashPassword(...a),
  verifyPassword: (...a: unknown[]) => m.verifyPassword(...a),
}));

vi.mock('@/lib/license.js', () => ({
  licenseService: { getLicenseInfo: () => ({ tier: 'pro' }) },
}));

vi.mock('@/lib/logger.js');

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    async append() {
      /* noop */
    }
  },
}));

vi.mock('@/config.js', () => ({
  loadConfig: () => ({}),
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: () => 'mock.jwt.token',
    verify: () => ({ sub: 'user-1', tenantId: 'tenant-default', role: 'owner', email: 'u@x.it' }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MEDEA_TENANT_ID;
  delete process.env.MEDEA_ALLOW_SIGNUP;
});

async function buildApp(opts?: {
  authCtx?: {
    userId: string;
    role: 'owner' | 'superadmin' | 'editor' | 'operator' | 'viewer';
    email: string;
    tenantId: string;
  };
}) {
  const { createAuthRoutes } = await import('./auth.js');
  const app = new Hono();
  // Simula auth middleware globale. Role typed enum per match AuthContext schema.
  app.use('*', async (c, next) => {
    c.set('auth', opts?.authCtx ?? null);
    return next();
  });
  app.route('/api/v1', createAuthRoutes());
  return app;
}

describe('#203 P0-4: /auth/bootstrap NO echo token nel body', () => {
  it('200 con cookie + auth context → ritorna SOLO {user}, NO token', async () => {
    const app = await buildApp({
      authCtx: { userId: 'user-1', role: 'owner', email: 'u@x.it', tenantId: 'tenant-default' },
    });
    const res = await app.request('/api/v1/auth/bootstrap', {
      headers: { cookie: 'ff_session=some-jwt-cookie-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user).toBeDefined();
    // CRITICAL: token NON esposto a JS — sicurezza XSS (#203 P0-4).
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('some-jwt-cookie-token');
  });

  it('401 senza cookie ff_session anche con auth context', async () => {
    const app = await buildApp({
      authCtx: { userId: 'user-1', role: 'owner', email: 'u@x.it', tenantId: 'tenant-default' },
    });
    const res = await app.request('/api/v1/auth/bootstrap'); // no cookie header
    expect(res.status).toBe(401);
  });

  it('401 senza auth context', async () => {
    const app = await buildApp(); // no authCtx
    const res = await app.request('/api/v1/auth/bootstrap', {
      headers: { cookie: 'ff_session=valid' },
    });
    expect(res.status).toBe(401);
  });
});

describe('#204 P0-5: /auth/register block in container-per-tenant mode', () => {
  it('MEDEA_TENANT_ID set → register 403 CONTAINER_MODE_NO_REGISTER', async () => {
    process.env.MEDEA_TENANT_ID = 'tenant-customer-abc';
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'new@example.com',
        password: 'verylongpassword123',
        displayName: 'New User',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('CONTAINER_MODE_NO_REGISTER');
    // CRITICAL: nessuna insert su sqlite — utente NON creato.
    expect(m.sqliteRun).not.toHaveBeenCalled();
  });

  it('MEDEA_TENANT_ID set → register 403 anche con MEDEA_ALLOW_SIGNUP=1', async () => {
    // Container-mode VINCE su signup-allowed (defense-in-depth).
    process.env.MEDEA_TENANT_ID = 'tenant-customer-abc';
    process.env.MEDEA_ALLOW_SIGNUP = '1';
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'new@example.com',
        password: 'verylongpassword123',
        displayName: 'Bob',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('CONTAINER_MODE_NO_REGISTER');
  });

  it('MEDEA_TENANT_ID set → signup 403 CONTAINER_MODE_NO_SIGNUP', async () => {
    process.env.MEDEA_TENANT_ID = 'tenant-customer-abc';
    process.env.MEDEA_ALLOW_SIGNUP = '1';
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantSlug: 'new-tenant',
        email: 'owner@new.com',
        password: 'longpassword12345',
        displayName: 'Owner',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('CONTAINER_MODE_NO_SIGNUP');
  });

  it('NO container-mode (MEDEA_TENANT_ID unset/empty) → register NON ritorna CONTAINER_MODE_NO_REGISTER', async () => {
    // No MEDEA_TENANT_ID env → register passa il gate container.
    // Stop su altro gate (SIGNUP_DISABLED se no fresh install), ma il
    // codice "CONTAINER_MODE_*" NON deve apparire.
    delete process.env.MEDEA_TENANT_ID;
    // Simula utenti già presenti per evitare il fresh-install path.
    m.sqliteGet.mockReturnValueOnce({ c: 1 }).mockReturnValueOnce({ c: 1 });
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'default' },
      body: JSON.stringify({
        email: 'new@example.com',
        password: 'verylongpassword123',
        displayName: 'Bob',
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    expect(body.code).not.toBe('CONTAINER_MODE_NO_REGISTER');
  });

  it('MEDEA_TENANT_ID = "" (stringa vuota) NON è considerata container-mode', async () => {
    // Edge case: env settata ma vuota (.env malformed) → NON container-mode,
    // tornano i gate signup standard.
    process.env.MEDEA_TENANT_ID = '';
    m.sqliteGet.mockReturnValueOnce({ c: 1 }).mockReturnValueOnce({ c: 1 });
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'new@example.com',
        password: 'verylongpassword123',
        displayName: 'Bob',
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    expect(body.code).not.toBe('CONTAINER_MODE_NO_REGISTER');
  });
});

describe('/auth/status — public no-auth endpoint', () => {
  it('200 + JSON con userCount + needsSetup + signupAllowed', async () => {
    m.sqliteGet.mockReturnValueOnce({ c: 5 });
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userCount: number;
      needsSetup: boolean;
      signupAllowed: boolean;
    };
    expect(body.userCount).toBe(5);
    expect(body.needsSetup).toBe(false);
    expect(typeof body.signupAllowed).toBe('boolean');
  });

  it('needsSetup=true quando userCount=0', async () => {
    m.sqliteGet.mockReturnValueOnce({ c: 0 });
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/status');
    const body = (await res.json()) as { needsSetup: boolean };
    expect(body.needsSetup).toBe(true);
  });
});

describe('/auth/me — gated', () => {
  it('200 con auth context + displayName enrichment dal users table', async () => {
    m.sqliteGet.mockReturnValueOnce({ display_name: 'Mario Rossi' });
    const app = await buildApp({
      authCtx: { userId: 'user-1', role: 'owner', email: 'u@x.it', tenantId: 'tenant-default' },
    });
    const res = await app.request('/api/v1/auth/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { role: string; displayName: string | null; email: string };
    };
    expect(body.user.role).toBe('owner');
    expect(body.user.displayName).toBe('Mario Rossi');
    expect(body.user.email).toBe('u@x.it');
  });

  it("200 con displayName=null se l'utente non è ancora nel users table (es. super_admin SSO fresh)", async () => {
    m.sqliteGet.mockReturnValueOnce(undefined);
    const app = await buildApp({
      authCtx: {
        userId: 'admin-x',
        role: 'owner',
        email: 'admin@portal.it',
        tenantId: 'tenant-default',
      },
    });
    const res = await app.request('/api/v1/auth/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { displayName: string | null } };
    expect(body.user.displayName).toBeNull();
  });

  it('401 senza auth context', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('BUG FIX 2026-06-07: /auth/logout cancella ff_session (anti back-after-logout)', () => {
  it('POST → 200 + Set-Cookie cancella il cookie sessione + no-store + Clear-Site-Data', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/ff_session=/); // cancella il cookie sessione
    expect(setCookie.toLowerCase()).toMatch(/max-age=0|expires=/); // → scaduto subito
    expect(res.headers.get('cache-control')).toMatch(/no-store/); // anti-bfcache
    expect(res.headers.get('clear-site-data')).toMatch(/cookies/); // pulizia storage SPA
  });
  it('GET con Accept text/html → 302 redirect /', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/logout', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });
});
