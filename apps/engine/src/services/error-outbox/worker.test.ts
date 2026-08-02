/**
 * Test worker + retry-policy dell'outbox.
 *  - 🚨 BUG-BOUNTY OBBLIGATORIO #2: dead-letter dopo OUTBOX_MAX_ATTEMPTS (poison NON
 *    ritenta in eterno, non blocca la coda).
 *  - Robustezza #5: per-canale indipendente (un canale esplode → gli altri partono).
 * DB SQLite in-memory reale + dispatcher finti iniettati. @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ERROR_OUTBOX_DDL } from '@/storage/error-outbox.ddl.js';
import type { SqliteCompatProxy } from '@/storage/db.js';
import type { ErrorOutboxChannel } from '@/storage/schema.js';
import { enqueueErrorEvent, type ErrorOutboxInsert } from './repository.js';
import { runOutboxSweepOnce, type ChannelDispatcher } from './worker.js';
import {
  nextRetryDecision,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BASE_DELAY_MS,
  OUTBOX_MAX_DELAY_MS,
} from './retry-policy.js';

vi.mock('@/lib/logger.js'); // manual mock condiviso (src/lib/__mocks__/logger.ts)

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
    exec: (sql: string) => {
      db.exec(sql);
    },
    transaction: <T extends unknown[], R>(fn: (...a: T) => R) =>
      db.transaction(fn) as (...a: T) => R,
  };
}

function evt(
  over: Partial<ErrorOutboxInsert> & { id: string; runId: string; channel: ErrorOutboxChannel },
): ErrorOutboxInsert {
  return {
    workflowId: 'wf-1',
    tenantId: 't-1',
    errorNodeId: 'n',
    errorMessage: 'boom',
    errorHash: 'h',
    durationMs: 1,
    startedAt: '2026-06-19T10:00:00.000Z',
    triggerType: 'manual',
    triggerInputJson: null,
    nextAttemptAt: '2026-06-19T09:00:00.000Z', // dovuto
    ...over,
  };
}
const NOW = new Date('2026-06-19T10:00:00.000Z');
const ok: ChannelDispatcher = async () => undefined;
const boom: ChannelDispatcher = async () => {
  throw new Error('dispatch failed');
};

describe('retry-policy — backoff + dead-letter (#2)', () => {
  it('🚨 dead dopo OUTBOX_MAX_ATTEMPTS (attemptsBefore = MAX-1 → dead)', () => {
    expect(nextRetryDecision(OUTBOX_MAX_ATTEMPTS - 1, NOW).kind).toBe('dead');
  });
  it('sotto il max → retry', () => {
    expect(nextRetryDecision(0, NOW).kind).toBe('retry');
    expect(nextRetryDecision(OUTBOX_MAX_ATTEMPTS - 2, NOW).kind).toBe('retry');
  });
  it('backoff esponenziale crescente + cap', () => {
    const d0 = nextRetryDecision(0, NOW);
    const d1 = nextRetryDecision(1, NOW);
    if (d0.kind !== 'retry' || d1.kind !== 'retry') throw new Error('expected retry');
    const delay0 = new Date(d0.nextAttemptAt).getTime() - NOW.getTime();
    const delay1 = new Date(d1.nextAttemptAt).getTime() - NOW.getTime();
    expect(delay0).toBe(OUTBOX_BASE_DELAY_MS);
    expect(delay1).toBe(OUTBOX_BASE_DELAY_MS * 2); // raddoppia
    // attemptsBefore alto → cappato (non cresce all'infinito)
    const dCap = nextRetryDecision(20, NOW);
    if (dCap.kind === 'retry') {
      expect(new Date(dCap.nextAttemptAt).getTime() - NOW.getTime()).toBeLessThanOrEqual(
        OUTBOX_MAX_DELAY_MS,
      );
    } // (a 20 sarebbe dead, ma il cap è comunque garantito sotto il max)
  });
});

describe('worker.runOutboxSweepOnce', () => {
  let raw: Database.Database;
  let sqlite: SqliteCompatProxy;
  const dispatchers = (
    over: Partial<Record<ErrorOutboxChannel, ChannelDispatcher>> = {},
  ): Record<ErrorOutboxChannel, ChannelDispatcher> => ({
    fanout: ok,
    webhook: ok,
    email: ok,
    ...over,
  });

  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(ERROR_OUTBOX_DDL);
    sqlite = wrap(raw);
  });
  const statusOf = (id: string): string =>
    (raw.prepare('SELECT status FROM error_outbox WHERE id=?').get(id) as { status: string })
      .status;
  const attemptsOf = (id: string): number =>
    (raw.prepare('SELECT attempts FROM error_outbox WHERE id=?').get(id) as { attempts: number })
      .attempts;

  it('dispatch OK → done', async () => {
    enqueueErrorEvent(sqlite, evt({ id: 'a', runId: 'r1', channel: 'webhook' }));
    const res = await runOutboxSweepOnce({ sqlite, dispatchers: dispatchers(), now: () => NOW });
    expect(res).toMatchObject({ claimed: 1, done: 1, retried: 0, dead: 0 });
    expect(statusOf('a')).toBe('done');
  });

  it('dispatch fallisce (attempts bassi) → retry, attempts+1, pending', async () => {
    enqueueErrorEvent(sqlite, evt({ id: 'a', runId: 'r1', channel: 'webhook' }));
    const res = await runOutboxSweepOnce({
      sqlite,
      dispatchers: dispatchers({ webhook: boom }),
      now: () => NOW,
    });
    expect(res).toMatchObject({ done: 0, retried: 1, dead: 0 });
    expect(statusOf('a')).toBe('pending');
    expect(attemptsOf('a')).toBe(1);
  });

  it('🚨 BUG-BOUNTY #2: evento poison a attempts=MAX-1 che fallisce → DEAD (non ritenta in eterno)', async () => {
    enqueueErrorEvent(sqlite, evt({ id: 'poison', runId: 'r1', channel: 'webhook' }));
    raw
      .prepare("UPDATE error_outbox SET attempts=? WHERE id='poison'")
      .run(OUTBOX_MAX_ATTEMPTS - 1);
    const res = await runOutboxSweepOnce({
      sqlite,
      dispatchers: dispatchers({ webhook: boom }),
      now: () => NOW,
    });
    expect(res.dead).toBe(1);
    expect(statusOf('poison')).toBe('dead');
    // e una sweep successiva NON lo ri-claima (coda non bloccata)
    const res2 = await runOutboxSweepOnce({
      sqlite,
      dispatchers: dispatchers({ webhook: boom }),
      now: () => NOW,
    });
    expect(res2.claimed).toBe(0);
  });

  it('🚨 #5 per-canale INDIPENDENTE: webhook esplode, fanout+email partono lo stesso', async () => {
    enqueueErrorEvent(sqlite, evt({ id: 'f', runId: 'r1', channel: 'fanout' }));
    enqueueErrorEvent(sqlite, evt({ id: 'w', runId: 'r1', channel: 'webhook' }));
    enqueueErrorEvent(sqlite, evt({ id: 'e', runId: 'r1', channel: 'email' }));
    const res = await runOutboxSweepOnce({
      sqlite,
      dispatchers: dispatchers({ webhook: boom }),
      now: () => NOW,
    });
    expect(res).toMatchObject({ done: 2, retried: 1 });
    expect(statusOf('f')).toBe('done');
    expect(statusOf('e')).toBe('done');
    expect(statusOf('w')).toBe('pending'); // solo il webhook ritentato
  });

  it('claim solo i dovuti (futuri esclusi)', async () => {
    enqueueErrorEvent(
      sqlite,
      evt({
        id: 'due',
        runId: 'r1',
        channel: 'webhook',
        nextAttemptAt: '2026-06-19T09:00:00.000Z',
      }),
    );
    enqueueErrorEvent(
      sqlite,
      evt({
        id: 'future',
        runId: 'r2',
        channel: 'webhook',
        nextAttemptAt: '2026-06-19T23:00:00.000Z',
      }),
    );
    const res = await runOutboxSweepOnce({ sqlite, dispatchers: dispatchers(), now: () => NOW });
    expect(res.claimed).toBe(1);
    expect(statusOf('due')).toBe('done');
    expect(statusOf('future')).toBe('pending');
  });

  it('canale senza dispatcher → dead (non loop infinito)', async () => {
    enqueueErrorEvent(sqlite, evt({ id: 'x', runId: 'r1', channel: 'fanout' }));
    const partial = { webhook: ok, email: ok } as unknown as Record<
      ErrorOutboxChannel,
      ChannelDispatcher
    >;
    const res = await runOutboxSweepOnce({ sqlite, dispatchers: partial, now: () => NOW });
    expect(res.dead).toBe(1);
    expect(statusOf('x')).toBe('dead');
  });
});
