/**
 * Test 2026-grade — OAuth/OIDC routes runtime.
 *
 * Coverage REALE: DB SQLite :memory: vero, no mock del DB.
 * Mock: openid-client (HTTP esterno), auth-keys, session cookie, tenant resolver.
 *
 *  - GET /oauth/providers → lista senza esporre client_secret
 *  - POST /oauth/providers: 400 validation tutti i campi required + path felice + upsert
 *  - DELETE /oauth/providers/:provider → cancellazione + flag changes
 *  - GET /oauth/:provider/start: 404 not configured + happy redirect + PKCE state persistito
 *  - GET /oauth/:provider/callback: state mancante, state invalido, state scaduto,
 *    provider config mancante, email claim mancante, first user → role=owner,
 *    user esistente → preserva role + UPDATE last_login_at + oauth_provider,
 *    redirect a editorOrigin con cookie HttpOnly settato + state row eliminato
 *  - 500 su error generico (oidc.discovery throw)
 *  - Tenant isolation: provider tenant A non visibile da tenant B
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbInstances: Database.Database[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: dbInstances[0]!,
  }),
}));

const tenantIdMock = vi.hoisted(() => vi.fn());
// F1-B: le route oauth (admin CRUD + /start) ora risolvono il tenant da
// getContainerTenantId() (env del container), NON da getTenantId(c). Mock
// controllabile via containerTenantMock.value (default 'tenant-A' = stesso
// default storico di tenantIdMock → i test esistenti restano verdi).
const containerTenantMock = vi.hoisted(() => ({ value: 'tenant-A' }));
vi.mock('./../lib/tenant.js', () => ({
  getTenantId: (c: unknown) => tenantIdMock(c),
  getContainerTenantId: () => containerTenantMock.value,
}));

vi.mock('@/lib/auth-keys.js', () => ({
  getAuthKeys: vi.fn(async () => ({ privateKeyPem: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----' })),
}));

const issueSessionTokenMock = vi.hoisted(() => vi.fn());
vi.mock('@flowforge/auth-local', () => ({
  issueSessionToken: (args: unknown) => issueSessionTokenMock(args),
}));

// openid-client mock — controllo discovery + authorizationCodeGrant + buildAuthorizationUrl
const oidcMock = vi.hoisted(() => ({
  discovery: vi.fn(),
  randomPKCECodeVerifier: vi.fn(() => 'test-pkce-verifier-43-chars-1234567890abcdef'),
  buildAuthorizationUrl: vi.fn(),
  authorizationCodeGrant: vi.fn(),
}));
vi.mock('openid-client', () => oidcMock);

vi.mock('@/lib/session-cookie.js', () => ({
  sessionCookieName: () => 'ff_session',
}));

vi.mock('@/lib/logger.js');

vi.mock('nanoid', () => ({
  nanoid: () => `id-${Math.random().toString(36).slice(2, 10)}`,
}));

const auditMock = vi.hoisted(() => ({ append: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class { append = auditMock.append; },
}));
vi.mock('@/lib/actor.js', () => ({ getActorId: () => 'actor-test' }));

// #5: envelope cifrato — mock deterministico (la crypto reale è in oauth-secret.test.ts).
// encrypt produce `ct:<plaintext>`; resolve inverte (cifrato) o ritorna il legacy plaintext.
vi.mock('@/lib/oauth-secret.js', () => ({
  encryptClientSecret: (p: string) => ({ ciphertext: `ct:${p}`, nonce: 'n', authTag: 'a', dekCiphertext: 'dc', dekNonce: 'dn', dekAuthTag: 'da' }),
  resolveClientSecret: (row: { client_secret: string; client_secret_ciphertext?: string | null }) =>
    row.client_secret_ciphertext ? String(row.client_secret_ciphertext).replace(/^ct:/, '') : row.client_secret,
}));

import { Hono } from 'hono';
import { createOauthRoutes } from './oauth.js';
import type { AuthContext } from '@/middleware/auth.js';

/**
 * App con auth context iniettato (gap #3 2026-06-12): POST/DELETE
 * /oauth/providers sono ora requireRole('owner') — i test del CRUD girano
 * come owner; i casi RBAC (viewer/editor/ruolo alieno) hanno il loro describe.
 * role=null → nessun auth context (route pubbliche/401).
 */
