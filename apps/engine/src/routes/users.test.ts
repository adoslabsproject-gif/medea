/**
 * Test E2E REALE di POST /users/:id/revoke-sessions (owner force-revoke) — monta
 * la route vera con DB SQLite in-memory e verifica: owner→200 + cutoff effettivo
 * (un token vecchio del target diventa revocato), 404 su utente inesistente,
 * 403 per ruoli non-owner (requireRole). Niente stub del DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

let db: Database.Database;
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
vi.mock('@/lib/logger.js');

const { createUsersRoutes } = await import('./users.js');
const { isPayloadRevoked } = await import('@/services/security/session-revocation.js');

interface TestAuth { userId: string; role: string; email: string; tenantId: string }

function buildApp(auth: TestAuth | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth as never); return next(); });
  app.route('/api/v1', createUsersRoutes());
  return app;
}

const OWNER: TestAuth = { userId: 'owner-1', role: 'owner', email: 'o@x.it', tenantId: 'tenant-1' };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id TEXT, tenant_id TEXT, email TEXT, display_name TEXT, password_hash TEXT,
    role TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT, last_login_at TEXT,
    oauth_provider TEXT, is_system INTEGER DEFAULT 0
  )`);
  db.prepare('INSERT INTO users (id, tenant_id, email, display_name, role, enabled, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)')
    .run('target-user', 'tenant-1', 't@x.it', 'Target', 'editor', 'now', 'now');
});

describe('POST /users/:id/revoke-sessions — owner force-revoke', () => {
  it('owner → 200 + un token VECCHIO del target diventa revocato (cutoff effettivo)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await buildApp(OWNER).request('/api/v1/users/target-user/revoke-sessions', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; userId: string };
    expect(body.ok).toBe(true);
    expect(body.userId).toBe('target-user');
    // effetto reale: token emesso PRIMA della revoca ora rifiutato dal middleware
    expect(isPayloadRevoked({ jti: 'old', sub: 'target-user', iat: nowSec - 50 })).toBe(true);
    // un altro utente non è toccato
    expect(isPayloadRevoked({ jti: 'x', sub: 'altro-user', iat: nowSec - 50 })).toBe(false);
  });
  it('404 su utente inesistente nel tenant', async () => {
    const res = await buildApp(OWNER).request('/api/v1/users/ghost/revoke-sessions', { method: 'POST' });
    expect(res.status).toBe(404);
  });
  it('non-owner (editor) → 403 (requireRole owner-only)', async () => {
    const editor: TestAuth = { userId: 'u', role: 'editor', email: 'e@x.it', tenantId: 'tenant-1' };
    const res = await buildApp(editor).request('/api/v1/users/target-user/revoke-sessions', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
