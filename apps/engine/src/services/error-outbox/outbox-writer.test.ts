/**
 * Test outbox-writer — selezione canali + anti-loop (#4), error_hash, e ATOMICITÀ
 * dell'enqueue (#3, all-or-nothing su DB reale). Niente mock dove conta: la
 * transazione gira su SQLite in-memory vero con la DDL di produzione.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ERROR_OUTBOX_DDL } from '@/storage/error-outbox.ddl.js';
import type { SqliteCompatProxy } from '@/storage/db.js';
import {
  buildErrorOutboxEvents,
  enqueueErrorOutbox,
  computeErrorHash,
  type BuildErrorOutboxParams,
} from './outbox-writer.js';

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

function params(over: Partial<BuildErrorOutboxParams> = {}): BuildErrorOutboxParams {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    tenantId: 't-1',
    errorNodeId: 'node-9',
    errorMessage: 'boom',
    durationMs: 10,
    startedAt: '2026-06-19T10:00:00.000Z',
    triggerType: 'manual',
    triggerInputJson: null,
    onError: { webhookUrl: 'https://hook.example.com', emailTo: 'ops@example.com' },
    errorWorkflowId: 'wf-err',
    nextAttemptAt: '2026-06-19T10:00:00.000Z',
    idFor: (ch) => `id-${ch}`,
    ...over,
  };
}

describe('buildErrorOutboxEvents — selezione canali + anti-loop (#4) + anti-self', () => {
  it('run normale con tutto configurato → fanout + webhook + email', () => {
    const ev = buildErrorOutboxEvents(params());
    expect(ev.map((e) => e.channel).sort()).toEqual(['email', 'fanout', 'webhook']);
  });

  it('🚨 ANTI-LOOP: triggerType=error-handler → NIENTE fanout (ma webhook/email sì)', () => {
    const ev = buildErrorOutboxEvents(params({ triggerType: 'error-handler' }));
    expect(ev.map((e) => e.channel).sort()).toEqual(['email', 'webhook']);
    expect(ev.some((e) => e.channel === 'fanout')).toBe(false);
  });

  it('🚨 ANTI-SELF: errorWorkflowId === workflowId → niente fanout', () => {
    const ev = buildErrorOutboxEvents(params({ errorWorkflowId: 'wf-1' }));
    expect(ev.some((e) => e.channel === 'fanout')).toBe(false);
  });

  it('nessun errorWorkflowId → niente fanout', () => {
    const ev = buildErrorOutboxEvents(params({ errorWorkflowId: null }));
    expect(ev.some((e) => e.channel === 'fanout')).toBe(false);
  });

  it('onError null → niente webhook/email (solo fanout se applicabile)', () => {
    const ev = buildErrorOutboxEvents(params({ onError: null }));
    expect(ev.map((e) => e.channel)).toEqual(['fanout']);
  });

  it('solo webhook configurato → solo fanout + webhook', () => {
    const ev = buildErrorOutboxEvents(
      params({ onError: { webhookUrl: 'https://x', emailTo: undefined } }),
    );
    expect(ev.map((e) => e.channel).sort()).toEqual(['fanout', 'webhook']);
  });

  it('error_hash identico per tutti i canali dello stesso evento', () => {
    const ev = buildErrorOutboxEvents(params());
    const hashes = new Set(ev.map((e) => e.errorHash));
    expect(hashes.size).toBe(1);
  });
});

describe('computeErrorHash — deterministico', () => {
  it('stessi input → stesso hash', () => {
    expect(computeErrorHash('wf', 'n', 'boom')).toBe(computeErrorHash('wf', 'n', 'boom'));
  });
  it('input diversi → hash diverso', () => {
    expect(computeErrorHash('wf', 'n', 'boom')).not.toBe(computeErrorHash('wf', 'n', 'kaboom'));
  });
  it('gestisce null', () => {
    expect(computeErrorHash('wf', null, null)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('enqueueErrorOutbox — atomico (#3)', () => {
  let raw: Database.Database;
  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(ERROR_OUTBOX_DDL);
  });

  it('inserisce tutti i canali + ritorna il count; ri-enqueue → 0 nuovi (dedup)', () => {
    const sqlite = wrap(raw);
    const ev = buildErrorOutboxEvents(params());
    expect(enqueueErrorOutbox(sqlite, ev)).toBe(3);
    expect(enqueueErrorOutbox(sqlite, ev)).toBe(0); // dedup (run_id,channel)
    const cnt = (raw.prepare('SELECT COUNT(*) c FROM error_outbox').get() as { c: number }).c;
    expect(cnt).toBe(3);
  });

  it('🚨 ROLLBACK: se un INSERT solleva a metà transazione → ZERO righe persistite', () => {
    // Wrapper che delega al DB reale ma fa throware il 2° .run() dentro la tx.
    let runCalls = 0;
    const faulty: SqliteCompatProxy = {
      prepare: (sql: string) => {
        const s = raw.prepare(sql);
        return {
          run: (...p: unknown[]) => {
            runCalls += 1;
            if (runCalls === 2) throw new Error('disk full mid-transaction');
            return s.run(...(p as Parameters<typeof s.run>));
          },
          get: (...p: unknown[]) => s.get(...(p as Parameters<typeof s.get>)),
          all: (...p: unknown[]) => s.all(...(p as Parameters<typeof s.all>)),
        };
      },
      exec: (sql: string) => {
        raw.exec(sql);
      },
      transaction: <T extends unknown[], R>(fn: (...a: T) => R) =>
        raw.transaction(fn) as (...a: T) => R,
    };
    const ev = buildErrorOutboxEvents(params()); // 3 eventi → il 2° fa throw
    expect(() => enqueueErrorOutbox(faulty, ev)).toThrow(/disk full/);
    const cnt = (raw.prepare('SELECT COUNT(*) c FROM error_outbox').get() as { c: number }).c;
    expect(cnt).toBe(0); // la 1ª riga inserita è stata ROLLBACK-ata: atomicità reale
  });
});
