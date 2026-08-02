/**
 * NotificationsService.create → push real-time (#7 Tier 3): verifica che ogni
 * notifica creata venga anche emessa sul notifications-bus (delivery SSE).
 * File separato dal test principale per isolare il mock del bus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { NotificationsService } from './notifications.service.js';
import { notificationsBus } from './notifications-bus.js';
import type { Notification } from './notifications.service.js';

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, workflow_id TEXT, node_id TEXT,
    actor_name TEXT NOT NULL, preview TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
});

describe('NotificationsService.create → notifications-bus', () => {
  it("emette sul bus dell'utente la notifica appena creata (coerente col DB)", () => {
    const received: Notification[] = [];
    const off = notificationsBus.subscribe('u-ada', (n) => {
      received.push(n);
    });

    new NotificationsService().create({
      userId: 'u-ada',
      type: 'mention',
      workflowId: 'wf1',
      nodeId: 'n1',
      actorName: 'marco@x.it',
      preview: 'guarda @ada',
    });

    expect(received).toHaveLength(1);
    const pushed = received[0]!;
    expect(pushed.userId).toBe('u-ada');
    expect(pushed.type).toBe('mention');
    expect(pushed.workflowId).toBe('wf1');
    expect(pushed.nodeId).toBe('n1');
    expect(pushed.read).toBe(false);
    // L'oggetto emesso deve combaciare con la riga persistita (id + createdAt).
    const row = m
      .db!.prepare('SELECT id, created_at FROM notifications WHERE user_id = ?')
      .get('u-ada') as { id: string; created_at: string };
    expect(pushed.id).toBe(row.id);
    expect(pushed.createdAt).toBe(row.created_at);
    off();
  });

  it("preview troncata a 200 char anche nell'evento pushato", () => {
    const received: Notification[] = [];
    const off = notificationsBus.subscribe('u-b', (n) => {
      received.push(n);
    });
    new NotificationsService().create({
      userId: 'u-b',
      type: 'mention',
      actorName: 'x',
      preview: 'a'.repeat(500),
    });
    expect(received[0]!.preview.length).toBe(200);
    off();
  });
});
