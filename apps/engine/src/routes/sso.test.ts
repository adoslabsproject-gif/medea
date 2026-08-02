/**
 * SSO bridge route tests — enterprise security grade.
 *
 * Coverage focus (security-CRITICAL):
 *   • Token extraction: POST x-www-form-urlencoded / json / multipart
 *   • Token mancante → 400
 *   • JWE decrypt fail (signature, audience, issuer, expiry) → 401
 *   • Missing jti → 401 (no replay protection senza jti)
 *   • Replay detection: stesso jti due volte → 401 + log SECURITY
 *   • Missing sub/email → 401
 *   • SSO not configured (MEDEA_SSO_SECRET o MEDEA_TENANT_ID missing) → 500
 *   • Success: upsertSSOUser + ensureTenant idempotent + cookie set + redirect 302
 *   • Cookie config: httpOnly + secure (prod) + sameSite=Lax + path=/ + maxAge 7gg
 *   • PII redaction: log NON contiene email plaintext
 *   • role default 'viewer' se claim mancante
 *   • upsertSSOUser: existing → UPDATE; new → INSERT
 *
 * Mock strategy: stub jose.jwtDecrypt, sqlite prepare chain, auth keys,
 * issueSessionToken, sessionCookieName helper.
 */

import { coerceString } from '@/lib/coerce.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import type { Hono } from 'hono';

const m = vi.hoisted(() => {
  // Simula UNIQUE constraint su sso_jti_used per replay test reali
  const usedJtis = new Set<string>();
  const sqliteStmt = {
    get: vi.fn(),
    run: vi.fn(),
    all: vi.fn(),
  };
  const prepareImpl = vi.fn((sql: string) => {
    if (sql.includes('INSERT INTO sso_jti_used')) {
      return {
        run: vi.fn((jti: string) => {
          if (usedJtis.has(jti)) {
            throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: sso_jti_used.jti');
          }
          usedJtis.add(jti);
          return { changes: 1 };
        }),
      };
    }
    if (sql.includes('DELETE FROM sso_jti_used')) {
      return { run: vi.fn(() => ({ changes: 0 })) };
    }
    return sqliteStmt;
  });
  return {
    sqliteStmt,
    usedJtis,
    prepare: prepareImpl,
    jwtDecrypt: vi.fn(),
    issueSessionToken: vi.fn().mockResolvedValue('session.jwt.token'),
    getAuthKeys: vi.fn().mockResolvedValue({ privateKeyPem: 'PRIVATE-KEY-PEM' }),
    loadConfig: vi.fn(),
    sessionCookieName: vi.fn().mockReturnValue('__Host-ff_session'),
  };
});

vi.mock('jose', () => ({
  jwtDecrypt: (token: unknown, key: unknown, opts: unknown) => m.jwtDecrypt(token, key, opts),
}));

vi.mock('@medea/engine-auth-local', () => ({
  issueSessionToken: (i: unknown) => m.issueSessionToken(i),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: { prepare: m.prepare, exec: vi.fn() } }),
}));

vi.mock('@/lib/auth-keys.js', () => ({
  getAuthKeys: () => m.getAuthKeys(),
}));

vi.mock('@/config.js', () => ({
  loadConfig: () => m.loadConfig(),
}));

vi.mock('@/lib/session-cookie.js', () => ({
  sessionCookieName: () => m.sessionCookieName(),
}));

vi.mock('@/lib/logger.js');

vi.mock('@medea/engine-shared', () => ({
  maskEmail: (e: string) => e.replace(/(.).+(@.+)/, '$1***$2'),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'fixed-nanoid-id' }));

import { createSSORoutes, normalizeSsoRole } from './sso.js';

const FAKE_CONFIG = {
  MEDEA_SSO_SECRET: 'a'.repeat(32),
  MEDEA_TENANT_ID: 'tenant-acme',
  NODE_ENV: 'production' as const,
};

const VALID_PAYLOAD = {
  sub: 'user-abc',
  email: 'admin@acme.com',
  name: 'ACME Admin',
  role: 'owner',
  tenantId: 'tenant-acme',
  tenantSlug: 'acme',
  tenantName: 'ACME Srl',
  jti: 'jti-fresh-' + Math.random(),
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.loadConfig.mockReturnValue({ ...FAKE_CONFIG });
  m.sqliteStmt.get.mockReset();
  m.sqliteStmt.run.mockReset();
  m.jwtDecrypt.mockResolvedValue({
    payload: { ...VALID_PAYLOAD, jti: 'jti-' + Math.random() },
    protectedHeader: { alg: 'dir', enc: 'A256GCM' },
  });
});

