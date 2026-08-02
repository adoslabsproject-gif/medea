/**
 * Test scheduler outbox — sweep periodico, GC su retention, 🚨 anti-overlap, fail-soft.
 * DB reale in-memory + DDL (anti-mock-drift sul GC).
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger.js');

import Database from 'better-sqlite3';
import { ERROR_OUTBOX_DDL } from '@/storage/error-outbox.ddl.js';
import type { SqliteCompatProxy } from '@/storage/db.js';
import type { ChannelDispatcher } from './worker.js';
import type { ErrorOutboxChannel } from '@/storage/schema.js';
import { enqueueErrorEvent } from './repository.js';
import { startOutboxScheduler } from './scheduler.js';

function wrap(db: Database.Database): SqliteCompatProxy {
  return {
    prepare: (sql) => {
      const s = db.prepare(sql);
      return { run: (...p) => s.run(...p), get: (...p) => s.get(...p), all: (...p) => s.all(...p) };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    transaction: (fn) => db.transaction(fn) as never,
  };
}

const noopDispatchers: Record<ErrorOutboxChannel, ChannelDispatcher> = {
  fanout: () => Promise.resolve(),
  webhook: () => Promise.resolve(),
  email: () => Promise.resolve(),
};

let db: Database.Database;
let sqlite: SqliteCompatProxy;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(ERROR_OUTBOX_DDL);
  sqlite = wrap(db);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function seed(channel: ErrorOutboxChannel, runId: string, nextAttemptAt: string): void {
  enqueueErrorEvent(sqlite, {
    id: `${channel}-${runId}`,
    runId,
    channel,
    workflowId: 'wf',
    tenantId: 't',
    errorNodeId: 'n',
    errorMessage: 'e',
    errorHash: 'h',
    durationMs: 1,
    startedAt: '2026-06-19T10:00:00.000Z',
    triggerType: 'manual',
    triggerInputJson: null,
    nextAttemptAt,
  });
}

describe('startOutboxScheduler', () => {
  it('sweepNow dispatcha gli eventi due e li marca done', async () => {
    seed('webhook', 'r1', '2026-06-19T09:00:00.000Z');
    const dispatched: string[] = [];
    const dispatchers = {
      ...noopDispatchers,
      webhook: ((ev) => {
        dispatched.push(ev.runId);
        return Promise.resolve();
      }) as ChannelDispatcher,
    };
    const h = startOutboxScheduler({
      sqlite,
      dispatchers,
      now: () => Date.parse('2026-06-19T10:00:00.000Z'),
    });
    await h.sweepNow();
    h.stop();
    expect(dispatched).toEqual(['r1']);
    const row = db.prepare('SELECT status FROM error_outbox WHERE run_id = ?').get('r1') as {
      status: string;
    };
    expect(row.status).toBe('done');
  });

  it('🚨 anti-overlap: un secondo sweep mentre il primo è in volo non parte', async () => {
    seed('webhook', 'r1', '2026-06-19T09:00:00.000Z');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const dispatchers = {
      ...noopDispatchers,
      webhook: async () => {
        calls++;
        await gate;
      },
    };
    const h = startOutboxScheduler({
      sqlite,
      dispatchers,
      now: () => Date.parse('2026-06-19T10:00:00.000Z'),
    });
    const first = h.sweepNow(); // entra, resta bloccato sul gate
    await h.sweepNow(); // deve uscire subito (inFlight=true), NON ridispacciare
    expect(calls).toBe(1);
    release();
    await first;
    h.stop();
  });

  it('gcNow elimina done/dead oltre la retention, conserva i recenti e i pending', () => {
    // riga done vecchia (updated_at forzato nel passato) → eliminata
    seed('webhook', 'old', '2026-06-19T09:00:00.000Z');
    db.prepare(
      "UPDATE error_outbox SET status='done', updated_at='2026-06-01T00:00:00.000Z' WHERE run_id='old'",
    ).run();
    // riga done recente → conservata
    seed('webhook', 'fresh', '2026-06-19T09:00:00.000Z');
    db.prepare(
      "UPDATE error_outbox SET status='done', updated_at='2026-06-19T09:59:00.000Z' WHERE run_id='fresh'",
    ).run();
    // riga pending → MAI eliminata
    seed('webhook', 'pending', '2026-06-19T09:00:00.000Z');

    const h = startOutboxScheduler({
      sqlite,
      dispatchers: noopDispatchers,
      now: () => Date.parse('2026-06-19T10:00:00.000Z'),
      gcRetentionMs: 7 * 24 * 3_600_000,
    });
    const deleted = h.gcNow();
    h.stop();
    expect(deleted).toBe(1);
    const left = (
      db.prepare('SELECT run_id FROM error_outbox ORDER BY run_id').all() as { run_id: string }[]
    ).map((r) => r.run_id);
    expect(left).toEqual(['fresh', 'pending']);
  });

  it('🚨 fail-soft: un dispatcher che esplode NON propaga da sweepNow', async () => {
    seed('webhook', 'r1', '2026-06-19T09:00:00.000Z');
    const dispatchers = { ...noopDispatchers, webhook: () => Promise.reject(new Error('boom')) };
    const h = startOutboxScheduler({
      sqlite,
      dispatchers,
      now: () => Date.parse('2026-06-19T10:00:00.000Z'),
    });
    await expect(h.sweepNow()).resolves.toBeUndefined(); // il worker isola per-riga → niente throw
    h.stop();
    // l'evento resta ritentabile (retry schedulato nel futuro)
    const row = db
      .prepare('SELECT status, attempts FROM error_outbox WHERE run_id=?')
      .get('r1') as { status: string; attempts: number };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
  });

  it('il timer periodico invoca lo sweep; stop() lo ferma', async () => {
    seed('webhook', 'r1', '2026-06-19T09:00:00.000Z');
    let calls = 0;
    const dispatchers = {
      ...noopDispatchers,
      webhook: () => {
        calls++;
        return Promise.resolve();
      },
    };
    const h = startOutboxScheduler({
      sqlite,
      dispatchers,
      sweepIntervalMs: 1000,
      now: () => Date.parse('2026-06-19T10:00:00.000Z'),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1); // dopo stop niente più sweep
  });
});
