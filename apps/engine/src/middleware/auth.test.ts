/**
 * Tests per auth middleware runtime (H1+H2 audit fix).
 *
 * Coverage:
 *   - Internal token: constant-time compare (no timing leak)
 *     · token match → set auth con role='owner', tenantId da header
 *     · token wrong → next() senza set auth → 401 se required
 *     · token vuoto → never matches
 *   - Required auth: SEMPRE enforced (no NODE_ENV bypass)
 *   - Public prefixes / paths: bypass corretto
 *   - Cookie ff_session: parsing corretto
 *   - Bearer 'null' / 'undefined' / '' → ignorato (fallback cookie)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

vi.mock('@/lib/logger.js');

const verifyMock = vi.fn();
vi.mock('@medea/engine-auth-local', () => ({
  verifySessionToken: (token: string, key: string) => verifyMock(token, key),
}));

// DB tenant REALE (in-memory) per esercitare la blocklist di revoca nel
// middleware — senza questo, isPayloadRevoked andava in fail-open e i test NON
// testavano davvero il path "token revocato → 401" (era green-smoke).
let db: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));

beforeEach(() => {
  verifyMock.mockReset();
  db = new Database(':memory:');
  process.env.MEDEA_INTERNAL_TOKEN = 'super-secret-internal-token-32chars';
  process.env.MEDEA_TENANT_ID = 'tenant-default';
});

const FAKE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----';
const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

async function buildApp(opts: { required?: boolean; publicPrefixes?: string[]; publicPathPatterns?: RegExp[] } = {}) {
  const { authMiddleware } = await import('./auth.js');
  const app = new Hono();
  app.use('/api/v1/*', authMiddleware({
    publicKeyPem: FAKE_PUBLIC_KEY,
    required: opts.required ?? true,
    ...(opts.publicPrefixes ? { publicPrefixes: opts.publicPrefixes } : {}),
    ...(opts.publicPathPatterns ? { publicPathPatterns: opts.publicPathPatterns } : {}),
  }));
  app.get('/api/v1/me', (c) => c.json({ auth: c.get('auth') }));
  app.get('/api/v1/share/public', (c) => c.json({ ok: true }));
  app.get('/api/v1/auth/oauth/google/callback', (c) => c.json({ ok: 'callback' }));
  app.get('/api/v1/auth/oauth/providers', (c) => c.json({ ok: 'admin' }));
  app.get('/api/v1/auth/saml/okta/metadata', (c) => c.json({ ok: 'metadata' }));
  app.post('/api/v1/auth/saml/providers', (c) => c.json({ ok: 'admin' }));
  return app;
}

describe('authMiddleware — internal token (H1 timing-safe)', () => {
  it('200 con x-internal-token matching exact, tenantId da env (NON header)', async () => {
    // FIX HIGH-2 security audit 2026-05-31: x-tenant-id header IGNORATO.
    // tenantId è SEMPRE config.MEDEA_TENANT_ID (env var). Verifico che
    // il valore atteso sia quello env, non quello header.
    const expectedTenant = process.env.MEDEA_TENANT_ID || 'default';
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: {
        'x-internal-token': 'super-secret-internal-token-32chars',
        'x-tenant-id': 'tenant-xyz-FORGE-IGNORED', // header IGNORATO post-fix
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: { role: string; tenantId: string; userId: string } };
    expect(body.auth.role).toBe('owner');
    expect(body.auth.tenantId).toBe(expectedTenant);
    expect(body.auth.userId).toBe('internal');
  });

  it('401 con x-internal-token sbagliato (lunghezza diversa)', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: { 'x-internal-token': 'wrong-short' },
    });
    expect(res.status).toBe(401);
  });

  it('401 con x-internal-token stesso length ma byte diversi', async () => {
    const app = await buildApp();
    // Stesso length del token 'super-secret-internal-token-32chars' (35 chars)
    const wrongSameLen = 'XXXXX-secret-internal-token-32chars';
    expect(wrongSameLen.length).toBe('super-secret-internal-token-32chars'.length);
    const res = await app.request('/api/v1/me', {
      headers: { 'x-internal-token': wrongSameLen },
    });
    expect(res.status).toBe(401);
  });

  it('NON matcha quando internalToken env e` vuoto (string vuota = no internal auth)', async () => {
    process.env.MEDEA_INTERNAL_TOKEN = '';
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: { 'x-internal-token': '' },
    });
    expect(res.status).toBe(401);
  });

  // SECURITY REGRESSION 2026-06-01 audit (agent finding):
  // Anche senza internal-token, x-tenant-id NON deve mai essere usato per
  // popolare auth context. Senza Bearer token + senza internal-token →
  // request anonymous → cookie fallback → 401 o public path.
  it('SECURITY: x-tenant-id header SENZA internal-token NON crea auth context cross-tenant', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: {
        'x-tenant-id': 'tenant-attaccante-fake',
        // NO x-internal-token, NO Authorization Bearer
      },
    });
    // Sample: deve essere 401 (no auth), MAI 200 con tenantId='tenant-attaccante-fake'
    expect(res.status).toBe(401);
  });

  it('SECURITY: x-tenant-id header con valore evil + internal-token VALIDO → tenantId resta env (override impossibile)', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: {
        'x-internal-token': 'super-secret-internal-token-32chars',
        'x-tenant-id': '../../etc/passwd',  // path traversal attempt
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: { tenantId: string } };
    expect(body.auth.tenantId).toBe(process.env.MEDEA_TENANT_ID);
    expect(body.auth.tenantId).not.toContain('passwd');
    expect(body.auth.tenantId).not.toContain('..');
  });

  it('SECURITY: x-tenant-id con UUID di un OTHER tenant + internal-token valido → forge IGNORATO', async () => {
    const app = await buildApp();
    const evilTenant = '00000000-0000-0000-0000-000000000666';
    const res = await app.request('/api/v1/me', {
      headers: {
        'x-internal-token': 'super-secret-internal-token-32chars',
        'x-tenant-id': evilTenant,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: { tenantId: string } };
    expect(body.auth.tenantId).not.toBe(evilTenant);
    expect(body.auth.tenantId).toBe(process.env.MEDEA_TENANT_ID);
  });
});

describe('authMiddleware — required=true sempre (H2 fix)', () => {
  it('401 senza credenziali quando required=true (default)', async () => {
    const app = await buildApp({ required: true });
    const res = await app.request('/api/v1/me');
    expect(res.status).toBe(401);
  });

  it('NO bypass via NODE_ENV — anche se NODE_ENV unset, required resta enforced', async () => {
    delete process.env.NODE_ENV;
    const app = await buildApp({ required: true });
    const res = await app.request('/api/v1/me');
    expect(res.status).toBe(401);
  });
});

describe('authMiddleware — public prefixes bypass', () => {
  it('public prefix → next() senza auth check', async () => {
    const app = await buildApp({ required: true, publicPrefixes: ['/api/v1/share/'] });
    const res = await app.request('/api/v1/share/public');
    expect(res.status).toBe(200);
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe('authMiddleware — P0-1 #200 NO wildcard bypass OAuth/SAML admin', () => {
  it('/api/v1/auth/oauth/providers (admin) DEVE richiedere auth (401 senza JWT)', async () => {
    const app = await buildApp({ required: true });
    const res = await app.request('/api/v1/auth/oauth/providers');
    expect(res.status).toBe(401);
  });

  it('/api/v1/auth/saml/providers POST (admin) DEVE richiedere auth (401 senza JWT)', async () => {
    const app = await buildApp({ required: true });
    const res = await app.request('/api/v1/auth/saml/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('publicPathPatterns: callback OAuth dinamico → bypass (200)', async () => {
    const app = await buildApp({
      required: true,
      publicPathPatterns: [
        /^\/api\/v1\/auth\/oauth\/[a-zA-Z0-9_-]+\/callback$/,
        /^\/api\/v1\/auth\/saml\/[a-zA-Z0-9_-]+\/metadata$/,
      ],
    });
    const res = await app.request('/api/v1/auth/oauth/google/callback?code=xyz');
    expect(res.status).toBe(200);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('publicPathPatterns: SAML metadata dinamico → bypass (200)', async () => {
    const app = await buildApp({
      required: true,
      publicPathPatterns: [
        /^\/api\/v1\/auth\/saml\/[a-zA-Z0-9_-]+\/metadata$/,
      ],
    });
    const res = await app.request('/api/v1/auth/saml/okta/metadata');
    expect(res.status).toBe(200);
  });

  it('publicPathPatterns: admin /providers NON match pattern → 401', async () => {
    const app = await buildApp({
      required: true,
      publicPathPatterns: [
        /^\/api\/v1\/auth\/oauth\/[a-zA-Z0-9_-]+\/callback$/,
      ],
    });
    const res = await app.request('/api/v1/auth/oauth/providers');
    expect(res.status).toBe(401);
  });

  it('publicPathPatterns rifiuta path injection (no `..` né newline)', async () => {
    const app = await buildApp({
      required: true,
      publicPathPatterns: [
        /^\/api\/v1\/auth\/oauth\/[a-zA-Z0-9_-]+\/callback$/,
      ],
    });
    const res = await app.request('/api/v1/auth/oauth/google/callback/../providers');
    // Path normalizzato dal router; in ogni caso il pattern `$` chiude la stringa
    expect(res.status).not.toBe(200);
  });
});

describe('authMiddleware — bearer JWT', () => {
  it('200 con bearer valido', async () => {
    verifyMock.mockResolvedValue({
      sub: 'user-abc',
      email: 'u@test.it',
      role: 'editor',
      tenantId: 'tenant-default',
    });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: { authorization: 'Bearer valid.jwt.token' },
    });
    expect(res.status).toBe(200);
    expect(verifyMock).toHaveBeenCalledWith('valid.jwt.token', FAKE_PUBLIC_KEY);
  });

  it('ignora "Bearer null" / "Bearer undefined" → cade su cookie', async () => {
    verifyMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: {
        authorization: 'Bearer null',
        cookie: 'ff_session=cookie.session.token',
      },
    });
    // verifyMock chiamato col cookie token, non con 'null'
    if (verifyMock.mock.calls.length > 0) {
      const lastCall = verifyMock.mock.calls.at(-1) as [string, string];
      expect(lastCall[0]).not.toBe('null');
    }
    expect(res.status).toBe(401);     // verifyMock ritorna null → no auth
  });

  it('#203 P0-4: ignora "Bearer cookie-session" sentinel → tenta JWT col cookie HttpOnly', async () => {
    // L'editor SPA post-bootstrap manda Bearer 'cookie-session' come segnaposto.
    // Il middleware DEVE skippare il verify del Bearer (che fallirebbe) e
    // procedere col cookie ff_session HttpOnly.
    verifyMock.mockResolvedValue({
      sub: 'user-1', email: 'u@x.it', role: 'editor', tenantId: 'tenant-default',
    });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', {
      headers: {
        authorization: 'Bearer cookie-session',
        cookie: 'ff_session=valid.cookie.jwt',
      },
    });
    expect(res.status).toBe(200);
    // verifyMock chiamato col cookie token, NON con 'cookie-session'
    const calls = verifyMock.mock.calls as [string, string][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![0]).toBe('valid.cookie.jwt');
    expect(calls.some((c) => c[0] === 'cookie-session')).toBe(false);
  });
});

describe('authMiddleware — blocklist di revoca (DB tenant reale, NON fail-open)', () => {
  const basePayload = { tenantId: 'tenant-default', email: 'u@x.it', role: 'owner', exp: FUTURE_EXP };

  it('token valido NON revocato → 200 (baseline)', async () => {
    verifyMock.mockResolvedValue({ ...basePayload, sub: 'u-ok', iat: 1000, jti: 'jti-ok' });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
  });

  it('token REVOCATO via logout (blocklist del singolo jti) → 401', async () => {
    const { revokeSession } = await import('@/services/security/session-revocation.js');
    revokeSession({ jti: 'jti-bad', sub: 'u-bad', iat: 1000, exp: FUTURE_EXP });
    verifyMock.mockResolvedValue({ ...basePayload, sub: 'u-bad', iat: 1000, jti: 'jti-bad' });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toMatch(/revoked/i);
  });

  it('revoca-tutte utente (cutoff): token con iat < cutoff → 401', async () => {
    const { revokeAllUserSessions } = await import('@/services/security/session-revocation.js');
    const nowSec = Math.floor(Date.now() / 1000);
    revokeAllUserSessions('u-cut');
    verifyMock.mockResolvedValue({ ...basePayload, sub: 'u-cut', iat: nowSec - 100, jti: 'jti-old' });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('re-login dopo revoca-tutte (iat ≥ cutoff) → 200', async () => {
    const { revokeAllUserSessions } = await import('@/services/security/session-revocation.js');
    const nowSec = Math.floor(Date.now() / 1000);
    revokeAllUserSessions('u-relog');
    verifyMock.mockResolvedValue({ ...basePayload, sub: 'u-relog', iat: nowSec + 10, jti: 'jti-fresh' });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
  });
});

describe('authMiddleware — cross-tenant scope assertion (defense-in-depth 2026-06-09)', () => {
  it('SECURITY: token con tenantId ≠ MEDEA_TENANT_ID → 401 (cross-tenant rifiutato)', async () => {
    // env = 'tenant-default' (beforeEach). Token forgiato/leakato di un ALTRO
    // workspace → DEVE essere rifiutato anche se la firma fosse valida.
    verifyMock.mockResolvedValue({
      sub: 'user-evil', email: 'e@x.it', role: 'owner', tenantId: 'tenant-ALTRO-workspace',
    });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer cross.tenant.jwt' } });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toMatch(/tenant scope mismatch/i);
  });

  it('SECURITY: superadmin con token di un altro workspace NON bypassa l\'assertion', async () => {
    // superadmin ha accesso cross-tenant via SSO fresh (tenantId=quel workspace),
    // NON riusando un token mintato per un altro container.
    verifyMock.mockResolvedValue({
      sub: 'root', email: 'root@zeli.it', role: 'superadmin', tenantId: 'tenant-ALTRO',
    });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer super.cross.jwt' } });
    expect(res.status).toBe(401);
  });

  it('token con tenantId === MEDEA_TENANT_ID → 200 (baseline)', async () => {
    verifyMock.mockResolvedValue({
      sub: 'user-ok', email: 'u@x.it', role: 'editor', tenantId: 'tenant-default',
    });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer same.tenant.jwt' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: { tenantId: string } };
    expect(body.auth.tenantId).toBe('tenant-default');
  });

  it('MEDEA_TENANT_ID vuoto (dev / disaster recovery) → assertion NON enforced', async () => {
    process.env.MEDEA_TENANT_ID = '';
    verifyMock.mockResolvedValue({
      sub: 'user-dev', email: 'd@x.it', role: 'owner', tenantId: 'qualsiasi-tenant',
    });
    const app = await buildApp();
    const res = await app.request('/api/v1/me', { headers: { authorization: 'Bearer dev.jwt' } });
    expect(res.status).toBe(200);
  });
});

describe('authMiddleware — allowlist REALE (auth-public-paths) ↔ middleware', () => {
  it('config di produzione: /auth/logout bypassa l\'auth, un endpoint sensibile NO', async () => {
    const { authMiddleware } = await import('./auth.js');
    const { PUBLIC_PATH_PATTERNS, PUBLIC_PREFIXES } = await import('./auth-public-paths.js');
    const app = new Hono();
    app.use('/api/v1/*', authMiddleware({
      publicKeyPem: FAKE_PUBLIC_KEY,
      required: true,
      publicPrefixes: [...PUBLIC_PREFIXES],
      publicPathPatterns: [...PUBLIC_PATH_PATTERNS],
    }));
    app.post('/api/v1/auth/logout', (c) => c.json({ ok: true }));
    app.get('/api/v1/users/me', (c) => c.json({ ok: true }));
    // /auth/logout → bypass (200 SENZA auth, col pattern reale di produzione)
    expect((await app.request('/api/v1/auth/logout', { method: 'POST' })).status).toBe(200);
    // controprova: endpoint NON in allowlist → 401 senza auth
    expect((await app.request('/api/v1/users/me')).status).toBe(401);
  });
});
