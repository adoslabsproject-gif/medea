/**
 * Bug-bounty FULL-REQUEST-PATH — routes/viewer-share.ts (audit coverage
 * 2026-06-12: route a ZERO, ViewerShareService 19%). Doppia superficie:
 * CRUD owner-only dei token + endpoint PUBBLICO senza auth (il link
 * condivisibile) — la combinazione più delicata del runtime.
 *
 * Invarianti pinnate:
 *   - CRUD owner-only (viewer/editor/operator→403) MA il middleware è
 *     PATH-SPECIFIC: una route SORELLA montata sullo stesso prefix NON
 *     viene scopata (la lezione delle 2 regressioni dashboard:
 *     `app.use('*')` su sub-app montato = 401 leak sul namespace intero);
 *   - public: token valido→200 scoped al SOLO tenant del token; token
 *     inventato→401; token di A sul path di B→401 (no escalation);
 *     token revocato→401; token SCADUTO→401 (expires_at nel passato);
 *   - la response pubblica non leaka dati di altri tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { createViewerShareRoutes, createPublicShareRoutes } from './viewer-share.js';
import type { AuthContext } from '@/middleware/auth.js';

const T_A = `test-vshare-${Date.now().toString(36)}-a`;
const T_B = `test-vshare-${Date.now().toString(36)}-b`;

let authCtx: AuthContext | null = null;
const asUser = (tenantId: string, role: AuthContext['role']): void => {
  authCtx = { userId: `u-${role}`, tenantId, email: `${role}@test.it`, role };
};

let app: Hono;
interface SqliteLike { prepare: (s: string) => { get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown } }
const db = (): SqliteLike => getDatabase().sqlite as unknown as SqliteLike;

beforeAll(() => {
  runMigrations();
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx); await next(); });
  // Montaggio IDENTICO a server.ts: stesso prefix /api/v1 + route sorella
  // per il test anti-scope-leak (la lezione dashboard).
  app.route('/api/v1', createViewerShareRoutes());
  app.route('/api/v1', createPublicShareRoutes());
  const sibling = new Hono();
  sibling.get('/sibling-di-controllo', (c) => c.json({ ok: true }));
  app.route('/api/v1', sibling);
});

afterAll(() => {
  db().prepare("DELETE FROM viewer_share_tokens WHERE tenant_id LIKE 'test-vshare-%'").run();
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

describe('viewer-share — CRUD owner-only e scope del middleware', () => {
  it('viewer/editor/operator → 403 su list e create (gate path-specific)', async () => {
    for (const role of ['viewer', 'editor', 'operator'] as const) {
      asUser(T_A, role);
      expect((await req('GET', '/viewer-share')).status, `GET come ${role}`).toBe(403);
      expect((await req('POST', '/viewer-share', { name: 'x' })).status, `POST come ${role}`).toBe(403);
    }
  });

  it('ANTI-REGRESSIONE dashboard: il gate owner di /viewer-share NON scopa le route SORELLE su /api/v1', async () => {
    asUser(T_A, 'viewer'); // ruolo che su /viewer-share prende 403
    const res = await req('GET', '/sibling-di-controllo');
    expect(res.status).toBe(200); // se il middleware fosse use('*') → 403 qui
  });

  it('senza auth → 401, mai 200', async () => {
    authCtx = null;
    expect((await req('GET', '/viewer-share')).status).not.toBe(200);
  });

  it('owner crea token (64 hex), lo vede in list, expiresInDays oltre il cap → 400', async () => {
    asUser(T_A, 'owner');
    const res = await req('POST', '/viewer-share', { name: 'Cliente X', expiresInDays: 30 });
    expect(res.status).toBe(201);
    const { token } = await res.json() as { token: { token: string; id: string } };
    expect(token.token).toMatch(/^[0-9a-f]{64}$/);
    const list = await (await req('GET', '/viewer-share')).json() as { tokens: { id: string }[] };
    expect(list.tokens.some((t) => t.id === token.id)).toBe(true);
    expect((await req('POST', '/viewer-share', { name: 'x', expiresInDays: 9999 })).status).toBe(400);
  });
});

describe('viewer-share — endpoint PUBBLICO (il link condivisibile)', () => {
  let tokenA = '';
  let tokenIdA = '';

  beforeAll(async () => {
    asUser(T_A, 'owner');
    const res = await req('POST', '/viewer-share', { name: 'pubblico' });
    const data = await res.json() as { token: { token: string; id: string } };
    tokenA = data.token.token;
    tokenIdA = data.token.id;
  });

  it('SENZA auth + token valido → 200, scoped al SOLO tenant del token', async () => {
    authCtx = null; // il path pubblico non richiede sessione BY DESIGN
    const res = await req('GET', `/share/${T_A}/${tokenA}/dashboard`);
    expect(res.status).toBe(200);
    const data = await res.json() as { tenantId: string };
    expect(data.tenantId).toBe(T_A);
  });

  it('token INVENTATO → 401; token di A sul path del tenant B → 401 (no escalation cross-tenant)', async () => {
    authCtx = null;
    expect((await req('GET', `/share/${T_A}/${'0'.repeat(64)}/dashboard`)).status).toBe(401);
    expect((await req('GET', `/share/${T_B}/${tokenA}/dashboard`)).status).toBe(401);
  });

  it('token SCADUTO → 401 (expires_at nel passato, manipolato direttamente in tabella)', async () => {
    db().prepare('UPDATE viewer_share_tokens SET expires_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', tokenIdA);
    authCtx = null;
    expect((await req('GET', `/share/${T_A}/${tokenA}/dashboard`)).status).toBe(401);
    db().prepare('UPDATE viewer_share_tokens SET expires_at = NULL WHERE id = ?').run(tokenIdA);
  });

  it('token REVOCATO dall owner → il link pubblico muore subito', async () => {
    asUser(T_A, 'owner');
    const revoked = await req('DELETE', `/viewer-share/${tokenIdA}`);
    expect(revoked.status).toBe(200);
    authCtx = null;
    expect((await req('GET', `/share/${T_A}/${tokenA}/dashboard`)).status).toBe(401);
  });
});
