/**
 * Test 2026-grade — SAML 2.0 SSO routes.
 *
 * 🚨 SECURITY HIGH (2026-05-29): wantAuthnResponseSigned=true + wantAssertionsSigned=true
 *   Pre-fix: MITM tra IdP e SP poteva forgiare Response unsigned con assertion
 *   legittima rubata da altra session. Test verifica entrambi sempre on.
 *
 * 🚨 AUTO-BOOTSTRAP: primo utente del tenant → role=owner, successivi → viewer.
 *   Bug = chiunque diventa owner.
 *
 * 🚨 EMAIL CLAIM: 'email' diretto o emailaddress claim AD (xmlsoap.org).
 *   No email → 400 (no user senza email).
 *
 * 🚨 NO TOKEN IN URL: session cookie HttpOnly + redirect plain (no URL leak
 *   in nginx log, browser history, Referer).
 */
import type { AuthContext } from '@/middleware/auth.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonBody } from '@/lib/test-json-body.js';

const sqliteMock = vi.hoisted(() => {
  const data: Record<string, unknown[]> = {
    saml_providers: [],
    users: [],
  };
  return {
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((...args: unknown[]) => {
        if (/COUNT.*FROM users/i.test(sql)) {
          return { c: data.users!.filter((u: unknown) => (u as Record<string, unknown>).role === 'owner').length };
        }
        if (/SELECT.*FROM saml_providers WHERE tenant_id = \? AND provider = \?/i.test(sql)) {
          const [tenantId, provider] = args;
          return data.saml_providers!.find((r: unknown) => {
            const row = r as Record<string, unknown>;
            return row.tenant_id === tenantId && row.provider === provider;
          });
        }
        if (/SELECT id, role FROM users/i.test(sql)) {
          const [tenantId, email] = args;
          return data.users!.find((u: unknown) => {
            const user = u as Record<string, unknown>;
            return user.tenant_id === tenantId && user.email === email;
          });
        }
        return undefined;
      }),
      all: vi.fn(() => data.saml_providers),
      run: vi.fn((...args: unknown[]) => {
        if (/INSERT INTO saml_providers/i.test(sql)) {
          data.saml_providers!.push({
            id: args[0], tenant_id: args[1], provider: args[2],
            entry_point: args[3], issuer: args[4], cert: args[5], callback_url: args[6],
            created_at: args[7],
          });
          return { changes: 1, lastInsertRowid: 1n };
        }
        if (/DELETE FROM saml_providers/i.test(sql)) {
          const [tenantId, provider] = args;
          const before = data.saml_providers!.length;
          data.saml_providers = data.saml_providers!.filter((r: unknown) => {
            const row = r as Record<string, unknown>;
            return !(row.tenant_id === tenantId && row.provider === provider);
          });
          return { changes: before - data.saml_providers!.length, lastInsertRowid: 0n };
        }
        if (/INSERT INTO users/i.test(sql)) {
          data.users!.push({
            id: args[0], tenant_id: args[1], email: args[2],
            display_name: args[3], role: args[5],
          });
          return { changes: 1, lastInsertRowid: 1n };
        }
        return { changes: 0, lastInsertRowid: 0n };
      }),
    })),
    _data: data,
    _reset: () => {
      data.saml_providers = [];
      data.users = [];
    },
  };
});

const samlInstanceMock = vi.hoisted(() => ({
  generateServiceProviderMetadata: vi.fn(() => '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"/>'),
  getAuthorizeUrlAsync: vi.fn(),
  validatePostResponseAsync: vi.fn(),
}));

const samlConstructorMock = vi.hoisted(() => vi.fn());

vi.mock('@node-saml/node-saml', () => ({
  SAML: samlConstructorMock,
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteMock }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/lib/auth-keys.js', () => ({
  getAuthKeys: async () => ({ privateKeyPem: 'PRIV-PEM' }),
}));

vi.mock('@medea/engine-auth-local', () => ({
  issueSessionToken: vi.fn(async () => 'session-token-jwt'),
}));

vi.mock('@/lib/session-cookie.js', () => ({
  sessionCookieName: () => 'ff_session',
}));

// Tenant resolution: admin routes use getTenantId (auth-derived, here header for
// the test harness); PUBLIC routes (metadata/login/callback) use the env-backed
// getContainerTenantId — controllable via tenantMock.container so we can prove
// the header is IGNORED on those routes.
const tenantMock = vi.hoisted(() => ({ container: 'default' }));
vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (k: string) => string | undefined } }) =>
    c.req.header('x-tenant-id') ?? 'default',
  getContainerTenantId: () => tenantMock.container,
}));

