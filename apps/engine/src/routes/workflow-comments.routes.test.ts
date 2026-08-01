/**
 * Endpoint commenti (#7 Tier 3) — e2e Hono + SQLite :memory: reale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { WorkflowCommentsService } from '@/services/workflow-comments.service.js';
import { NotificationsService } from '@/services/notifications.service.js';
import { registerWorkflowCommentsRoutes } from './workflow-comments.routes.js';
import type { WorkflowService } from '@/services/workflow.service.js';

/**
 * Stub WorkflowService — simula gate H3 tenant-scoped per i test.
 * Default: ['wf1'] esiste nel tenant 't1'.
 */
function makeStubWorkflowService(existsIds: Set<string>, tenantId = 't1'): WorkflowService {
  return {
    get: async (id: string, tid = 'default') => {
      if (tid !== tenantId) return null;
      return existsIds.has(id) ? ({ id, tenantId: tid } as never) : null;
    },
  } as unknown as WorkflowService;
}

function makeApp(
  auth: { userId: string; email: string; tenantId?: string } | null,
  options: { existsIds?: Set<string>; tenantId?: string } = {},
): Hono {
  const app = new Hono();
  const tenantId = options.tenantId ?? 't1';
  const fullAuth = auth ? { tenantId, ...auth } : null;
  app.use('*', async (c, next) => { c.set('auth', fullAuth as never); await next(); });
  const stubWf = makeStubWorkflowService(options.existsIds ?? new Set(['wf1']), tenantId);
  registerWorkflowCommentsRoutes(app, new WorkflowCommentsService(), new NotificationsService(), stubWf);
  return app;
}
const marco = { userId: 'marco', email: 'marco@x.it' };
const ada = { userId: 'ada', email: 'ada@x.it' };

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`CREATE TABLE workflow_comments (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT, user_id TEXT NOT NULL,
    user_name TEXT NOT NULL, body TEXT NOT NULL, mentions_json TEXT, resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
  // M6 (2026-06-09): users con tenant_id, seed nel tenant del test (default 't1')
  m.db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 't1', email TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);`);
  m.db.exec(`CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, workflow_id TEXT, node_id TEXT,
    actor_name TEXT NOT NULL, preview TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
  m.db.prepare("INSERT INTO users (id, tenant_id, email, enabled) VALUES (?, 't1', ?, 1)").run('ada', 'ada@x.it');
  m.db.prepare("INSERT INTO users (id, tenant_id, email, enabled) VALUES (?, 't1', ?, 1)").run('marco', 'marco@x.it');
});

describe('workflow comments routes', () => {
  it('no auth → 401', async () => {
    expect((await makeApp(null).request('/wf1/comments')).status).toBe(401);
  });

  it('POST commento vuoto → 400', async () => {
    const res = await makeApp(marco).request('/wf1/comments', { method: 'POST', body: JSON.stringify({ body: '  ' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('POST → 201 con commento + @mentions; GET lo elenca', async () => {
    const post = await makeApp(marco).request('/wf1/comments', { method: 'POST', body: JSON.stringify({ nodeId: 'n1', body: 'ehi @ada' }), headers: { 'content-type': 'application/json' } });
    expect(post.status).toBe(201);
    const created = await post.json() as { comment: { mentions: string[]; userName: string } };
    expect(created.comment.mentions).toEqual(['ada']);
    expect(created.comment.userName).toBe('marco@x.it');

    const list = await (await makeApp(ada).request('/wf1/comments?nodeId=n1')).json() as { comments: unknown[] };
    expect(list.comments).toHaveLength(1);

    // @ada deve aver ricevuto una notifica push; @marco (autore) no.
    const notifAda = m.db!.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get('ada') as { n: number };
    const notifMarco = m.db!.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get('marco') as { n: number };
    expect(notifAda.n).toBe(1);
    expect(notifMarco.n).toBe(0);
  });

  it('GET counts per badge nodo', async () => {
    await makeApp(marco).request('/wf1/comments', { method: 'POST', body: JSON.stringify({ nodeId: 'n1', body: 'c1' }), headers: { 'content-type': 'application/json' } });
    const res = await makeApp(marco).request('/wf1/comments/counts');
    const body = await res.json() as { counts: Record<string, number> };
    expect(body.counts.n1).toBe(1);
  });

  it('DELETE solo del proprietario (403 se altro utente)', async () => {
    const post = await makeApp(marco).request('/wf1/comments', { method: 'POST', body: JSON.stringify({ body: 'x' }), headers: { 'content-type': 'application/json' } });
    const { comment } = await post.json() as { comment: { id: string } };
    const byAda = await makeApp(ada).request(`/wf1/comments/${comment.id}`, { method: 'DELETE' });
    expect(byAda.status).toBe(403);
    const byMarco = await makeApp(marco).request(`/wf1/comments/${comment.id}`, { method: 'DELETE' });
    expect(byMarco.status).toBe(200);
  });

  it('PATCH resolve', async () => {
    const post = await makeApp(marco).request('/wf1/comments', { method: 'POST', body: JSON.stringify({ nodeId: 'n1', body: 'x' }), headers: { 'content-type': 'application/json' } });
    const { comment } = await post.json() as { comment: { id: string } };
    const res = await makeApp(marco).request(`/wf1/comments/${comment.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    const counts = await (await makeApp(marco).request('/wf1/comments/counts')).json() as { counts: Record<string, number> };
    expect(counts.counts.n1).toBeUndefined(); // risolto → non contato
  });

  /**
   * 🚨 AUDIT FIX H2 (2026-06-09) — REGRESSION GUARD:
   * Pre-fix: PATCH/DELETE su /:wfid/comments/:commentId con commentId valido
   * MA wfid sbagliato risolvevano comunque il commento (UPDATE WHERE id=?
   * senza workflow_id filter). Cross-tenant impersonate sfruttabile.
   */
  it('🚨 [REGRESSION H2] PATCH con commentId valido ma workflow_id sbagliato → 404', async () => {
    const post = await makeApp(marco, { existsIds: new Set(['wf1', 'wf2']) }).request(
      '/wf1/comments', { method: 'POST', body: JSON.stringify({ body: 'x' }), headers: { 'content-type': 'application/json' } },
    );
    const { comment } = await post.json() as { comment: { id: string } };
    const res = await makeApp(marco, { existsIds: new Set(['wf1', 'wf2']) }).request(
      `/wf2/comments/${comment.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }), headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(404);
  });

  /**
   * 🚨 AUDIT FIX H3 (2026-06-09) — REGRESSION GUARD:
   * Workflow inesistente nel tenant → 404 invece di creare commento.
   */
  it('🚨 [REGRESSION H3] POST su workflow inesistente → 404 (no comment created)', async () => {
    const res = await makeApp(marco, { existsIds: new Set(['wf1']) }).request(
      '/wf-ghost/comments', { method: 'POST', body: JSON.stringify({ body: 'x' }), headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(404);
  });

  it('🚨 [REGRESSION H3] cross-tenant via impersonate → 404 (tenantId diverso)', async () => {
    const app = makeApp({ ...marco, tenantId: 't2' }, { existsIds: new Set(['wf1']), tenantId: 't1' });
    const res = await app.request('/wf1/comments', { method: 'POST', body: JSON.stringify({ body: 'x' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(404);
  });
});
