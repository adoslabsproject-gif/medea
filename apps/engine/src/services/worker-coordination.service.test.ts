/**
 * Test 2026-grade — WorkerCoordinationService (distributed worker roster).
 *
 * 🚨 OPS-CRITICAL: heartbeat + janitor + control-intent queue per workers
 * production. Test reali con SQLite :memory: + schema completo (base +
 * ensureColumn additions).
 *
 * Coverage:
 *  - register: INSERT idempotent (ON CONFLICT replace)
 *  - heartbeat: UPDATE last_heartbeat_at; silent on DB error (no throw)
 *  - janitor: status='dead' per workers stale > 60s; preserve già dead
 *  - markBusy / markIdle: status transitions + runs_executed counter
 *  - listActive: SELECT all + DESC by heartbeat + DbRow → WorkerRow map
 *  - 🚨 requestAction: queue intent → consumePendingAction atomic clear
 *  - 🚨 requestConcurrency: Zod 1-64 throw out-of-range; integer required
 *  - 🚨 consumePendingAction: returns + ATOMICALLY clears (exactly-once)
 *  - setDraining / setIdle: status transition con guard 'dead'
 *  - setConcurrency: live value update
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  sqlite: null as unknown as ReturnType<typeof Database>,
  nanoidCounter: 0,
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.sqlite }),
}));

vi.mock('@/lib/logger.js');

vi.mock('nanoid', () => ({
  nanoid: () => {
    m.nanoidCounter += 1;
    return `nid-${String(m.nanoidCounter).padStart(4, '0')}`;
  },
}));

import {
  WorkerCoordinationService,
  type WorkerControlAction,
} from './worker-coordination.service.js';

function setupSchema(db: ReturnType<typeof Database>): void {
  // Base schema (da migrate.schema.ts) + ensureColumn additions (da migrate.ts)
  db.exec(`
    CREATE TABLE workers (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      pid INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      current_run_id TEXT,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      runs_executed INTEGER NOT NULL DEFAULT 0,
      version TEXT,
      requested_action TEXT,
      requested_concurrency INTEGER,
      requested_action_at TEXT,
      requested_action_by TEXT,
      concurrency INTEGER NOT NULL DEFAULT 1
    );
  `);
}

beforeEach(() => {
  m.sqlite = new Database(':memory:');
  setupSchema(m.sqlite);
  m.nanoidCounter = 0;
});

describe('register() — idempotent INSERT/REPLACE', () => {
  it('🚨 prima register: INSERT row con id da nanoid', () => {
    const svc = new WorkerCoordinationService();
    svc.register('1.0.0');
    const row = m.sqlite.prepare('SELECT * FROM workers').get() as Record<string, unknown>;
    expect(row.id).toBe(svc.getId());
    expect(row.status).toBe('idle');
    expect(row.version).toBe('1.0.0');
    expect(row.runs_executed).toBe(0);
  });

  it('🚨 register due volte stesso id → ON CONFLICT replace, no duplicate', () => {
    const svc = new WorkerCoordinationService();
    svc.register('1.0.0');
    // Modifica stato esistente
    m.sqlite.prepare(`UPDATE workers SET status = 'busy' WHERE id = ?`).run(svc.getId());
    svc.register('2.0.0');
    const rows = m.sqlite.prepare('SELECT * FROM workers').all();
    expect(rows).toHaveLength(1); // no duplicate
    const row = rows[0] as Record<string, unknown>;
    expect(row.status).toBe('idle'); // re-register resetta a idle
    expect(row.version).toBe('2.0.0');
  });

  it('🚨 MEDEA_WORKER_ID env override → usa quello (no nanoid)', () => {
    process.env.MEDEA_WORKER_ID = 'fixed-wkr-id';
    try {
      const svc = new WorkerCoordinationService();
      expect(svc.getId()).toBe('fixed-wkr-id');
    } finally {
      delete process.env.MEDEA_WORKER_ID;
    }
  });
});

describe('heartbeat() — update last_heartbeat_at', () => {
  it('🚨 happy: UPDATE last_heartbeat_at = NOW', async () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    const before = m.sqlite
      .prepare(`SELECT last_heartbeat_at FROM workers WHERE id = ?`)
      .get(svc.getId()) as { last_heartbeat_at: string };
    await new Promise((r) => setTimeout(r, 10));
    svc.heartbeat();
    const after = m.sqlite
      .prepare(`SELECT last_heartbeat_at FROM workers WHERE id = ?`)
      .get(svc.getId()) as { last_heartbeat_at: string };
    expect(new Date(after.last_heartbeat_at).getTime()).toBeGreaterThan(
      new Date(before.last_heartbeat_at).getTime(),
    );
  });

  it('🚨 DB error → catch + log (no throw)', () => {
    const svc = new WorkerCoordinationService();
    // Drop la tabella per provocare DB error
    m.sqlite.exec('DROP TABLE workers');
    expect(() => svc.heartbeat()).not.toThrow();
  });
});

describe('🚨 janitor() — mark stale workers as dead', () => {
  it('🚨 worker con heartbeat < cutoff → status=dead + current_run_id=NULL', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    // Forza heartbeat vecchio (oltre 60s ago)
    const oldTs = new Date(Date.now() - 120_000).toISOString();
    m.sqlite
      .prepare(`UPDATE workers SET last_heartbeat_at = ?, current_run_id = 'run-99' WHERE id = ?`)
      .run(oldTs, svc.getId());
    svc.janitor();
    const row = m.sqlite
      .prepare(`SELECT status, current_run_id FROM workers WHERE id = ?`)
      .get(svc.getId()) as { status: string; current_run_id: string | null };
    expect(row.status).toBe('dead');
    expect(row.current_run_id).toBeNull();
  });

  it('🚨 worker fresh (heartbeat recente) → NON marked', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.janitor();
    const row = m.sqlite.prepare(`SELECT status FROM workers WHERE id = ?`).get(svc.getId()) as {
      status: string;
    };
    expect(row.status).toBe('idle'); // unchanged
  });

  it('🚨 worker già "dead" → janitor lo IGNORA (no double-write)', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    m.sqlite
      .prepare(`UPDATE workers SET status = 'dead', last_heartbeat_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), svc.getId());
    svc.janitor();
    const row = m.sqlite.prepare(`SELECT status FROM workers WHERE id = ?`).get(svc.getId()) as {
      status: string;
    };
    expect(row.status).toBe('dead');
  });

  it('janitor su tabella vuota → no errors', () => {
    const svc = new WorkerCoordinationService();
    expect(() => svc.janitor()).not.toThrow();
  });

  it('🚨 DB error → catch + log (no throw)', () => {
    const svc = new WorkerCoordinationService();
    m.sqlite.exec('DROP TABLE workers');
    expect(() => svc.janitor()).not.toThrow();
  });
});

describe('markBusy / markIdle — status transitions + counter', () => {
  it('🚨 markBusy: status=busy + current_run_id set', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.markBusy('run-1');
    const row = m.sqlite.prepare(`SELECT * FROM workers WHERE id = ?`).get(svc.getId()) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe('busy');
    expect(row.current_run_id).toBe('run-1');
  });

  it('🚨 markIdle: status=idle + current_run_id=NULL + counter +=1', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.markBusy('run-1');
    svc.markIdle();
    const row = m.sqlite.prepare(`SELECT * FROM workers WHERE id = ?`).get(svc.getId()) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe('idle');
    expect(row.current_run_id).toBeNull();
    expect(row.runs_executed).toBe(1);
  });

  it('🚨 markIdle chiamato 3 volte → runs_executed = 3 (counter monotono)', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.markIdle();
    svc.markIdle();
    svc.markIdle();
    const row = m.sqlite
      .prepare(`SELECT runs_executed FROM workers WHERE id = ?`)
      .get(svc.getId()) as { runs_executed: number };
    expect(row.runs_executed).toBe(3);
  });
});

describe('listActive() — fleet view', () => {
  it('happy: maps DbRow → WorkerRow shape', () => {
    const svc = new WorkerCoordinationService();
    svc.register('1.0.0');
    const list = svc.listActive();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: svc.getId(),
      status: 'idle',
      version: '1.0.0',
      runsExecuted: 0,
      currentRunId: null,
      requestedAction: null,
      requestedConcurrency: null,
      concurrency: 1, // default da schema
    });
  });

  it('🚨 multiple workers → ordered by last_heartbeat_at DESC', async () => {
    const svc1 = new WorkerCoordinationService();
    const svc2 = new WorkerCoordinationService();
    svc1.register();
    await new Promise((r) => setTimeout(r, 10));
    svc2.register();
    // svc2 è più recente → deve essere primo
    const list = svc1.listActive();
    expect(list[0]?.id).toBe(svc2.getId());
    expect(list[1]?.id).toBe(svc1.getId());
  });

  it('lista vuota se nessun worker registrato', () => {
    const svc = new WorkerCoordinationService();
    expect(svc.listActive()).toEqual([]);
  });
});

describe('🚨 requestAction() — queue admin intent', () => {
  it.each<WorkerControlAction>(['restart', 'drain', 'resume'])(
    'action "%s" → queued in DB',
    (action) => {
      const svc = new WorkerCoordinationService();
      svc.register();
      const ok = svc.requestAction(svc.getId(), action, 'admin@x.com');
      expect(ok).toBe(true);
      const row = m.sqlite.prepare(`SELECT * FROM workers WHERE id = ?`).get(svc.getId()) as Record<
        string,
        unknown
      >;
      expect(row.requested_action).toBe(action);
      expect(row.requested_action_by).toBe('admin@x.com');
      expect(row.requested_action_at).toBeTruthy();
    },
  );

  it('🚨 worker not found → returns false (no error)', () => {
    const svc = new WorkerCoordinationService();
    const ok = svc.requestAction('ghost', 'restart', 'admin@x.com');
    expect(ok).toBe(false);
  });
});

describe('🚨 requestConcurrency() — Zod-like guard 1-64', () => {
  it('happy: concurrency 8 → queued', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    const ok = svc.requestConcurrency(svc.getId(), 8, 'admin@x.com');
    expect(ok).toBe(true);
    const row = m.sqlite
      .prepare(`SELECT requested_concurrency FROM workers WHERE id = ?`)
      .get(svc.getId()) as { requested_concurrency: number };
    expect(row.requested_concurrency).toBe(8);
  });

  it('🚨 concurrency 0 → throw "1 and 64"', () => {
    const svc = new WorkerCoordinationService();
    expect(() => svc.requestConcurrency(svc.getId(), 0, 'admin@x.com')).toThrow(/1 and 64/u);
  });

  it('🚨 concurrency 65 → throw (anti-DoS)', () => {
    const svc = new WorkerCoordinationService();
    expect(() => svc.requestConcurrency(svc.getId(), 65, 'admin@x.com')).toThrow(/1 and 64/u);
  });

  it('🚨 concurrency negative → throw', () => {
    const svc = new WorkerCoordinationService();
    expect(() => svc.requestConcurrency(svc.getId(), -5, 'admin@x.com')).toThrow(/1 and 64/u);
  });

  it('🚨 concurrency non-integer → throw', () => {
    const svc = new WorkerCoordinationService();
    expect(() => svc.requestConcurrency(svc.getId(), 3.5, 'admin@x.com')).toThrow(/1 and 64/u);
  });

  it('worker not found → false', () => {
    const svc = new WorkerCoordinationService();
    const ok = svc.requestConcurrency('ghost', 8, 'admin@x.com');
    expect(ok).toBe(false);
  });
});

describe('🚨 consumePendingAction() — atomic exactly-once', () => {
  it('🚨 no pending → null/null', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    expect(svc.consumePendingAction()).toEqual({ action: null, concurrency: null });
  });

  it('🚨 pending action set → returned + cleared atomically', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.requestAction(svc.getId(), 'restart', 'admin@x.com');
    const first = svc.consumePendingAction();
    expect(first.action).toBe('restart');
    // Re-consume → null (already cleared)
    const second = svc.consumePendingAction();
    expect(second.action).toBeNull();
  });

  it('🚨 pending concurrency set → returned + cleared', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.requestConcurrency(svc.getId(), 16, 'admin@x.com');
    const r = svc.consumePendingAction();
    expect(r.concurrency).toBe(16);
    // Re-consume → null
    expect(svc.consumePendingAction().concurrency).toBeNull();
  });

  it('🚨 BOTH action + concurrency set → entrambi tornati + entrambi cleared', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.requestAction(svc.getId(), 'drain', 'admin@x.com');
    svc.requestConcurrency(svc.getId(), 4, 'admin@x.com');
    const r = svc.consumePendingAction();
    expect(r.action).toBe('drain');
    expect(r.concurrency).toBe(4);
    expect(svc.consumePendingAction()).toEqual({ action: null, concurrency: null });
  });

  it('row inesistente → null/null (defensive)', () => {
    const svc = new WorkerCoordinationService();
    // NO register
    expect(svc.consumePendingAction()).toEqual({ action: null, concurrency: null });
  });
});

describe('setDraining / setIdle / setConcurrency', () => {
  it('🚨 setDraining: status idle → draining', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.setDraining();
    const row = m.sqlite.prepare(`SELECT status FROM workers WHERE id = ?`).get(svc.getId()) as {
      status: string;
    };
    expect(row.status).toBe('draining');
  });

  it('🚨 setDraining su worker "dead" → IGNORED (no overwrite dead)', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    m.sqlite.prepare(`UPDATE workers SET status = 'dead' WHERE id = ?`).run(svc.getId());
    svc.setDraining();
    const row = m.sqlite.prepare(`SELECT status FROM workers WHERE id = ?`).get(svc.getId()) as {
      status: string;
    };
    expect(row.status).toBe('dead');
  });

  it('🚨 setIdle SOLO se status="draining" (no idle da busy)', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.markBusy('run-1'); // status=busy
    svc.setIdle();
    const row = m.sqlite.prepare(`SELECT status FROM workers WHERE id = ?`).get(svc.getId()) as {
      status: string;
    };
    expect(row.status).toBe('busy'); // NON cambiato da busy a idle
  });

  it('setIdle da "draining" → idle', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.setDraining();
    svc.setIdle();
    const row = m.sqlite.prepare(`SELECT status FROM workers WHERE id = ?`).get(svc.getId()) as {
      status: string;
    };
    expect(row.status).toBe('idle');
  });

  it('setConcurrency: aggiorna live value', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    svc.setConcurrency(16);
    const row = m.sqlite
      .prepare(`SELECT concurrency FROM workers WHERE id = ?`)
      .get(svc.getId()) as { concurrency: number };
    expect(row.concurrency).toBe(16);
  });
});

describe('stop() — graceful unregister', () => {
  it('🚨 DELETE row dal DB', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    expect(m.sqlite.prepare('SELECT COUNT(*) AS c FROM workers').get()).toEqual({ c: 1 });
    svc.stop();
    expect(m.sqlite.prepare('SELECT COUNT(*) AS c FROM workers').get()).toEqual({ c: 0 });
  });

  it('🚨 stop quando DB chiuso → catch + log (no throw)', () => {
    const svc = new WorkerCoordinationService();
    svc.register();
    m.sqlite.close();
    expect(() => svc.stop()).not.toThrow();
  });
});