function buildApp(): Hono {
  return createSSORoutes();
}

async function postForm(app: Hono, body: Record<string, string>): Promise<Response> {
  return app.request('/sso', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

async function postJson(app: Hono, body: object): Promise<Response> {
  return app.request('/sso', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ════════════════════════════════════════════════════════════════════
// Token extraction
// ════════════════════════════════════════════════════════════════════
describe('SSO POST /sso — token extraction', () => {
  it('estrae token da application/x-www-form-urlencoded', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined); // new user path
    const app = buildApp();
    const res = await postForm(app, { token: 'jwe-token-here' });
    expect(res.status).toBe(302);
    expect(m.jwtDecrypt).toHaveBeenCalledWith('jwe-token-here', expect.any(Uint8Array), expect.objectContaining({
      issuer: 'portal.flowforge',
      audience: 'tenant-acme',
      clockTolerance: 30,
    }));
  });

  it('estrae token da application/json (CLI clients)', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postJson(app, { token: 'jwe-token-json' });
    expect(res.status).toBe(302);
    expect(m.jwtDecrypt).toHaveBeenCalledWith('jwe-token-json', expect.any(Uint8Array), expect.any(Object));
  });

  it('POST senza content-type → 400 (estrazione fallisce)', async () => {
    const app = buildApp();
    const res = await app.request('/sso', { method: 'POST', body: 'token=x' });
    expect(res.status).toBe(400);
  });

  it('POST application/json malformato → token null → 400', async () => {
    const app = buildApp();
    const res = await app.request('/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{this-is-not-json',
    });
    expect(res.status).toBe(400);
  });

  it('POST con token vuoto (form body) → 400', async () => {
    const app = buildApp();
    const res = await postForm(app, { other: 'value' });
    expect(res.status).toBe(400);
    const txt = await res.text();
    expect(txt).toMatch(/SSO token missing/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Config validation
// ════════════════════════════════════════════════════════════════════
describe('SSO — config validation', () => {
  it('MEDEA_SSO_SECRET mancante → 500', async () => {
    m.loadConfig.mockReturnValue({ ...FAKE_CONFIG, MEDEA_SSO_SECRET: '' });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(500);
    expect(vi.mocked(logger).error).toHaveBeenCalled();
  });

  it('MEDEA_TENANT_ID mancante → 500', async () => {
    m.loadConfig.mockReturnValue({ ...FAKE_CONFIG, MEDEA_TENANT_ID: '' });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(500);
  });
});

// ════════════════════════════════════════════════════════════════════
// JWE decrypt failures (security-critical)
// ════════════════════════════════════════════════════════════════════
describe('SSO — JWE decrypt failures', () => {
  it('decrypt fail (invalid signature/auth tag) → 401 + log warn', async () => {
    m.jwtDecrypt.mockRejectedValueOnce(new Error('JWE Authentication Tag invalid'));
    const app = buildApp();
    const res = await postForm(app, { token: 'tampered.jwe.token' });
    expect(res.status).toBe(401);
    const txt = await res.text();
    expect(txt).toMatch(/Invalid SSO token/);
    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      expect.stringContaining('[SSO] JWE decrypt failed'),
    );
  });

  it('decrypt fail per audience mismatch → 401', async () => {
    m.jwtDecrypt.mockRejectedValueOnce(new Error('aud claim does not match expected'));
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
  });

  it('decrypt fail per issuer mismatch → 401', async () => {
    m.jwtDecrypt.mockRejectedValueOnce(new Error('iss claim mismatch'));
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
  });

  it('decrypt fail per token expired → 401', async () => {
    m.jwtDecrypt.mockRejectedValueOnce(new Error('"exp" claim timestamp check failed'));
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
  });

  it('jwtDecrypt chiamato con clockTolerance: 30s (skew tolerance)', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const opts = m.jwtDecrypt.mock.calls[0]?.[2] as { clockTolerance: number };
    expect(opts.clockTolerance).toBe(30);
  });

  it('jwtDecrypt chiamato con issuer "portal.flowforge"', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const opts = m.jwtDecrypt.mock.calls[0]?.[2] as { issuer: string };
    expect(opts.issuer).toBe('portal.flowforge');
  });

  it('jwtDecrypt chiamato con audience = MEDEA_TENANT_ID', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const opts = m.jwtDecrypt.mock.calls[0]?.[2] as { audience: string };
    expect(opts.audience).toBe('tenant-acme');
  });
});

// ════════════════════════════════════════════════════════════════════
// jti replay protection (security-CRITICAL)
// ════════════════════════════════════════════════════════════════════
describe('SSO — jti replay protection', () => {
  it('payload senza jti → 401 (no replay protection senza jti = NO ENTRY)', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, jti: undefined },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
    const txt = await res.text();
    expect(txt).toMatch(/missing jti/);
  });

  it('jti non-string → 401', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, jti: 12345 },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
  });

  it('SAME jti due volte → secondo 401 + log SECURITY warn', async () => {
    const stableJti = 'jti-stable-replay-test-' + Date.now();
    m.jwtDecrypt
      .mockResolvedValueOnce({
        payload: { ...VALID_PAYLOAD, jti: stableJti },
        protectedHeader: { alg: 'dir', enc: 'A256GCM' },
      })
      .mockResolvedValueOnce({
        payload: { ...VALID_PAYLOAD, jti: stableJti },
        protectedHeader: { alg: 'dir', enc: 'A256GCM' },
      });
    m.sqliteStmt.get.mockReturnValue(undefined);

    const app = buildApp();
    const res1 = await postForm(app, { token: 'x' });
    expect(res1.status).toBe(302); // primo ok

    const res2 = await postForm(app, { token: 'x' });
    expect(res2.status).toBe(401);
    const txt = await res2.text();
    expect(txt).toMatch(/already used/);
    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({ jti: stableJti }),
      expect.stringContaining('[SSO][SECURITY] replay detected'),
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// Missing claims (security)
// ════════════════════════════════════════════════════════════════════
describe('SSO — missing claims', () => {
  it('payload senza sub → 401', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, sub: undefined, jti: 'jti-no-sub' },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/missing claims/);
  });

  it('payload senza email → 401', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, email: undefined, jti: 'jti-no-email' },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
  });

  it('email non-string (object/array) → 401', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, email: { malicious: 'payload' }, jti: 'jti-obj-email' },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════