const auditMock = vi.hoisted(() => ({ append: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class { append = auditMock.append; },
}));
vi.mock('@/lib/actor.js', () => ({ getActorId: () => 'actor-test' }));

const { createSamlRoutes } = await import('./saml.js');
const { Hono } = await import('hono');

/**
 * App con auth context iniettato (gap #3 2026-06-12): POST/DELETE
 * /saml/providers sono ora requireRole('owner') — i test CRUD girano come
 * owner; i casi RBAC hanno il loro describe. role=null → nessun auth context.
 */
function appAs(role: string | null): InstanceType<typeof Hono> {
  const app = new Hono();
  if (role !== null) {
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'u-test', email: 'test@x.it', tenantId: 'default', role } as AuthContext);
      await next();
    });
  }
  app.route('/', createSamlRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqliteMock._reset();
  tenantMock.container = 'default';
  samlConstructorMock.mockImplementation(() => samlInstanceMock);
});

describe('🚨 SECURITY: buildSamlConfig wantAuthnResponseSigned', () => {
  it('🚨 entrambi i flag firma → true sempre (HIGH fix 2026-05-29)', async () => {
    const app = appAs('owner');
    // Insert un provider
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: 'https://okta.com/sso', issuer: 'urn:zeli',
      cert: 'CERT', callback_url: 'https://x.com/cb',
    });
    await app.request('/saml/okta/metadata');
    expect(samlConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      signatureAlgorithm: 'sha256',
    }));
  });
});

describe('🚨 POST /saml/providers validation', () => {
  it('🚨 body non oggetto → 400', async () => {
    const app = appAs('owner');
    const res = await app.request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify('not-object'),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 missing required fields → 400 con messaggio', async () => {
    const app = appAs('owner');
    const res = await app.request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'okta' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain('required');
  });

  it('🚨 happy path → 201 + UPSERT', async () => {
    const app = appAs('owner');
    const res = await app.request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'okta',
        entryPoint: 'https://okta.com/sso',
        issuer: 'urn:zeli',
        cert: '-----CERT-----',
        callbackUrl: 'https://x.com/cb',
      }),
    });
    expect(res.status).toBe(201);
    expect(sqliteMock._data.saml_providers).toHaveLength(1);
  });
});

describe('🚨 GET /saml/providers list — no cert leak', () => {
  it('🚨 SECURITY: response NON include cert field', async () => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: 'x', issuer: 'y', cert: 'SECRET-CERT-X', callback_url: 'z',
      created_at: '2026-01-01',
    });
    const app = appAs('owner');
    const res = await app.request('/saml/providers');
    void (await jsonBody(res));
    // sqlite SELECT non include cert in colonne (vedi codice)
    // verifico che il mock prepare sia chiamato con SELECT che omette cert
    expect(sqliteMock.prepare).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT id, provider, entry_point, issuer, callback_url, created_at FROM saml_providers/i),
    );
    expect(res.status).toBe(200);
  });
});

describe('🚨 DELETE /saml/providers/:provider', () => {
  it('🚨 removed=true se provider esiste', async () => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: '', issuer: '', cert: '', callback_url: '',
    });
    const app = appAs('owner');
    const res = await app.request('/saml/providers/okta', { method: 'DELETE' });
    const body = await jsonBody(res);
    expect(body.removed).toBe(true);
  });

  it('🚨 removed=false se non esiste', async () => {
    const app = appAs('owner');
    const res = await app.request('/saml/providers/ghost', { method: 'DELETE' });
    const body = await jsonBody(res);
    expect(body.removed).toBe(false);
  });
});

describe('🚨 GET /saml/:provider/metadata', () => {
  it('🚨 provider non configurato → 404', async () => {
    const app = appAs('owner');
    const res = await app.request('/saml/ghost/metadata');
    expect(res.status).toBe(404);
  });

  it('🚨 happy → XML response Content-Type application/xml', async () => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: '', issuer: '', cert: '', callback_url: '',
    });
    const app = appAs('owner');
    const res = await app.request('/saml/okta/metadata');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('EntityDescriptor');
  });
});