function appAs(role: string | null): Hono {
  const app = new Hono();
  if (role !== null) {
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'u-test', email: 'test@x.it', tenantId: 'tenant-A', role } as AuthContext);
      await next();
    });
  }
  app.route('/', createOauthRoutes());
  return app;
}

beforeEach(() => {
  // Fresh :memory: DB per ogni test
  const db = new Database(':memory:');
  dbInstances[0] = db;
  // F2 (2026-06-10): le tabelle oauth_providers/oauth_state/users non sono più
  // create on-first-call dal route (DDL inline rimosso). Applichiamo lo schema
  // CANONICO (SCHEMA_SQL) — così il test gira sullo stesso schema di produzione
  // e intercetta i drift. I CREATE TABLE IF NOT EXISTS nei describe restano
  // no-op innocui.
  db.exec(SCHEMA_SQL);
  tenantIdMock.mockReturnValue('tenant-A');
  containerTenantMock.value = 'tenant-A';
  issueSessionTokenMock.mockReset();
  issueSessionTokenMock.mockResolvedValue('session-jwt-token-123');
  oidcMock.discovery.mockReset();
  oidcMock.buildAuthorizationUrl.mockReset();
  oidcMock.authorizationCodeGrant.mockReset();
  // Default for happy paths
  oidcMock.discovery.mockResolvedValue({ kind: 'fake-oidc-config' });
  oidcMock.buildAuthorizationUrl.mockReturnValue(new URL('https://idp.example.com/authorize?fake=true'));
});