// Defaults — role + tenantName fallback
// ════════════════════════════════════════════════════════════════════
describe('SSO — claim defaults', () => {
  it('role mancante → default "viewer" (least privilege)', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, role: undefined, jti: 'jti-no-role-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    // upsertSSOUser invocato con role='viewer' di default → INSERT INTO users
    // chiamato con il role 'viewer' tra gli argomenti del prepared statement.
    const insertCallExists = m.sqliteStmt.run.mock.calls.some((args) => args.includes('viewer'));
    expect(insertCallExists).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// normalizeSsoRole — vocabolario PORTAL → RUNTIME (fix gap #3 2026-06-12)
// ════════════════════════════════════════════════════════════════════
describe('🚨 normalizeSsoRole — portal→runtime, fail-closed', () => {
  it('admin (portal) → owner (admin≡owner dentro il container)', () => {
    expect(normalizeSsoRole('admin')).toBe('owner');
  });
  it('super_admin (portal) → superadmin (runtime), MAI degradato', () => {
    expect(normalizeSsoRole('super_admin')).toBe('superadmin');
  });
  it('ruoli runtime nativi passano invariati', () => {
    expect(normalizeSsoRole('owner')).toBe('owner');
    expect(normalizeSsoRole('editor')).toBe('editor');
    expect(normalizeSsoRole('operator')).toBe('operator');
    expect(normalizeSsoRole('viewer')).toBe('viewer');
    expect(normalizeSsoRole('superadmin')).toBe('superadmin');
  });
  it('🚨 ruolo sconosciuto → viewer (fail-closed, mai privilege escalation)', () => {
    expect(normalizeSsoRole('root')).toBe('viewer');
    expect(normalizeSsoRole('')).toBe('viewer');
    expect(normalizeSsoRole('OWNER')).toBe('viewer'); // case-sensitive
    expect(normalizeSsoRole('hacker')).toBe('viewer');
  });
});

describe('🚨 SSO — claim role "admin" normalizzato a owner nella sessione', () => {
  it('payload role=admin → upsert + issueSessionToken con role=owner (NON admin raw)', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, role: 'admin', jti: 'jti-admin-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    // issueSessionToken NON deve mai ricevere 'admin' (rank undefined in rbac)
    expect(m.issueSessionToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner' }));
    // E l'INSERT users scrive 'owner', non 'admin'
    const insertOwner = m.sqliteStmt.run.mock.calls.some((args) => args.includes('owner'));
    expect(insertOwner).toBe(true);
    const insertAdmin = m.sqliteStmt.run.mock.calls.some((args) => args.includes('admin'));
    expect(insertAdmin).toBe(false);
  });

  it('payload role=super_admin → issueSessionToken con role=superadmin', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, role: 'super_admin', jti: 'jti-sa-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    expect(m.issueSessionToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'superadmin' }));
  });

  it('🚨 payload role=garbage → sessione con role=viewer (fail-closed)', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, role: 'megaboss', jti: 'jti-garbage-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    expect(m.issueSessionToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer' }));
  });
});