describe('🚨 GET /saml/:provider/login redirect', () => {
  it('🚨 provider non configurato → 404', async () => {
    const app = appAs('owner');
    const res = await app.request('/saml/ghost/login');
    expect(res.status).toBe(404);
  });

  it('🚨 happy → 302 redirect a IdP', async () => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: 'https://okta/sso', issuer: '', cert: '', callback_url: '',
    });
    samlInstanceMock.getAuthorizeUrlAsync.mockResolvedValueOnce('https://okta/sso?SAMLRequest=...');
    const app = appAs('owner');
    const res = await app.request('/saml/okta/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('okta/sso');
  });

  it('🚨 SAML error → 500 + log', async () => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: '', issuer: '', cert: '', callback_url: '',
    });
    samlInstanceMock.getAuthorizeUrlAsync.mockRejectedValueOnce(new Error('IdP unreachable'));
    const app = appAs('owner');
    const res = await app.request('/saml/okta/login');
    expect(res.status).toBe(500);
  });
});

describe('🚨 POST /saml/:provider/callback', () => {
  beforeEach(() => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: '', issuer: '', cert: '', callback_url: '',
    });
  });

  function formBody(samlResponse: string) {
    const fd = new FormData();
    fd.append('SAMLResponse', samlResponse);
    return fd;
  }

  it('🚨 SAMLResponse mancante → 400', async () => {
    const app = appAs('owner');
    const fd = new FormData();
    const res = await app.request('/saml/okta/callback', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain('Missing SAMLResponse');
  });

  it('🚨 SAML profile vuoto → 400', async () => {
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({ profile: null });
    const app = appAs('owner');
    const res = await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64-RESPONSE'),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 No email claim → 400 (no user senza email)', async () => {
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { displayName: 'Mario' },
    });
    const app = appAs('owner');
    const res = await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64'),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error).toContain('email');
  });

  it('🚨 email da emailaddress claim AD (xmlsoap.org) fallback', async () => {
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'mario@ad.com',
      },
    });
    const app = appAs('owner');
    const res = await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64'),
    });
    expect(res.status).toBe(302); // redirect to editor
    expect(sqliteMock._data.users).toHaveLength(1);
  });

  it('🚨 AUTO-BOOTSTRAP: primo user → role=owner', async () => {
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { email: 'first@x.com' },
    });
    const app = appAs('owner');
    await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64'),
    });
    expect((sqliteMock._data.users![0] as Record<string, unknown>).role).toBe('owner');
  });

  it('🚨 AUTO-BOOTSTRAP: secondo user → role=viewer (non owner)', async () => {
    // Pre-popola un owner
    sqliteMock._data.users!.push({
      tenant_id: 'default', email: 'first@x.com', role: 'owner',
    });
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { email: 'second@x.com' },
    });
    const app = appAs('owner');
    await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64'),
    });
    const second = sqliteMock._data.users!.find((u: unknown) =>
      (u as Record<string, unknown>).email === 'second@x.com',
    ) as Record<string, unknown> | undefined;
    expect(second?.role).toBe('viewer');
  });

  it('🚨 SECURITY: NO token in URL (only cookie + plain redirect)', async () => {
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { email: 'safe@x.com' },
    });
    const app = appAs('owner');
    const res = await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64'),
    });
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain('token');
    expect(loc).not.toContain('SESSION');
    expect(loc).not.toContain('jwt');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('ff_session');
    expect(setCookie.toLowerCase()).toContain('httponly');
  });

  it('🚨 SAML validation error → 500', async () => {
    samlInstanceMock.validatePostResponseAsync.mockRejectedValueOnce(
      new Error('Invalid signature'),
    );
    const app = appAs('owner');
    const res = await app.request('/saml/okta/callback', {
      method: 'POST', body: formBody('B64'),
    });
    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.error).toContain('Invalid signature');
  });
});

