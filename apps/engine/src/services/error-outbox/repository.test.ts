/**
 * Test repository error_outbox — DB SQLite in-memory REALE (vincoli veri, niente
 * mock). Robustezza: dedup per-canale (#6), claim solo "dovuti" FIFO, capolinea
 * dead-letter (#2), GC retention (#6), cap messaggio. La DDL è quella di PRODUZIONE
 * (storage/error-outbox.ddl.ts) → il test morde sullo schema reale, non su una copia.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ERROR_OUTBOX_DDL } from '@/storage/error-outbox.ddl.js';
import type { SqliteCompatProxy } from '@/storage/db.js';
import {
  enqueueErrorEvent,
  claimDueErrorEvents,
  markErrorEventDone,
  markErrorEventRetry,
  markErrorEventDead,
  gcErrorOutbox,
  MAX_ERROR_MESSAGE,
  type ErrorOutboxInsert,
} from './repository.js';

/** Adapter tipato better-sqlite3 → SqliteCompatProxy (stesso contratto del runtime). */
function wrap(db: Database.Database): SqliteCompatProxy {
  return {
    prepare: (sql: string) => {
      const s = db.prepare(sql);
      return {
        run: (...p: unknown[]) => s.run(...(p as Parameters<typeof s.run>)),
        get: (...p: unknown[]) => s.get(...(p as Parameters<typeof s.get>)),
        all: (...p: unknown[]) => s.all(...(p as Parameters<typeof s.all>)),
      };
    },
    exec: (sql: string) => { db.exec(sql); },
    transaction: <T extends unknown[], R>(fn: (...a: T) => R) => db.transaction(fn) as (...a: T) => R,
  };
}

let raw: Database.Database;
let sqlite: SqliteCompatProxy;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(ERROR_OUTBOX_DDL);
  sqlite = wrap(raw);
});

function ins(over: Partial<ErrorOutboxInsert> & { id: string; runId: string }): ErrorOutboxInsert {
  return {
    channel: 'webhook',
    workflowId: 'wf-1',
    tenantId: 't-1',
    errorNodeId: 'node-9',
    errorMessage: 'boom',
    errorHash: 'h1',
    durationMs: 42,
    startedAt: '2026-06-19T10:00:00.000Z',
    triggerType: 'manual',
    triggerInputJson: null,
    nextAttemptAt: '2026-06-19T10:00:00.000Z',
    ...over,
  };
}

describe('enqueueErrorEvent — dedup per-canale (#6) + indipendenza canali (#5)', () => {
  it('nuovo (run,channel) → inserito (true)', () => {
    expect(enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1' }))).toBe(true);
  });

  it('🚨 stesso (run_id, channel) due volte → secondo no-op (false), una sola riga', () => {
    expect(enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1', channel: 'webhook' }))).toBe(true);
    expect(enqueueErrorEvent(sqlite, ins({ id: 'b', runId: 'r1', channel: 'webhook' }))).toBe(false);
    const cnt = (raw.prepare("SELECT COUNT(*) c FROM error_outbox WHERE run_id='r1'").get() as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('🚨 stesso run_id, canali DIVERSI → righe indipendenti (fanout+webhook+email)', () => {
    expect(enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1', channel: 'fanout' }))).toBe(true);
    expect(enqueueErrorEvent(sqlite, ins({ id: 'b', runId: 'r1', channel: 'webhook' }))).toBe(true);
    expect(enqueueErrorEvent(sqlite, ins({ id: 'c', runId: 'r1', channel: 'email' }))).toBe(true);
    const cnt = (raw.prepare("SELECT COUNT(*) c FROM error_outbox WHERE run_id='r1'").get() as { c: number }).c;
    expect(cnt).toBe(3);
  });

  it('error_message cappato a MAX_ERROR_MESSAGE', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1', errorMessage: 'x'.repeat(MAX_ERROR_MESSAGE + 5000) }));
    const m = (raw.prepare("SELECT error_message m FROM error_outbox WHERE id='a'").get() as { m: string }).m;
    expect(m.length).toBe(MAX_ERROR_MESSAGE);
  });
});

describe('claimDueErrorEvents — solo pending "dovuti", FIFO', () => {
  it('🚨 esclude i futuri (next_attempt_at > now)', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'due', runId: 'r1', nextAttemptAt: '2026-06-19T09:00:00.000Z' }));
    enqueueErrorEvent(sqlite, ins({ id: 'future', runId: 'r2', nextAttemptAt: '2026-06-19T23:00:00.000Z' }));
    const got = claimDueErrorEvents(sqlite, '2026-06-19T10:00:00.000Z', 100);
    expect(got.map((r) => r.id)).toEqual(['due']);
  });

  it('🚨 esclude done e dead', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'pending', runId: 'r1' }));
    enqueueErrorEvent(sqlite, ins({ id: 'done', runId: 'r2' }));
    enqueueErrorEvent(sqlite, ins({ id: 'dead', runId: 'r3' }));
    markErrorEventDone(sqlite, 'done');
    markErrorEventDead(sqlite, 'dead', 'poison');
    const got = claimDueErrorEvents(sqlite, '2026-06-19T23:59:00.000Z', 100);
    expect(got.map((r) => r.id)).toEqual(['pending']);
  });

  it('FIFO per created_at + rispetta il limit', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1' }));
    enqueueErrorEvent(sqlite, ins({ id: 'b', runId: 'r2' }));
    enqueueErrorEvent(sqlite, ins({ id: 'c', runId: 'r3' }));
    raw.prepare("UPDATE error_outbox SET created_at=? WHERE id=?").run('2026-06-19T10:00:01Z', 'a');
    raw.prepare("UPDATE error_outbox SET created_at=? WHERE id=?").run('2026-06-19T10:00:02Z', 'b');
    raw.prepare("UPDATE error_outbox SET created_at=? WHERE id=?").run('2026-06-19T10:00:03Z', 'c');
    const got = claimDueErrorEvents(sqlite, '2026-06-19T23:00:00.000Z', 2);
    expect(got.map((r) => r.id)).toEqual(['a', 'b']); // oldest-first, limit 2
  });
});

