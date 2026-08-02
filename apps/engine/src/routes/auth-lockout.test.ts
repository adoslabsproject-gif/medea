/**
 * AUDIT FIX AUTH-2 (2026-06-09 HIGH) — REGRESSION GUARD E2E:
 *
 * Invariante:
 *   "POST /auth/login implementa progressive lockout:
 *    - 5° fail consecutivo → locked 15min, lockout_level=1
 *    - dopo unlock + 5° fail nuovo → 1h, lockout_level=2
 *    - dopo unlock + 5° fail nuovo → 24h, lockout_level=3
 *    - durante lockout → 423 ACCOUNT_LOCKED
 *    - success → reset counter + level"
 *
 * Pre-fix bug: brute force illimitato. trackFailedLogin (Sentinel) era
 * suppressed-after-5-in-30min ma non-bloccante → attacker poteva continuare.
 *
 * Test coverage:
 *   - SCHEMA: failed_login_count, locked_until, lockout_level esistono
 *   - 4 fail consecutivi → ancora 401 (sotto soglia), counter incrementa
 *   - 5° fail → 401 + lockout settato (1° escalation = 15min)
 *   - tentativo durante lockout → 423 ACCOUNT_LOCKED + retryAfter
 *   - success → reset complete (counter=0, level=0, locked=NULL)
 *   - lockout expired → next fail riparte da counter=1
 */
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  sqliteGet: vi.fn(),
  sqliteRun: vi.fn(),
  verifyPassword: vi.fn(),
  trackFailedLogin: vi.fn(),
  issueSessionToken: vi.fn(),
  getAuthKeys: vi.fn(),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      exec: vi.fn(),
      prepare: (_sql: string) => ({
        get: (...args: unknown[]) => m.sqliteGet(_sql, ...args),
        run: (...args: unknown[]) => m.sqliteRun(_sql, ...args),
        all: () => [],
      }),
    },
  }),
}));

vi.mock('@medea/engine-auth-local', () => ({
  verifyPassword: (...a: unknown[]) => m.verifyPassword(...a),
  issueSessionToken: (...a: unknown[]) => m.issueSessionToken(...a),
}));

vi.mock('@/services/security/login-tracker.js', () => ({
  trackFailedLogin: (...a: unknown[]) => m.trackFailedLogin(...a),
}));

vi.mock('@/lib/auth-keys.js', () => ({
  getAuthKeys: () => m.getAuthKeys(),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/config.js', () => ({ loadConfig: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.getAuthKeys.mockResolvedValue({ privateKeyPem: 'mock-pem' });
  m.issueSessionToken.mockResolvedValue('mock-jwt');
});

async function buildApp(): Promise<Hono> {
  const { createAuthRoutes } = await import('./auth.js');
  const app = new Hono();
  app.route('/api/v1', createAuthRoutes());
  return app;
}

function makeUserRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    email: 'mario@test.it',
    tenant_id: 't-1',
    password_hash: 'argon2-hash',
    role: 'editor',
    display_name: 'Mario',
    enabled: 1,
    failed_login_count: 0,
    locked_until: null,
    lockout_level: 0,
    ...over,
  };
}

