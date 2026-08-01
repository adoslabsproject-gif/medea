/**
 * Endpoint notifiche (#7 Tier 3) — e2e Hono + SQLite :memory: reale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { NotificationsService } from '@/services/notifications.service.js';
import { notificationsBus } from '@/services/notifications-bus.js';
import { createNotificationsRoutes } from './notifications.routes.js';

function makeApp(auth: { userId: string; email: string } | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth as never); await next(); });
  app.route('/', createNotificationsRoutes());
  return app;
}
const ada = { userId: 'u-ada', email: 'ada@x.it' };

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, workflow_id TEXT, node_id TEXT,
    actor_name TEXT NOT NULL, preview TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
  const svc = new NotificationsService();
  svc.create({ userId: 'u-ada', type: 'mention', actorName: 'marco@x.it', preview: 'p1' });
  svc.create({ userId: 'u-ada', type: 'mention', actorName: 'marco@x.it', preview: 'p2' });
});

describe('notifications routes', () => {
  it('no auth → 401 su tutti i metodi', async () => {
    expect((await makeApp(null).request('/')).status).toBe(401);
    expect((await makeApp(null).request('/read-all', { method: 'POST' })).status).toBe(401);
    expect((await makeApp(null).request('/x/read', { method: 'PATCH' })).status).toBe(401);
  });

  it('GET / elenca le notifiche dell\'utente con unread count', async () => {
    const res = await makeApp(ada).request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as { notifications: { id: string }[]; unread: number };
    expect(body.notifications).toHaveLength(2);
    expect(body.unread).toBe(2);
  });

  it('GET /?unread=1 filtra le lette', async () => {
    const all = await (await makeApp(ada).request('/')).json() as { notifications: { id: string }[] };
    await makeApp(ada).request(`/${all.notifications[0]!.id}/read`, { method: 'PATCH' });
    const body = await (await makeApp(ada).request('/?unread=1')).json() as { notifications: unknown[]; unread: number };
    expect(body.notifications).toHaveLength(1);
    expect(body.unread).toBe(1);
  });

  it('POST /read-all azzera unread', async () => {
    const res = await makeApp(ada).request('/read-all', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await (await makeApp(ada).request('/')).json() as { unread: number };
    expect(body.unread).toBe(0);
  });

  describe('GET /stream (SSE push real-time)', () => {
    /** Legge dal reader accumulando finché trova `needle` (o timeout di sicurezza). */
    async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 2000): Promise<string> {
      const decoder = new TextDecoder();
      let buf = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buf += decoder.decode(value, { stream: true });
        if (buf.includes(needle)) return buf;
      }
      throw new Error(`needle "${needle}" non trovato; buffer=${buf.slice(0, 200)}`);
    }

    it('senza auth → 401', async () => {
      const res = await makeApp(null).request('/stream');
      expect(res.status).toBe(401);
    });

    it('con auth → 200 text/event-stream + hello', async () => {
      const ac = new AbortController();
      const res = await makeApp(ada).request('/stream', { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const buf = await readUntil(reader, 'event: hello');
      expect(buf).toContain('event: hello');
      ac.abort();
      await reader.cancel().catch(() => { /* ignore */ });
    });

    it('emette sul bus dell\'utente → arriva l\'evento notification nello stream', async () => {
      const ac = new AbortController();
      const res = await makeApp(ada).request('/stream', { signal: ac.signal });
      const reader = res.body!.getReader();
      // Attendi hello → garantisce che il subscribe sia attivo prima di emettere.
      await readUntil(reader, 'event: hello');
      notificationsBus.emitToUser('u-ada', {
        id: 'live-1', userId: 'u-ada', type: 'mention', workflowId: 'wf9', nodeId: null,
        actorName: 'marco@x.it', preview: 'push test', read: false, createdAt: '2026-06-09T12:00:00.000Z',
      });
      const buf = await readUntil(reader, 'event: notification');
      expect(buf).toContain('event: notification');
      expect(buf).toContain('live-1');
      expect(buf).toContain('push test');
      ac.abort();
      await reader.cancel().catch(() => { /* ignore */ });
    });

    it('cleanup: dopo abort lo stream non lascia subscriber appesi', async () => {
      const ac = new AbortController();
      const res = await makeApp(ada).request('/stream', { signal: ac.signal });
      const reader = res.body!.getReader();
      await readUntil(reader, 'event: hello');
      expect(notificationsBus.listenerCount('u-ada')).toBeGreaterThanOrEqual(1);
      ac.abort();
      await reader.cancel().catch(() => { /* ignore */ });
      // onAbort → unsubscribe. Diamo un tick all'event loop.
      await new Promise((r) => setTimeout(r, 20));
      expect(notificationsBus.listenerCount('u-ada')).toBe(0);
    });
  });
});