describe('retry / dead-letter (#2)', () => {
  it('🚨 markRetry → attempts+1, schedula futuro → NON più dovuto finché non scade', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1', nextAttemptAt: '2026-06-19T09:00:00.000Z' }));
    markErrorEventRetry(sqlite, 'a', '2026-06-19T12:00:00.000Z', 'transient 503');
    const row = raw.prepare("SELECT attempts, next_attempt_at, last_error, status FROM error_outbox WHERE id='a'").get() as { attempts: number; next_attempt_at: string; last_error: string; status: string };
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.last_error).toContain('503');
    expect(claimDueErrorEvents(sqlite, '2026-06-19T11:00:00.000Z', 10)).toHaveLength(0); // non ancora dovuto
    expect(claimDueErrorEvents(sqlite, '2026-06-19T12:30:00.000Z', 10).map((r) => r.id)).toEqual(['a']); // dovuto
  });

  it('🚨 markDead → poison: status=dead, MAI più claimato (coda non bloccata)', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'a', runId: 'r1' }));
    markErrorEventDead(sqlite, 'a', 'permanent 550');
    const row = raw.prepare("SELECT status, attempts FROM error_outbox WHERE id='a'").get() as { status: string; attempts: number };
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(1);
    expect(claimDueErrorEvents(sqlite, '2026-12-31T23:59:00.000Z', 10)).toHaveLength(0);
  });
});

describe('gcErrorOutbox — retention (#6)', () => {
  it('🚨 rimuove done/dead vecchi, TIENE pending e i recenti', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'old-done', runId: 'r1' }));
    enqueueErrorEvent(sqlite, ins({ id: 'old-dead', runId: 'r2' }));
    enqueueErrorEvent(sqlite, ins({ id: 'pending', runId: 'r3' }));
    markErrorEventDone(sqlite, 'old-done');
    markErrorEventDead(sqlite, 'old-dead', 'x');
    // invecchia i due terminali
    raw.prepare("UPDATE error_outbox SET updated_at='2026-06-01T00:00:00Z' WHERE id IN ('old-done','old-dead')").run();
    const removed = gcErrorOutbox(sqlite, '2026-06-10T00:00:00Z');
    expect(removed).toBe(2);
    const remaining = (raw.prepare('SELECT id FROM error_outbox ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(remaining).toEqual(['pending']); // pending mai toccato dalla GC
  });

  it('NON rimuove done/dead recenti (updated_at >= cutoff)', () => {
    enqueueErrorEvent(sqlite, ins({ id: 'recent-done', runId: 'r1' }));
    markErrorEventDone(sqlite, 'recent-done');
    const removed = gcErrorOutbox(sqlite, '2020-01-01T00:00:00Z'); // cutoff nel passato
    expect(removed).toBe(0);
  });
});