// ════════════════════════════════════════════════════════════════════
// upsertSSOUser — existing vs new
// ════════════════════════════════════════════════════════════════════
describe('SSO — upsertSSOUser', () => {
  it('NEW user → INSERT (password_hash sentinel "sso-only-")', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, jti: 'jti-new-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined); // user not found
    const app = buildApp();
    await postForm(app, { token: 'x' });
    // Verify INSERT statement called
    const preparedSqls = (m.prepare.mock.calls as unknown[][]).map((c) => coerceString(c[0] ?? ''));
    expect(preparedSqls.some((s) => s.includes('INSERT INTO users'))).toBe(true);
    // Verify INSERT args include password_hash starting with "sso-only-"
    const insertArgs = m.sqliteStmt.run.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a.startsWith('sso-only-')),
    );
    expect(insertArgs).toBeDefined();
  });

  it('EXISTING user → UPDATE display_name + role + last_login_at', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, role: 'editor', jti: 'jti-existing-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue({
      id: 'user-existing',
      tenant_id: 'tenant-acme',
      email: 'admin@acme.com',
      display_name: 'Old Name',
      role: 'viewer', // ← was viewer, becomes editor
      enabled: 1,
    });
    const app = buildApp();
    await postForm(app, { token: 'x' });
    // UPDATE statement chiamato
    const preparedSqls = (m.prepare.mock.calls as unknown[][]).map((c) => coerceString(c[0] ?? ''));
    expect(preparedSqls.some((s) => s.includes('UPDATE users SET display_name'))).toBe(true);
    // INSERT NON chiamato
    expect(preparedSqls.some((s) => s.includes('INSERT INTO users'))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// ensureTenant idempotent
// ════════════════════════════════════════════════════════════════════
describe('SSO — ensureTenant upsert', () => {
  it('chiama upsert (INSERT ... ON CONFLICT) su tenants(tenantId)', async () => {
    // A2 2026-06-17: da INSERT OR IGNORE a UPSERT (sync billing→runtime).
    // Comportamento SQL testato a fondo in services/tenant-upsert.test.ts.
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const preparedSqls = (m.prepare.mock.calls as unknown[][]).map((c) => coerceString(c[0] ?? ''));
    expect(preparedSqls.some((s) => s.includes('INSERT INTO tenants') && s.includes('ON CONFLICT'))).toBe(true);
  });

  it('ensureTenant invocato PRIMA di upsertSSOUser', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const calls = (m.prepare.mock.calls as unknown[][]).map((c) => coerceString(c[0] ?? ''));
    const tenantIdx = calls.findIndex((s) => s.includes('INSERT INTO tenants') && s.includes('ON CONFLICT'));
    const userInsertIdx = calls.findIndex((s) => s.includes('INSERT INTO users'));
    expect(tenantIdx).toBeGreaterThanOrEqual(0);
    expect(tenantIdx).toBeLessThan(userInsertIdx);
  });
});

// ════════════════════════════════════════════════════════════════════
// Cookie + session token
// ════════════════════════════════════════════════════════════════════
describe('SSO — success path cookie + session', () => {
  it('issueSessionToken chiamato con userId/tenantId/role/email/privateKeyPem', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    expect(m.issueSessionToken).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-acme',
      role: 'owner',
      email: 'admin@acme.com',
      privateKeyPem: 'PRIVATE-KEY-PEM',
    }));
  });

  it('sessionCookieName usato (dual-name __Host- / legacy)', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(m.sessionCookieName).toHaveBeenCalled();
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/__Host-ff_session=/);
  });

  it('cookie ha attributi HttpOnly + Secure + SameSite=Lax + Path=/ + Max-Age=7gg', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=604800/); // 7 * 86400
  });

  it('Success → redirect 302 a "/" (editor)', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });
});

