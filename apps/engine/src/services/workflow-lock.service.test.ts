/**
 * WorkflowLockService — test con SQLite :memory: reale (DB vero, no mock della
 * logica). Copre acquire / held / takeover / heartbeat / release / status.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { WorkflowLockService } from './workflow-lock.service.js';
import { LOCK_TTL_MS } from './workflow-lock.logic.js';

const svc = new WorkflowLockService();
const T0 = 1_000_000;

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`CREATE TABLE workflow_locks (
    workflow_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
    acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL);`);
});

describe('WorkflowLockService', () => {
  it('acquire su workflow libero → ok (free) + status mine', () => {
    const d = svc.acquire('wf1', 'marco', 'Marco', T0);
    expect(d).toEqual({ ok: true, reason: 'free' });
    expect(svc.status('wf1', 'marco', T0)).toEqual({
      locked: true,
      mine: true,
      by: { userId: 'marco', userName: 'Marco' },
    });
  });

  it('secondo utente su lock VIVO → held (409), status not-mine con chi edita', () => {
    svc.acquire('wf1', 'marco', 'Marco', T0);
    const d = svc.acquire('wf1', 'ada', 'Ada', T0 + 1000);
    expect(d.ok).toBe(false);
    expect(d).toMatchObject({ reason: 'held', by: { userId: 'marco', userName: 'Marco' } });
    const st = svc.status('wf1', 'ada', T0 + 1000);
    expect(st).toMatchObject({ locked: true, mine: false, by: { userName: 'Marco' } });
  });

  it('heartbeat dello stesso utente rinnova; di un altro → false', () => {
    svc.acquire('wf1', 'marco', 'Marco', T0);
    expect(svc.heartbeat('wf1', 'marco', T0 + 5000)).toBe(true);
    expect(svc.heartbeat('wf1', 'ada', T0 + 5000)).toBe(false);
  });

  it('takeover dopo scadenza TTL (lock orfano)', () => {
    svc.acquire('wf1', 'marco', 'Marco', T0);
    // marco non manda heartbeat → ada fa takeover oltre il TTL
    const d = svc.acquire('wf1', 'ada', 'Ada', T0 + LOCK_TTL_MS + 1);
    expect(d).toEqual({ ok: true, reason: 'takeover_expired' });
    expect(svc.status('wf1', 'ada', T0 + LOCK_TTL_MS + 1)).toMatchObject({ mine: true });
  });

  it('release del proprietario libera; release di altro utente NON tocca il lock', () => {
    svc.acquire('wf1', 'marco', 'Marco', T0);
    svc.release('wf1', 'ada'); // non è suo → no-op
    expect(svc.status('wf1', 'marco', T0).locked).toBe(true);
    svc.release('wf1', 'marco');
    expect(svc.status('wf1', 'marco', T0).locked).toBe(false);
  });

  it('lock scaduto → status locked=false (trattato come libero)', () => {
    svc.acquire('wf1', 'marco', 'Marco', T0);
    expect(svc.status('wf1', 'ada', T0 + LOCK_TTL_MS + 1)).toEqual({ locked: false, mine: false });
  });

  it('re-acquire dello stesso utente mantiene acquired_at, aggiorna heartbeat', () => {
    svc.acquire('wf1', 'marco', 'Marco', T0);
    const d = svc.acquire('wf1', 'marco', 'Marco', T0 + 10_000);
    expect(d).toEqual({ ok: true, reason: 'reacquired' });
    const row = m
      .db!.prepare('SELECT acquired_at, heartbeat_at FROM workflow_locks WHERE workflow_id = ?')
      .get('wf1') as { acquired_at: number; heartbeat_at: number };
    expect(row.acquired_at).toBe(T0);
    expect(row.heartbeat_at).toBe(T0 + 10_000);
  });
});