describe('🚨🚨 F1 FIX — PUBLIC routes resolve tenant from container env, NOT header', () => {
  // These tests pin the 2026-06-10 fix. On the OLD code (tenant = header
  // `x-tenant-id` ?? 'default') every one of them FAILS:
  //   • the IdP POST carries no x-tenant-id → 'default' → provider stored under
  //     the real UUID is missed → 404 (SSO broken in container mode);
  //   • a malicious x-tenant-id could steer which tenant's provider is used and
  //     which tenant the minted session belongs to (spoofing).

  const REAL_TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function seedProviderUnder(tenant: string): void {
    sqliteMock._data.saml_providers!.push({
      id: 'p-real', tenant_id: tenant, provider: 'okta',
      entry_point: 'https://okta/sso', issuer: 'urn:zeli',
      cert: 'CERT', callback_url: 'https://x.com/cb',
    });
  }

  it('🚨 REGRESSION: provider registrato sotto il tenant UUID reale → /metadata lo TROVA in container mode (era 404)', async () => {
    seedProviderUnder(REAL_TENANT);
    tenantMock.container = REAL_TENANT; // env del container = tenant reale
    const app = appAs('owner');
    // Nessun header x-tenant-id (come la POST reale dell'IdP / il browser).
    const res = await app.request('/saml/okta/metadata');
    expect(res.status).toBe(200); // OLD code: 'default' → 404
    expect(res.headers.get('content-type')).toContain('application/xml');
  });

  it('🚨 SPOOF: header x-tenant-id malevolo IGNORATO su /metadata (usa env)', async () => {
    seedProviderUnder(REAL_TENANT);
    tenantMock.container = REAL_TENANT;
    const app = appAs('owner');
    const res = await app.request('/saml/okta/metadata', {
      headers: { 'x-tenant-id': 'attacker-tenant' },
    });
    // Risolve sotto REAL_TENANT (env), non sotto 'attacker-tenant' → trova il provider.
    expect(res.status).toBe(200);
  });

  it('🚨 SPOOF: /login ignora header, redirect costruito col provider del tenant env', async () => {
    seedProviderUnder(REAL_TENANT);
    tenantMock.container = REAL_TENANT;
    samlInstanceMock.getAuthorizeUrlAsync.mockResolvedValueOnce('https://okta/sso?SAMLRequest=xyz');
    const app = appAs('owner');
    const res = await app.request('/saml/okta/login', {
      headers: { 'x-tenant-id': 'attacker-tenant' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('okta/sso');
  });

  it('🚨🚨 SPOOF-CRITICAL: la sessione coniata nel /callback eredita il tenant ENV, non l\'header', async () => {
    seedProviderUnder(REAL_TENANT);
    tenantMock.container = REAL_TENANT;
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { email: 'sso-user@corp.com' },
    });
    const app = appAs('owner');
    const res = await app.request('/saml/okta/callback', {
      method: 'POST',
      headers: { 'x-tenant-id': 'attacker-tenant' },
      body: formBody('B64'),
    });
    expect(res.status).toBe(302);
    // L'utente creato DEVE stare sotto REAL_TENANT, mai sotto l'header attacker.
    const created = sqliteMock._data.users!.find((u: unknown) =>
      (u as Record<string, unknown>).email === 'sso-user@corp.com',
    ) as Record<string, unknown> | undefined;
    expect(created).toBeDefined();
    expect(created?.tenant_id).toBe(REAL_TENANT);
    expect(created?.tenant_id).not.toBe('attacker-tenant');
  });

  it('🚨 REGRESSION: container env="default" (dev) + provider sotto UUID → 404 atteso (no provider per quel tenant)', async () => {
    // Conferma che la risoluzione è davvero per-tenant: se l'env NON è il tenant
    // del provider, NON deve trovarlo (no leak cross-tenant accidentale).
    seedProviderUnder(REAL_TENANT);
    tenantMock.container = 'default';
    const app = appAs('owner');
    const res = await app.request('/saml/okta/metadata');
    expect(res.status).toBe(404);
  });

  function formBody(samlResponse: string): FormData {
    const fd = new FormData();
    fd.append('SAMLResponse', samlResponse);
    return fd;
  }
});

describe('🚨🚨 F1-B — ADMIN routes /saml/providers usano il tenant del container, header IGNORATO', () => {
  // Garanzia STRUTTURALE: provider creato sotto il tenant del container ⇒ il
  // callback (anch'esso getContainerTenantId) lo ritrova SEMPRE. Niente più
  // dipendenza dall'invariante runtime auth.tenantId==env: header impersonation
  // non può salvare un provider "orfano" che il callback non troverebbe.

  it('🚨 POST /saml/providers: header x-tenant-id IGNORATO, provider salvato sotto il tenant ENV', async () => {
    tenantMock.container = 'real-container-tenant';
    const app = appAs('owner');
    const res = await app.request('/saml/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'attacker-tenant' },
      body: JSON.stringify({
        provider: 'okta', entryPoint: 'https://okta/sso', issuer: 'urn:zeli',
        cert: '-----CERT-----', callbackUrl: 'https://x/cb',
      }),
    });
    expect(res.status).toBe(201);
    const row = sqliteMock._data.saml_providers!.find((r: unknown) =>
      (r as Record<string, unknown>).provider === 'okta',
    ) as Record<string, unknown> | undefined;
    expect(row?.tenant_id).toBe('real-container-tenant');
    expect(row?.tenant_id).not.toBe('attacker-tenant');
  });

  it('🚨 POST providers + GET providers + callback: catena coerente sotto lo stesso tenant ENV', async () => {
    tenantMock.container = 'real-container-tenant';
    const app = appAs('owner');
    // 1) admin crea il provider (header attacker presente → deve essere ignorato)
    await app.request('/saml/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'attacker-tenant' },
      body: JSON.stringify({
        provider: 'okta', entryPoint: 'https://okta/sso', issuer: 'urn:zeli',
        cert: 'CERT', callbackUrl: 'https://x/cb',
      }),
    });
    // 2) il callback pubblico (stesso getContainerTenantId) lo TROVA → SSO funziona
    samlInstanceMock.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { email: 'user@corp.com' },
    });
    const fd = new FormData();
    fd.append('SAMLResponse', 'B64');
    const cb = await app.request('/saml/okta/callback', { method: 'POST', body: fd });
    expect(cb.status).toBe(302); // trovato + sessione coniata: catena coerente
  });
});