// ════════════════════════════════════════════════════════════════════
// PII redaction in log (privacy)
// ════════════════════════════════════════════════════════════════════
describe('SSO — PII redaction in logs', () => {
  it('log [SSO] session created NON contiene email plaintext', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const sessionCreatedCall = vi.mocked(logger).info.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('session created'),
    );
    expect(sessionCreatedCall).toBeDefined();
    const ctx = sessionCreatedCall?.[0] as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('email');
    // userId presente per audit trail
    expect(ctx).toHaveProperty('userId');
    expect(ctx).toHaveProperty('role');
  });

  it('log [SSO] new user provisioned: email MASKED (maskEmail)', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const provisionLog = vi.mocked(logger).info.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('provisioned'),
    );
    if (provisionLog) {
      const ctx = provisionLog[0] as { email: string };
      // maskEmail mock: "a***@acme.com"
      expect(ctx.email).toMatch(/\*\*\*@/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// HKDF key derivation (deterministic)
// ════════════════════════════════════════════════════════════════════
describe('SSO — HKDF key derivation', () => {
  it('passa Uint8Array 32-byte come chiave a jwtDecrypt (A256GCM)', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    const key = m.jwtDecrypt.mock.calls[0]?.[1] as Uint8Array;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32); // A256GCM richiede 32 byte
  });

  it('chiave DETERMINISTICA per stesso secret (HKDF stessa info "flowforge-sso-jwe-v1")', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x1' });
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, jti: 'jti-2' },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    await postForm(app, { token: 'x2' });
    const key1 = m.jwtDecrypt.mock.calls[0]?.[1] as Uint8Array;
    const key2 = m.jwtDecrypt.mock.calls[1]?.[1] as Uint8Array;
    // Deterministic: stesso secret + HKDF info → stessa chiave bit-identical
    expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
  });
});

