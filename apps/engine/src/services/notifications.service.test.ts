/**
 * NotificationsService (#7 Tier 3) — su SQLite :memory: reale.
 * Risoluzione @handle→user, skip autore/handle ignoti, lista/unread/markRead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { NotificationsService } from './notifications.service.js';

beforeEach(() => {
  m.db = new Database(':memory:');
  // 2026-06-09 M6: users ora ha tenant_id NOT NULL DEFAULT 'default'
  m.db.exec(
    `CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', email TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, role TEXT NOT NULL DEFAULT 'viewer');`,
  );
  m.db.exec(`CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, workflow_id TEXT, node_id TEXT,
    actor_name TEXT NOT NULL, preview TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
  const ins = m.db.prepare('INSERT INTO users (id, tenant_id, email, enabled) VALUES (?, ?, ?, ?)');
  ins.run('u-ada', 't1', 'ada@x.it', 1);
  ins.run('u-marco', 't1', 'marco@x.it', 1);
  ins.run('u-disabled', 't1', 'gino@x.it', 0);
  // M6: utente "ada" anche in tenant t2 (es. super_admin SSO-impersonate)
  // → resolveMentionUserId('ada', 't1') NON deve mai trovare questo.
  ins.run('u-ada-t2', 't2', 'ada@x.it', 1);
});

describe('NotificationsService', () => {
  it('resolveMentionUserId risolve email per handle (tenant-scoped), ignora disabilitati e sconosciuti', () => {
    const svc = new NotificationsService();
    expect(svc.resolveMentionUserId('ada', 't1')).toBe('u-ada');
    expect(svc.resolveMentionUserId('ADA', 't1')).toBe('u-ada'); // case-insensitive
    expect(svc.resolveMentionUserId('gino', 't1')).toBeNull(); // enabled=0
    expect(svc.resolveMentionUserId('nessuno', 't1')).toBeNull();
  });

  /**
   * 🚨 AUDIT FIX M6 (2026-06-09) — REGRESSION GUARD:
   * Pre-fix: resolveMentionUserId('ada') matchava QUALSIASI ada@... globale,
   * permettendo cross-tenant leak via superadmin-impersonate. Ora la query
   * filtra per tenant_id → seed test ha ada in tenant t2 ma resolve('ada','t1')
   * deve dare u-ada (di t1), resolve('ada','t2') deve dare u-ada-t2 (di t2),
   * resolve('ada','t3') deve dare null (no leak).
   */
  it('🚨 [REGRESSION M6] resolveMentionUserId tenant-scoped — no cross-tenant leak', () => {
    const svc = new NotificationsService();
    expect(svc.resolveMentionUserId('ada', 't1')).toBe('u-ada');
    expect(svc.resolveMentionUserId('ada', 't2')).toBe('u-ada-t2');
    expect(svc.resolveMentionUserId('ada', 't3')).toBeNull();
    // Marco esiste solo in t1 → resolve in t2 = null
    expect(svc.resolveMentionUserId('marco', 't2')).toBeNull();
  });

  it('notifyForComment crea una notifica per handle risolto (tenant-scoped), salta autore e ignoti', () => {
    const svc = new NotificationsService();
    const n = svc.notifyForComment({
      mentions: ['ada', 'marco', 'nessuno'],
      authorUserId: 'u-marco',
      actorName: 'marco@x.it',
      workflowId: 'wf1',
      nodeId: 'n1',
      body: 'ehi @ada e @marco e @nessuno',
      tenantId: 't1',
    });
    expect(n).toBe(1); // solo ada (marco=autore, nessuno=non risolto)
    expect(svc.unreadCount('u-ada')).toBe(1);
    expect(svc.unreadCount('u-marco')).toBe(0);
    const [notif] = svc.list('u-ada');
    expect(notif?.type).toBe('mention');
    expect(notif?.workflowId).toBe('wf1');
    expect(notif?.actorName).toBe('marco@x.it');
    expect(notif?.read).toBe(false);
  });

  /**
   * 🚨 [REGRESSION M6] notifyForComment con tenantId di un tenant senza l'utente
   * non deve creare notifiche cross-tenant.
   */
  it('🚨 [REGRESSION M6] notifyForComment con tenantId X non risolve user di tenant Y', () => {
    const svc = new NotificationsService();
    // mention "marco" da tenant t2 — marco non esiste in t2 → 0 notifiche
    const n = svc.notifyForComment({
      mentions: ['marco'],
      authorUserId: 'u-other',
      actorName: 'other@y.it',
      workflowId: 'wf1',
      nodeId: null,
      body: 'ciao @marco',
      tenantId: 't2',
    });
    expect(n).toBe(0);
    expect(svc.unreadCount('u-marco')).toBe(0);
  });

  it('preview troncata a 200 char', () => {
    const svc = new NotificationsService();
    svc.create({ userId: 'u-ada', type: 'mention', actorName: 'x', preview: 'a'.repeat(500) });
    expect(svc.list('u-ada')[0]?.preview.length).toBe(200);
  });

  it('markRead solo del proprietario; markAllRead azzera unread', () => {
    const svc = new NotificationsService();
    svc.create({ userId: 'u-ada', type: 'mention', actorName: 'x', preview: 'p1' });
    svc.create({ userId: 'u-ada', type: 'mention', actorName: 'x', preview: 'p2' });
    const [first] = svc.list('u-ada');
    svc.markRead(first!.id, 'u-marco'); // utente sbagliato → no-op
    expect(svc.unreadCount('u-ada')).toBe(2);
    svc.markRead(first!.id, 'u-ada');
    expect(svc.unreadCount('u-ada')).toBe(1);
    svc.markAllRead('u-ada');
    expect(svc.unreadCount('u-ada')).toBe(0);
  });

  it('list unreadOnly filtra le lette', () => {
    const svc = new NotificationsService();
    svc.create({ userId: 'u-ada', type: 'mention', actorName: 'x', preview: 'p1' });
    svc.create({ userId: 'u-ada', type: 'mention', actorName: 'x', preview: 'p2' });
    svc.markRead(svc.list('u-ada')[0]!.id, 'u-ada');
    expect(svc.list('u-ada', { unreadOnly: true })).toHaveLength(1);
    expect(svc.list('u-ada')).toHaveLength(2);
  });
});