function seedProvider(tenantId: string, provider: string, overrides: Partial<{ issuer: string; client_id: string; client_secret: string; redirect_uri: string; scopes: string }> = {}): void {
  dbInstances[0]!.exec(`
    CREATE TABLE IF NOT EXISTS oauth_providers (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider TEXT NOT NULL,
      issuer TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (tenant_id, provider)
    );
  `);
  dbInstances[0]!.prepare(
    `INSERT INTO oauth_providers (id, tenant_id, provider, issuer, client_id, client_secret, redirect_uri, scopes, created_at)
     VALUES ('p1', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    tenantId, provider,
    overrides.issuer ?? 'https://idp.example.com',
    overrides.client_id ?? 'cid',
    overrides.client_secret ?? 'csec',
    overrides.redirect_uri ?? 'https://app.example.com/callback',
    overrides.scopes ?? 'openid email profile',
  );
}

describe('GET /oauth/providers', () => {
  it('lista providers SENZA esporre client_secret', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    const res = await app.request('/oauth/providers');
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: Record<string, unknown>[] };
    expect(body.providers).toHaveLength(1);
    const p = body.providers[0]!;
    expect(p.provider).toBe('google');
    expect(p.issuer).toBe('https://idp.example.com');
    // 🚨 NON deve esporre client_secret o client_id
    expect(p).not.toHaveProperty('client_secret');
    expect(p).not.toHaveProperty('client_id');
    expect(p).not.toHaveProperty('tenant_id');
  });

  it('tenant isolation: provider seedato per tenant B → NON visibile a tenant A', async () => {
    const app = appAs('owner');
    seedProvider('tenant-B', 'google');
    tenantIdMock.mockReturnValue('tenant-A');
    const res = await app.request('/oauth/providers');
    const body = await res.json() as { providers: unknown[] };
    expect(body.providers).toHaveLength(0);
  });
});

describe('POST /oauth/providers — validation + upsert', () => {
  it('body non-JSON object → 400', async () => {
    const app = appAs('owner');
    const res = await app.request('/oauth/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Body must be a JSON object' });
  });

  const requiredFields = ['provider', 'issuer', 'clientId', 'clientSecret', 'redirectUri'];
  for (const missingField of requiredFields) {
    it(`manca ${missingField} → 400 con error list`, async () => {
      const app = appAs('owner');
      const full = {
        provider: 'google', issuer: 'https://i', clientId: 'c', clientSecret: 's', redirectUri: 'r',
      };
      delete (full as Record<string, unknown>)[missingField];
      const res = await app.request('/oauth/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(full),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain('required');
    });
  }

  it('insert success → 201 + persisted con tenant corretto', async () => {
    const app = appAs('owner');
    const res = await app.request('/oauth/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'github',
        issuer: 'https://github.com',
        clientId: 'gh-cid',
        clientSecret: 'gh-secret',
        redirectUri: 'https://app.example.com/cb',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; provider: string };
    expect(body.provider).toBe('github');
    expect(body.id).toMatch(/^id-/u);

    // Verifico DB — #5: il client_secret NON è più in chiaro (colonna vuota),
    // il valore vive cifrato nelle colonne envelope.
    const row = dbInstances[0]!.prepare('SELECT * FROM oauth_providers WHERE provider = ?').get('github') as Record<string, unknown>;
    expect(row.tenant_id).toBe('tenant-A');
    expect(row.client_secret).toBe('');
    expect(row.client_secret_ciphertext).toBe('ct:gh-secret');
  });

  it('upsert: stesso (tenant, provider) → UPDATE invece di error', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google', { issuer: 'OLD-issuer' });
    const res = await app.request('/oauth/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // issuer URL pubblico valido (il guard SSRF #N1 rifiuta non-URL/host interni)
        provider: 'google', issuer: 'https://new.idp.acme-corp.io',
        clientId: 'newcid', clientSecret: 'newsec', redirectUri: 'https://app/cb',
      }),
    });
    expect(res.status).toBe(201);
    const rows = dbInstances[0]!.prepare('SELECT * FROM oauth_providers WHERE tenant_id = ? AND provider = ?')
      .all('tenant-A', 'google');
    expect(rows).toHaveLength(1);
    const r = rows[0] as { issuer: string; client_id: string };
    expect(r.issuer).toBe('https://new.idp.acme-corp.io');
    expect(r.client_id).toBe('newcid');
  });

  it('scopes default = "openid email profile" se non specificato', async () => {
    const app = appAs('owner');
    await app.request('/oauth/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'p', issuer: 'https://idp.acme-corp.io', clientId: 'c', clientSecret: 's', redirectUri: 'https://app/cb',
      }),
    });
    const row = dbInstances[0]!.prepare('SELECT scopes FROM oauth_providers WHERE provider = ?').get('p') as { scopes: string };
    expect(row.scopes).toBe('openid email profile');
  });
});

describe('DELETE /oauth/providers/:provider', () => {
  it('provider esistente → removed=true', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    const res = await app.request('/oauth/providers/google', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(dbInstances[0]!.prepare('SELECT * FROM oauth_providers').all()).toHaveLength(0);
  });

  it('provider NON esistente → removed=false', async () => {
    const app = appAs('owner');
    const res = await app.request('/oauth/providers/ghost', { method: 'DELETE' });
    expect(await res.json()).toEqual({ removed: false });
  });

  it('tenant isolation: tenant A NON può cancellare provider tenant B', async () => {
    const app = appAs('owner');
    seedProvider('tenant-B', 'google');
    tenantIdMock.mockReturnValue('tenant-A');
    const res = await app.request('/oauth/providers/google', { method: 'DELETE' });
    expect(await res.json()).toEqual({ removed: false });
    expect(dbInstances[0]!.prepare('SELECT COUNT(*) c FROM oauth_providers').get()).toEqual({ c: 1 });
  });
});

describe('GET /oauth/:provider/start', () => {
  it('provider non configurato → 404', async () => {
    const app = appAs('owner');
    const res = await app.request('/oauth/ghost/start');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain('not configured');
  });

  it('happy: redirect a authorize URL, state row persistito, PKCE verifier salvato', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    const res = await app.request('/oauth/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('idp.example.com/authorize');
    // state row in DB
    const stateRows = dbInstances[0]!.prepare('SELECT * FROM oauth_state').all() as { state: string; code_verifier: string; tenant_id: string; provider: string }[];
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0]!.code_verifier).toBe('test-pkce-verifier-43-chars-1234567890abcdef');
    expect(stateRows[0]!.tenant_id).toBe('tenant-A');
    expect(stateRows[0]!.provider).toBe('google');
    expect(stateRows[0]!.state).toMatch(/^[A-Za-z0-9_-]+$/u); // base64url
  });

  it('buildAuthorizationUrl chiamato con PKCE S256 + state + redirect_uri', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    await app.request('/oauth/google/start');
    expect(oidcMock.buildAuthorizationUrl).toHaveBeenCalledTimes(1);
    const args = oidcMock.buildAuthorizationUrl.mock.calls[0]![1] as Record<string, string>;
    expect(args.code_challenge_method).toBe('S256');
    expect(args.redirect_uri).toBe('https://app.example.com/callback');
    expect(args.scope).toBe('openid email profile');
    expect(args.state).toBeTruthy();
    expect(args.code_challenge).toBeTruthy();
  });

  it('oidc.discovery throw → 500 con error message', async () => {
    oidcMock.discovery.mockRejectedValueOnce(new Error('issuer unreachable'));
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    const res = await app.request('/oauth/google/start');
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('issuer unreachable');
  });
});

describe('GET /oauth/:provider/callback', () => {
  function seedState(state: string, tenantId: string, provider: string, expired = false): void {
    dbInstances[0]!.exec(`
      CREATE TABLE IF NOT EXISTS oauth_state (
        state TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider TEXT NOT NULL,
        code_verifier TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
    `);
    const expiresAt = expired
      ? new Date(Date.now() - 60_000).toISOString()
      : new Date(Date.now() + 60_000).toISOString();
    dbInstances[0]!.prepare(
      'INSERT INTO oauth_state (state, tenant_id, provider, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(state, tenantId, provider, 'verifier-stored', new Date().toISOString(), expiresAt);
  }

  it('state assente in query → 400', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    const res = await app.request('/oauth/google/callback');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('Missing state');
  });

  it('state non in DB → 400 "Invalid state"', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    const res = await app.request('/oauth/google/callback?state=unknown&code=c');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('Invalid state');
  });

  it('state scaduto → 400 + state row eliminato', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('expired-state', 'tenant-A', 'google', true);
    const res = await app.request('/oauth/google/callback?state=expired-state&code=c');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('State expired');
    // state eliminato
    const remaining = dbInstances[0]!.prepare('SELECT * FROM oauth_state WHERE state = ?').get('expired-state');
    expect(remaining).toBeUndefined();
  });

  it('provider config mancante (deleted after start) → 404', async () => {
    const app = appAs('owner');
    seedState('valid-state', 'tenant-A', 'google');
    // Provider NON seedato → findProvider ritorna null
    const res = await app.request('/oauth/google/callback?state=valid-state&code=c');
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('Provider config missing');
  });

  it('email claim mancante → 400', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s1', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub: 'sub-123' }), // NO email
    });
    const res = await app.request('/oauth/google/callback?state=s1&code=c');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('Email claim missing');
  });

  it('claims() ritorna null → 500', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s2', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => null,
    });
    const res = await app.request('/oauth/google/callback?state=s2&code=c');
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('No claims');
  });

  it('🚨 PRIMO user nel tenant → role=owner (bootstrap admin)', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s3', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ email: 'first@example.com', name: 'First User', sub: 'sub-first' }),
    });
    process.env.FLOWFORGE_EDITOR_URL = 'https://editor.example.com';
    const res = await app.request('/oauth/google/callback?state=s3&code=c');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://editor.example.com');
    const user = dbInstances[0]!.prepare("SELECT * FROM users WHERE email = ?").get('first@example.com') as { role: string; tenant_id: string };
    expect(user.role).toBe('owner');
    expect(user.tenant_id).toBe('tenant-A');
    // Session JWT issued con role=owner
    expect(issueSessionTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'first@example.com',
      role: 'owner',
      tenantId: 'tenant-A',
    }));
  });

  it('SECONDO user → role=viewer (default safe)', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    // Esiste già un owner
    dbInstances[0]!.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'viewer', enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_login_at TEXT, oauth_provider TEXT, oauth_subject TEXT
      );
    `);
    dbInstances[0]!.prepare(
      "INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'owner', '2024-01-01', '2024-01-01')",
    ).run('owner-id', 'tenant-A', 'owner@example.com', 'Owner');
    seedState('s4', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ email: 'second@example.com', name: 'Second', sub: 'sub-2' }),
    });
    await app.request('/oauth/google/callback?state=s4&code=c');
    const user = dbInstances[0]!.prepare("SELECT role FROM users WHERE email = ?").get('second@example.com') as { role: string };
    expect(user.role).toBe('viewer');
  });

  it('user esistente → UPDATE last_login_at + oauth_provider, role preservato', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    dbInstances[0]!.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'viewer', enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_login_at TEXT, oauth_provider TEXT, oauth_subject TEXT
      );
    `);
    dbInstances[0]!.prepare(
      "INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, created_at, updated_at, last_login_at) VALUES ('uid-1', 'tenant-A', 'existing@example.com', 'Ex', '', 'editor', '2024-01-01', '2024-01-01', '2024-01-01')",
    ).run();
    seedState('s5', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ email: 'existing@example.com', name: 'Ex', sub: 'sub-ex' }),
    });
    await app.request('/oauth/google/callback?state=s5&code=c');
    const user = dbInstances[0]!.prepare("SELECT * FROM users WHERE email = ?").get('existing@example.com') as { role: string; last_login_at: string; oauth_provider: string };
    expect(user.role).toBe('editor'); // PRESERVED
    expect(user.last_login_at).not.toBe('2024-01-01');
    expect(user.oauth_provider).toBe('google');
    // session JWT con role esistente
    expect(issueSessionTokenMock).toHaveBeenCalledWith(expect.objectContaining({ role: 'editor' }));
  });

  it('happy path: cookie ff_session settato HttpOnly + redirect editor', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s6', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ email: 'user@example.com', name: 'User', sub: 'sub-u' }),
    });
    process.env.FLOWFORGE_EDITOR_URL = 'https://editor.example.com';
    const res = await app.request('/oauth/google/callback?state=s6&code=c');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://editor.example.com');
    const cookieHeader = res.headers.get('set-cookie') ?? '';
    expect(cookieHeader).toContain('ff_session=session-jwt-token-123');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).toContain('Path=/');
  });

  it('state row eliminato dopo successful callback (anti-replay)', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s7', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ email: 'u@example.com', name: 'U', sub: 's' }),
    });
    await app.request('/oauth/google/callback?state=s7&code=c');
    const remaining = dbInstances[0]!.prepare('SELECT * FROM oauth_state WHERE state = ?').get('s7');
    expect(remaining).toBeUndefined();
  });

  it('authorizationCodeGrant throw → 500 + error logged', async () => {
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s8', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockRejectedValueOnce(new Error('invalid code'));
    const res = await app.request('/oauth/google/callback?state=s8&code=bad');
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('invalid code');
  });

  it('FLOWFORGE_EDITOR_URL non settato → redirect "/"', async () => {
    delete process.env.FLOWFORGE_EDITOR_URL;
    const app = appAs('owner');
    seedProvider('tenant-A', 'google');
    seedState('s9', 'tenant-A', 'google');
    oidcMock.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ email: 'u@example.com', name: 'U', sub: 's' }),
    });
    const res = await app.request('/oauth/google/callback?state=s9&code=c');
    expect(res.headers.get('location')).toBe('/');
  });
});

describe('🚨🚨 F1-B — admin/start usano il tenant del container, header impersonation IGNORATO', () => {
  // In container-mode il tenant è SEMPRE FLOWFORGE_TENANT_ID. Un header
  // x-tenant-id (override impersonation superadmin) NON deve poter creare/leggere
  // provider sotto un tenant diverso → altrimenti tornerebbe il footgun "provider
  // creato sotto X, callback cerca sotto container → 404".

  it('🚨 POST /oauth/providers: header x-tenant-id IGNORATO, provider salvato sotto il tenant ENV', async () => {
    containerTenantMock.value = 'real-container-tenant';
    // getTenantId, se (erroneamente) usato, ritornerebbe l'header → smaschera la regressione
    tenantIdMock.mockReturnValue('attacker-tenant');
    const app = appAs('owner');
    const res = await app.request('/oauth/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'attacker-tenant' },
      body: JSON.stringify({
        provider: 'github', issuer: 'https://github.com',
        clientId: 'c', clientSecret: 's', redirectUri: 'https://app/cb',
      }),
    });
    expect(res.status).toBe(201);
    const row = dbInstances[0]!.prepare('SELECT tenant_id FROM oauth_providers WHERE provider = ?').get('github') as { tenant_id: string };
    expect(row.tenant_id).toBe('real-container-tenant');
    expect(row.tenant_id).not.toBe('attacker-tenant');
  });

  it('🚨 GET /oauth/providers: lista filtrata sul tenant ENV, non sull\'header', async () => {
    containerTenantMock.value = 'real-container-tenant';
    seedProvider('real-container-tenant', 'google'); // id='p1'
    // Secondo provider sotto attacker-tenant con id distinto (seedProvider usa
    // 'p1' fisso → INSERT diretto per evitare il conflitto di PRIMARY KEY).
    dbInstances[0]!.prepare(
      `INSERT INTO oauth_providers (id, tenant_id, provider, issuer, client_id, client_secret, redirect_uri, scopes, created_at)
       VALUES ('p2', 'attacker-tenant', 'okta', 'i', 'c', 's', 'r', 'openid', 'now')`,
    ).run();
    tenantIdMock.mockReturnValue('attacker-tenant');
    const app = appAs('owner');
    const res = await app.request('/oauth/providers', { headers: { 'x-tenant-id': 'attacker-tenant' } });
    const body = await res.json() as { providers: { provider: string }[] };
    // Vede SOLO il provider del container, non quello dell'attacker-tenant.
    expect(body.providers.map((p) => p.provider)).toEqual(['google']);
  });

  it('🚨 /start crea lo state sotto il tenant ENV → il callback (stateRow.tenant_id) lo ritrova', async () => {
    containerTenantMock.value = 'real-container-tenant';
    seedProvider('real-container-tenant', 'google');
    tenantIdMock.mockReturnValue('attacker-tenant');
    const app = appAs('owner');
    const res = await app.request('/oauth/google/start', { headers: { 'x-tenant-id': 'attacker-tenant' } });
    expect(res.status).toBe(302);
    // Lo state persistito DEVE essere legato al tenant del container.
    const stateRow = dbInstances[0]!.prepare('SELECT tenant_id FROM oauth_state LIMIT 1').get() as { tenant_id: string };
    expect(stateRow.tenant_id).toBe('real-container-tenant');
  });
});

/**
 * 🚨 RBAC gap #3 masterplan (2026-06-12) — POST/DELETE providers OWNER-ONLY.
 *
 * Pre-fix: bastava authMiddleware → un VIEWER poteva registrare un IdP che
 * controlla (mint di account via callback upsert) o cancellare il provider
 * legittimo (lockout dei colleghi). Inclusi i ruoli ALIENI ('admin' dal
 * vocabolario portal, garbage da token alterato): pre-fix rbac era FAIL-OPEN
 * (ROLE_RANK[ignoto]=undefined → undefined<rank è false → PASSAVA).
 */
describe('🚨 RBAC owner-only su POST/DELETE /oauth/providers', () => {
  const validBody = JSON.stringify({
    provider: 'google', issuer: 'https://idp.example.com', clientId: 'c',
    clientSecret: 's', redirectUri: 'https://app.example.com/cb',
  });

  for (const role of ['viewer', 'operator', 'editor'] as const) {
    it(`POST come ${role} → 403 e NESSUNA row scritta`, async () => {
      const res = await appAs(role).request('/oauth/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody,
      });
      expect(res.status).toBe(403);
      const count = dbInstances[0]!.prepare('SELECT COUNT(*) AS c FROM oauth_providers').get() as { c: number };
      expect(count.c).toBe(0);
    });
  }

  it('🚨 ruolo ALIENO "admin" (vocabolario portal) → 403, NON fail-open', async () => {
    const res = await appAs('admin').request('/oauth/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(403);
  });

  it('🚨 ruolo garbage da token alterato → 403, NON fail-open', async () => {
    const res = await appAs('hacker-role').request('/oauth/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(403);
  });

  it('nessun auth context → 401', async () => {
    const res = await appAs(null).request('/oauth/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(401);
  });

  it('owner → 201 (il gate non blocca chi ha diritto)', async () => {
    const res = await appAs('owner').request('/oauth/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(201);
  });

  it('superadmin → 201 (rank superiore passa)', async () => {
    const res = await appAs('superadmin').request('/oauth/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: validBody,
    });
    expect(res.status).toBe(201);
  });

  it('DELETE come viewer → 403 e provider ANCORA presente', async () => {
    seedProvider('tenant-A', 'google');
    const res = await appAs('viewer').request('/oauth/providers/google', { method: 'DELETE' });
    expect(res.status).toBe(403);
    const count = dbInstances[0]!.prepare('SELECT COUNT(*) AS c FROM oauth_providers').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('DELETE come owner → 200 removed:true', async () => {
    seedProvider('tenant-A', 'google');
    const res = await appAs('owner').request('/oauth/providers/google', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
  });

  it('GET providers resta accessibile a qualunque utente autenticato (read non-secret)', async () => {
    seedProvider('tenant-A', 'google');
    const res = await appAs('viewer').request('/oauth/providers');
    expect(res.status).toBe(200);
  });
});

describe('🔴 #6 audit log su CRUD IdP OAuth (era assente)', () => {
  it('POST /oauth/providers → audit append oauth_provider.upsert con actor', async () => {
    auditMock.append.mockClear();
    const res = await appAs('owner').request('/oauth/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb' }),
    });
    expect(res.status).toBe(201);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'oauth_provider.upsert', resourceType: 'oauth_provider', resourceId: 'google', actorId: 'actor-test',
    }));
  });

  it('DELETE /oauth/providers/:provider → audit append oauth_provider.remove', async () => {
    auditMock.append.mockClear();
    const res = await appAs('owner').request('/oauth/providers/google', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(auditMock.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'oauth_provider.remove', resourceType: 'oauth_provider',
    }));
  });

  it('🚨 nessun audit senza il record? (POST resta loggato anche se upsert idempotente)', async () => {
    // mutation-guard: se rimuovo audit.append dalla route, questi diventano rossi.
    auditMock.append.mockClear();
    await appAs('owner').request('/oauth/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'okta', issuer: 'https://okta.example', clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }),
    });
    expect(auditMock.append).toHaveBeenCalledTimes(1);
  });
});

describe('🔴 #5 client_secret cifrato at-rest (era plaintext in SQLite)', () => {
  it('POST salva client_secret CIFRATO: colonna plaintext vuota, ciphertext valorizzato', async () => {
    const res = await appAs('owner').request('/oauth/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'SECRET_XYZ', redirectUri: 'https://x/cb' }),
    });
    expect(res.status).toBe(201);
    const row = dbInstances[0]!
      .prepare('SELECT client_secret, client_secret_ciphertext FROM oauth_providers WHERE provider = ?')
      .get('google') as { client_secret: string; client_secret_ciphertext: string | null };
    expect(row.client_secret).toBe('');               // 🔴 niente plaintext nel DB
    expect(row.client_secret_ciphertext).toBe('ct:SECRET_XYZ'); // cifrato presente
  });

  it('start usa il client_secret DECIFRATO (record cifrato) per oidc.discovery', async () => {
    // seed un record cifrato (client_secret plaintext vuoto)
    dbInstances[0]!.prepare(
      "INSERT INTO oauth_providers (id, tenant_id, provider, issuer, client_id, client_secret, client_secret_ciphertext, redirect_uri, scopes, created_at) VALUES ('p2','tenant-A','okta','https://okta','cid','', 'ct:REALSEC','https://x/cb','openid', datetime('now'))",
    ).run();
    await appAs('owner').request('/oauth/okta/start');
    expect(oidcMock.discovery).toHaveBeenCalledWith(expect.any(URL), 'cid', 'REALSEC');
  });

  it('start resta compatibile coi record LEGACY (client_secret plaintext)', async () => {
    seedProvider('tenant-A', 'google', { client_secret: 'legacy-plain' });
    await appAs('owner').request('/oauth/google/start');
    expect(oidcMock.discovery).toHaveBeenCalledWith(expect.any(URL), 'cid', 'legacy-plain');
  });
});

describe('🔴 SSRF — issuer OAuth bloccato verso host interni (oidc.discovery fa fetch)', () => {
  const base = { provider: 'google', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb' };
  it.each([
    'http://172.20.0.1:6379',          // Redis interno
    'http://localhost/idp',            // loopback
    'http://169.254.169.254',          // IMDS
    'http://10.0.0.1',                 // RFC1918
    'ftp://evil.example.org',          // scheme non-http
  ])('issuer "%s" → 400, nessun INSERT', async (issuer) => {
    const res = await appAs('owner').request('/oauth/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, issuer }),
    });
    expect(res.status).toBe(400);
    expect(dbInstances[0]!.prepare('SELECT * FROM oauth_providers WHERE provider = ?').get('google')).toBeUndefined();
  });

  it('🟢 issuer PUBBLICO → 201', async () => {
    const res = await appAs('owner').request('/oauth/providers', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, issuer: 'https://accounts.google.com' }),
    });
    expect(res.status).toBe(201);
  });
});