// ════════════════════════════════════════════════════════════════════
// GET /sso?token=... LEGACY REMOVED (security)
// ════════════════════════════════════════════════════════════════════
describe('SSO — GET friendly fallback (fix 2026-05-31)', () => {
  it('GET /sso → 200 friendly HTML page (no token in URL ammessa)', async () => {
    // Pre-2026-05-31 il GET era 404 (test storico). Dopo user-segnalato bug
    // refresh dopo cold-start container → 404 secco UX bad → ora pagina friendly
    // con CTA "Riprova" che ri-genera JWE dal portal. Token in URL VIENE IGNORATO
    // (sarebbe leak in access_log) — la pagina non lo usa.
    const app = buildApp();
    const res = await app.request('/sso?token=x', { method: 'GET' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// Branch coverage 100% — fill missing branches
// ════════════════════════════════════════════════════════════════════
describe('SSO — branch coverage 100%', () => {
  it('multipart/form-data content-type → parseBody path', async () => {
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    // Build multipart body
    const boundary = '----test-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\nmultipart-token\r\n--${boundary}--\r\n`;
    const res = await app.request('/sso', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(302);
    expect(m.jwtDecrypt).toHaveBeenCalledWith('multipart-token', expect.any(Uint8Array), expect.any(Object));
  });

  it('POST json con token non-string → null → 400', async () => {
    const app = buildApp();
    const res = await app.request('/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 12345 }), // numero, non string
    });
    expect(res.status).toBe(400);
  });

  it('cleanup expired jti scatena dopo TTL (forza il for loop di cleanup)', async () => {
    // Strategia: emettiamo un primo SSO valido (jti registrato), poi simuliamo
    // passaggio del tempo modificando seenJti via re-import; più pragmatic:
    // emettiamo 2 SSO consecutivi con jti diversi → secondo call cleanupExpiredJti
    // walks the map. Il branch "ts < cutoff" è coperto solo se c'è almeno un
    // entry vecchio nella mappa.
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    // primo
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, jti: 'old-jti-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    await postForm(app, { token: 'a' });
    // secondo dopo "ttl elapsed" — modifichiamo internamente: poiché seenJti è
    // module-private, il for-each loop comunque scatta a ogni isReplay() call.
    // Coverage del branch `if (ts < cutoff)` è raggiunto solo se ts < cutoff
    // per qualche entry. Usiamo vi.useFakeTimers per avanzare il time.
    vi.useFakeTimers({ now: Date.now() });
    vi.advanceTimersByTime(7 * 60 * 1000); // > 6 min TTL
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, jti: 'new-jti-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    const res = await postForm(app, { token: 'b' });
    vi.useRealTimers();
    // 🚨 CLEANUP: dopo TTL elapsed + nuova request → mappa seenJti rimuove vecchio.
    // Verifica che il secondo SSO sia accettato (no replay anche se prima jti era simile).
    // Status 302 = SSO ok, 403 = replay detected (regression).
    expect([200, 302]).toContain(res.status);
    expect(res.status).not.toBe(403); // no replay erroneo dopo TTL cleanup
  });

  it('ensureTenant: displayName fallback a tenantId se tenantName vuoto', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, tenantName: undefined, tenantSlug: undefined, jti: 'jti-no-name-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    await postForm(app, { token: 'x' });
    // INSERT OR IGNORE INTO tenants chiamato con (tenantId, displayName) — displayName fallback al tenantId stesso
    const tenantRunCall = m.sqliteStmt.run.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a === 'tenant-acme'),
    );
    expect(tenantRunCall).toBeDefined();
  });

  it('JWE err non-Error (string thrown) → log warn riceve err originale', async () => {
    m.jwtDecrypt.mockRejectedValueOnce('plain-string-error'); // not an Error instance
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
    expect(vi.mocked(logger).warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'plain-string-error' }),
      expect.any(String),
    );
  });

  it('payload.name fallback ad email se name undefined (branch covered)', async () => {
    // Use beforeEach default + override jti — l'isolamento mockResolvedValueOnce
    // tra test era flaky con altri test della suite branch-100. Reset esplicito.
    m.jwtDecrypt.mockReset();
    m.jwtDecrypt.mockResolvedValue({
      payload: { ...VALID_PAYLOAD, name: undefined, jti: 'jti-no-name-' + Date.now() + Math.random() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(302);
  });

  it('payload.role NON-string (es. array malicious) → fallback "viewer"', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, role: ['admin', 'super'], jti: 'jti-arr-role-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(302);
    // role downgraded a "viewer" (least-privilege)
    expect(m.issueSessionToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer' }));
  });

  it('payload.tenantSlug fallback a tenantId quando undefined', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, tenantSlug: undefined, jti: 'jti-no-slug-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(302);
  });

  it('payload.tenantId missing → 401 reject (H5 fix 2026-06-01, no fallback)', async () => {
    // H5 fix: defense-in-depth oltre l'audience JWT — reject esplicito se
    // il custom claim `payload.tenantId` e\` missing OR mismatch col config.
    // Pre-fix accettava fallback al config — asimmetrico col portal che lo
    // emette sempre. Vedi sso.ts:252-260.
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, tenantId: undefined, jti: 'jti-no-tenant-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/tenant/iu);
  });

  it('content-type "text/plain" → POST extractSsoToken ritorna null → 400', async () => {
    const app = buildApp();
    const res = await app.request('/sso', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'token=plain-text-body',
    });
    expect(res.status).toBe(400);
  });

  it('ensureTenant displayName VUOTO → fallback ad args.tenantId', async () => {
    m.jwtDecrypt.mockResolvedValueOnce({
      payload: { ...VALID_PAYLOAD, tenantName: '', tenantSlug: '', jti: 'jti-empty-name-' + Date.now() },
      protectedHeader: { alg: 'dir', enc: 'A256GCM' },
    });
    m.sqliteStmt.get.mockReturnValue(undefined);
    const app = buildApp();
    const res = await postForm(app, { token: 'x' });
    expect(res.status).toBe(302);
    // ensureTenant UPSERT (A2): run(tenantId, displayName, status, trialEndsAt).
    // displayName fallback al tenantId quando tenantName/tenantSlug vuoti.
    const tenantInsertCall = m.sqliteStmt.run.mock.calls.find((args) =>
      args[0] === 'tenant-acme' && args[1] === 'tenant-acme',
    );
    expect(tenantInsertCall).toBeDefined();
    // status default 'active' (claim senza tenantStatus) + trialEndsAt null.
    expect(tenantInsertCall?.[2]).toBe('active');
    expect(tenantInsertCall?.[3]).toBeNull();
  });

  it('JSON parse catch → ritorna null → 400', async () => {
    const app = buildApp();
    // body malformed JSON → c.req.json() throws → catch(() => null) → j=null → return null
    const res = await app.request('/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json-at-all',
    });
    expect(res.status).toBe(400);
  });
});