/**
 * 🚨 tenantAdminUserIds — destinatari delle notifiche di SISTEMA tenant-scoped
 * (es. Janitor detection). Deve: includere SOLO owner/superadmin, escludere
 * editor/viewer e disabilitati, ed essere TENANT-SCOPED (anti cross-tenant).
 */
describe('NotificationsService.tenantAdminUserIds', () => {
  function seedRole(id: string, tenantId: string, role: string, enabled = 1): void {
    m.db!.prepare(
      'INSERT INTO users (id, tenant_id, email, enabled, role) VALUES (?, ?, ?, ?, ?)',
    ).run(id, tenantId, `${id}@x.it`, enabled, role);
  }

  it('🚨 ritorna SOLO owner + superadmin del tenant; esclude editor/viewer', () => {
    seedRole('o1', 'tA', 'owner');
    seedRole('sa1', 'tA', 'superadmin');
    seedRole('ed1', 'tA', 'editor');
    seedRole('vw1', 'tA', 'viewer');
    const ids = new NotificationsService().tenantAdminUserIds('tA').sort();
    expect(ids).toEqual(['o1', 'sa1']);
  });

  it('🚨 esclude owner DISABILITATI (enabled=0)', () => {
    seedRole('o-on', 'tB', 'owner', 1);
    seedRole('o-off', 'tB', 'owner', 0);
    expect(new NotificationsService().tenantAdminUserIds('tB')).toEqual(['o-on']);
  });

  it('🚨 TENANT-SCOPE: owner di un altro tenant NON viene incluso', () => {
    seedRole('o-tc', 'tC', 'owner');
    seedRole('o-td', 'tD', 'owner');
    expect(new NotificationsService().tenantAdminUserIds('tC')).toEqual(['o-tc']);
    expect(new NotificationsService().tenantAdminUserIds('tD')).toEqual(['o-td']);
  });

  it('🚨 tenant senza owner → array vuoto (no crash)', () => {
    seedRole('ed-only', 'tE', 'editor');
    expect(new NotificationsService().tenantAdminUserIds('tE')).toEqual([]);
  });
});
