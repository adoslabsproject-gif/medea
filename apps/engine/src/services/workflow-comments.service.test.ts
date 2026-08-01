import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { WorkflowCommentsService } from './workflow-comments.service.js';

const svc = new WorkflowCommentsService();

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`CREATE TABLE workflow_comments (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT, user_id TEXT NOT NULL,
    user_name TEXT NOT NULL, body TEXT NOT NULL, mentions_json TEXT, resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
});

describe('WorkflowCommentsService', () => {
  it('add estrae @mentions + persiste + ritorna il commento', () => {
    const c = svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'u1', userName: 'marco@x.it', body: 'ehi @ada vedi qui' });
    expect(c.mentions).toEqual(['ada']);
    expect(c.resolved).toBe(false);
    expect(c.nodeId).toBe('n1');
  });

  it('list per nodo vs intero workflow', () => {
    svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'u1', userName: 'a', body: 'su n1' });
    svc.add({ workflowId: 'wf1', nodeId: 'n2', userId: 'u1', userName: 'a', body: 'su n2' });
    svc.add({ workflowId: 'wf1', nodeId: null, userId: 'u1', userName: 'a', body: 'generale' });
    expect(svc.list('wf1')).toHaveLength(3);
    expect(svc.list('wf1', 'n1').map((c) => c.body)).toEqual(['su n1']);
    expect(svc.list('wf1', null).map((c) => c.body)).toEqual(['generale']);
  });

  it('countsByNode conta solo i non risolti, per nodo', () => {
    svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'u1', userName: 'a', body: 'c1' });
    const c2 = svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'u1', userName: 'a', body: 'c2' });
    svc.add({ workflowId: 'wf1', nodeId: 'n2', userId: 'u1', userName: 'a', body: 'c3' });
    svc.setResolved(c2.id, true, 'wf1');
    expect(svc.countsByNode('wf1')).toEqual({ n1: 1, n2: 1 });
  });

  it('remove solo del proprietario + workflow_id check', () => {
    const c = svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'marco', userName: 'm', body: 'x' });
    expect(svc.remove(c.id, 'ada', 'wf1')).toBe(false); // non suo
    expect(svc.list('wf1')).toHaveLength(1);
    expect(svc.remove(c.id, 'marco', 'wf1')).toBe(true);
    expect(svc.list('wf1')).toHaveLength(0);
  });

  it('setResolved toggle', () => {
    const c = svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'u1', userName: 'a', body: 'x' });
    svc.setResolved(c.id, true, 'wf1');
    expect(svc.list('wf1', 'n1')[0]?.resolved).toBe(true);
    svc.setResolved(c.id, false, 'wf1');
    expect(svc.list('wf1', 'n1')[0]?.resolved).toBe(false);
  });

  /**
   * 🚨 AUDIT FIX H2 (2026-06-09) — REGRESSION GUARD:
   * Pre-fix: setResolved(id, resolved) usava UPDATE WHERE id=? senza filter
   * workflow_id → chiunque autenticato cross-tenant impersonate poteva risolvere
   * commenti di altro workflow. Ora setResolved richiede workflowId esplicito e
   * ritorna boolean (false = commento non appartiene al workflow).
   */
  it('🚨 [REGRESSION H2] setResolved con workflow_id sbagliato → ritorna false (no cross-workflow)', () => {
    const c = svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'u1', userName: 'a', body: 'x' });
    expect(svc.setResolved(c.id, true, 'wf-OTHER')).toBe(false);
    expect(svc.list('wf1', 'n1')[0]?.resolved).toBe(false);
    expect(svc.setResolved(c.id, true, 'wf1')).toBe(true);
    expect(svc.list('wf1', 'n1')[0]?.resolved).toBe(true);
  });

  /**
   * 🚨 AUDIT FIX H3 (2026-06-09) — REGRESSION GUARD:
   * remove richiede ora workflow_id come defense-in-depth (collisione id).
   */
  it('🚨 [REGRESSION H3] remove con workflow_id sbagliato → ritorna false', () => {
    const c = svc.add({ workflowId: 'wf1', nodeId: 'n1', userId: 'marco', userName: 'm', body: 'x' });
    expect(svc.remove(c.id, 'marco', 'wf-OTHER')).toBe(false);
    expect(svc.list('wf1')).toHaveLength(1);
    expect(svc.remove(c.id, 'marco', 'wf1')).toBe(true);
    expect(svc.list('wf1')).toHaveLength(0);
  });
});