/**
 * 🚨 RBAC gap #3 masterplan (2026-06-12) — POST/DELETE providers OWNER-ONLY
 * (gemello del describe in oauth.test.ts). Pre-fix bastava authMiddleware:
 * un viewer poteva registrare un IdP SAML proprio o cancellare quello vero.
 */
describe('🚨 RBAC owner-only su POST/DELETE /saml/providers', () => {
  const validBody = JSON.stringify({
    provider: 'okta', entryPoint: 'https://okta.com/sso', issuer: 'urn:zeli',
    cert: '-----CERT-----', callbackUrl: 'https://x.com/cb',
  });

  for (const role of ['viewer', 'operator', 'editor'] as const) {
    it(`POST come ${role} → 403 e NESSUNA row scritta`, async () => {
      const res = await appAs(role).request('/saml/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: validBody,
      });
      expect(res.status).toBe(403);
      expect(sqliteMock._data.saml_providers).toHaveLength(0);
    });
  }

  it('🚨 ruolo ALIENO "admin" (vocabolario portal) → 403, NON fail-open', async () => {
    const res = await appAs('admin').request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(403);
  });

  it('nessun auth context → 401', async () => {
    const res = await appAs(null).request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(401);
  });

  it('owner → 201', async () => {
    const res = await appAs('owner').request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(201);
  });

  it('DELETE come editor → 403 e provider ANCORA presente', async () => {
    sqliteMock._data.saml_providers!.push({
      id: 'p1', tenant_id: 'default', provider: 'okta',
      entry_point: 'https://okta.com/sso', issuer: 'urn:zeli',
      cert: 'CERT', callback_url: 'https://x.com/cb',
    });
    const res = await appAs('editor').request('/saml/providers/okta', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(sqliteMock._data.saml_providers).toHaveLength(1);
  });

  it('GET providers resta accessibile a qualunque utente autenticato', async () => {
    const res = await appAs('viewer').request('/saml/providers');
    expect(res.status).toBe(200);
  });
});

describe('🔴 #6 audit log su CRUD IdP SAML (era assente)', () => {
  const validBody = {
    provider: 'okta', entryPoint: 'https://okta.com/sso', issuer: 'urn:zeli',
    cert: '-----CERT-----', callbackUrl: 'https://app/cb',
  };

  it('POST /saml/providers → audit saml_provider.upsert con actor', async () => {
    auditMock.append.mockClear();
    const res = await appAs('owner').request('/saml/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'saml_provider.upsert', resourceType: 'saml_provider', resourceId: 'okta', actorId: 'actor-test',
    }));
  });

  it('DELETE /saml/providers/:provider → audit saml_provider.remove', async () => {
    auditMock.append.mockClear();
    const res = await appAs('owner').request('/saml/providers/okta', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'saml_provider.remove', resourceType: 'saml_provider',
    }));
  });
});