describe('🚨 [REGRESSION AUTH-2] runtime /auth/login lockout', () => {
  it('🚨 user not found → 401 + delay 100ms + trackFailedLogin', async () => {
    m.sqliteGet.mockReturnValue(undefined); // user not found
    const app = await buildApp();
    const t0 = Date.now();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'ghost@x.it', password: 'pw' }),
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(401);
    expect(elapsed).toBeGreaterThanOrEqual(95); // ~100ms anti-enumeration delay
    expect(m.trackFailedLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ghost@x.it' }),
    );
  });

  it('🚨 password sbagliata + counter < 5 → 401, counter++, no lockout', async () => {
    m.sqliteGet.mockReturnValue(makeUserRow({ failed_login_count: 2 }));
    m.verifyPassword.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    // UPDATE called con failed_login_count=3 (2+1), locked_until=NULL
    const updateCall = m.sqliteRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE users SET failed_login_count'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toBe(3); // new failed_count
    expect(updateCall![2]).toBeNull(); // locked_until still NULL
    expect(updateCall![3]).toBe(0); // lockout_level still 0
  });

  it('🚨 5° fail consecutivo → lockout 15min + level=1', async () => {
    m.sqliteGet.mockReturnValue(makeUserRow({ failed_login_count: 4, lockout_level: 0 }));
    m.verifyPassword.mockResolvedValue(false);
    const app = await buildApp();
    const t0 = Date.now();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const updateCall = m.sqliteRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE users SET failed_login_count'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toBe(5); // counter=5
    expect(updateCall![2]).toBeTypeOf('string'); // locked_until ISO string set
    expect(updateCall![3]).toBe(1); // lockout_level=1
    // verifica TTL ~15min
    const lockedUntilMs = new Date(updateCall![2] as string).getTime();
    const deltaMs = lockedUntilMs - t0;
    expect(deltaMs).toBeGreaterThan(14 * 60_000);
    expect(deltaMs).toBeLessThan(16 * 60_000);
  });

  it('🚨 escalation level 2 (1h) dopo lockout già visto', async () => {
    m.sqliteGet.mockReturnValue(makeUserRow({ failed_login_count: 4, lockout_level: 1 }));
    m.verifyPassword.mockResolvedValue(false);
    const app = await buildApp();
    const t0 = Date.now();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const updateCall = m.sqliteRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE users SET failed_login_count'),
    );
    expect(updateCall![3]).toBe(2); // lockout_level=2
    const lockedUntilMs = new Date(updateCall![2] as string).getTime();
    const deltaMs = lockedUntilMs - t0;
    expect(deltaMs).toBeGreaterThan(59 * 60_000);
    expect(deltaMs).toBeLessThan(61 * 60_000);
  });

  it('🚨 escalation level 3 (24h) dopo 2 lockout già visti, capped a 3', async () => {
    m.sqliteGet.mockReturnValue(makeUserRow({ failed_login_count: 4, lockout_level: 3 }));
    m.verifyPassword.mockResolvedValue(false);
    const app = await buildApp();
    const t0 = Date.now();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const updateCall = m.sqliteRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE users SET failed_login_count'),
    );
    expect(updateCall![3]).toBe(3); // capped a 3
    const lockedUntilMs = new Date(updateCall![2] as string).getTime();
    const deltaMs = lockedUntilMs - t0;
    expect(deltaMs).toBeGreaterThan(23 * 60 * 60_000);
    expect(deltaMs).toBeLessThan(25 * 60 * 60_000);
  });

  it('🚨 login durante lockout → 423 ACCOUNT_LOCKED + retryAfter', async () => {
    const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
    m.sqliteGet.mockReturnValue(makeUserRow({ locked_until: futureIso, lockout_level: 1 }));
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'whatever' }),
    });
    expect(res.status).toBe(423);
    const body = (await res.json()) as { code: string; retryAfter: string };
    expect(body.code).toBe('ACCOUNT_LOCKED');
    expect(body.retryAfter).toBe(futureIso);
    // CRITICO: verifyPassword NON deve essere chiamato (no CPU spend per attacker)
    expect(m.verifyPassword).not.toHaveBeenCalled();
  });

  it('🚨 successo login → reset complete (counter=0, level=0, locked=NULL, last_login_at)', async () => {
    m.sqliteGet.mockReturnValue(makeUserRow({ failed_login_count: 3, lockout_level: 1 }));
    m.verifyPassword.mockResolvedValue(true);
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'correct' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBe('mock-jwt');
    // UPDATE reset chiamato
    const resetCall = m.sqliteRun.mock.calls.find(
      (c) =>
        String(c[0]).includes('failed_login_count = 0') &&
        String(c[0]).includes('locked_until = NULL'),
    );
    expect(resetCall, 'success deve reset failed_login_count + locked_until').toBeTruthy();
  });

  it('🚨 lockout expired (past) → next fail riparte counter da pre-existing+1', async () => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    m.sqliteGet.mockReturnValue(
      makeUserRow({ failed_login_count: 5, lockout_level: 1, locked_until: pastIso }),
    );
    m.verifyPassword.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't-1' },
      body: JSON.stringify({ email: 'mario@test.it', password: 'wrong' }),
    });
    expect(res.status).toBe(401); // NOT 423, lockout scaduto
    const updateCall = m.sqliteRun.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE users SET failed_login_count'),
    );
    expect(updateCall![1]).toBe(6); // counter incrementato
  });
});

/**
 * 🚨 [REGRESSION AUTH-2 SCHEMA] Verifica che migrate.ts contenga
 * ensureColumn per i 3 campi del lockout.
 */
describe('🚨 [REGRESSION AUTH-2 SCHEMA] migrate.ts contiene ensureColumn lockout', () => {
  it('🚨 failed_login_count + locked_until + lockout_level ensured', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, '..', 'storage', 'migrate.ts'), 'utf-8');
    expect(src).toMatch(/ensureColumn\([^,]+,\s*['"]users['"],\s*['"]failed_login_count['"]/);
    expect(src).toMatch(/ensureColumn\([^,]+,\s*['"]users['"],\s*['"]locked_until['"]/);
    expect(src).toMatch(/ensureColumn\([^,]+,\s*['"]users['"],\s*['"]lockout_level['"]/);
  });
});
