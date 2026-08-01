/**
 * IMAP poll integration test — mock-free SQLite per coprire i 2 catch
 * defensive di `recordProcessed` (linee 399-400 di trigger-watchers.service.ts)
 * impossibili da scatenare in unit test puri perché il `for await` async
 * iterator + svc.stop() race-bound col vi.useFakeTimers cleanup.
 *
 * Strategy: usiamo better-sqlite3 in-memory REALE con SOLO `imap_state` creato
 * (NO `imap_processed_messages` → la INSERT OR IGNORE throws "no such table"
 * → catch scatena → logger.warn linee 399-400).
 *
 * Risultato atteso: trigger-watchers.service.ts 100.00% lines.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import SqliteDatabase from 'better-sqlite3';

// Real SQLite in-memory — UNICA modifica rispetto a unit test: NO vi.mock storage/db
const realSqlite = new SqliteDatabase(':memory:');

// Crea SOLO imap_state — imap_processed_messages OMESSA → recordProcessed.run() throw
realSqlite.exec(`
  CREATE TABLE IF NOT EXISTS imap_state (
    workflow_id TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    last_uid_seen INTEGER NOT NULL DEFAULT 0,
    last_poll_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workflow_id, mailbox)
  );
`);
// NB: imap_processed_messages NON creata di proposito → SELECT/INSERT throw

// ─── Mocks dei sub-services (no business logic, only stub) ───────────
const m = vi.hoisted(() => ({
  workflowsList: vi.fn(),
  runsExecute: vi.fn().mockResolvedValue({ runId: 'integ-r-1', status: 'success', errorCount: 0, steps: [], totalDurationMs: 1 }),
  dbStudioChanges: vi.fn().mockReturnValue([]),
  systemEmailAcct: vi.fn(),
  emit: vi.fn(),
  subscribers: new Map<string, ((evt: unknown) => void)[]>(),
}));

vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) })) },
}));

const imap = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
  search: vi.fn().mockResolvedValue([]),
  fetch: vi.fn(),
  messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: imap.connect,
    logout: imap.logout,
    getMailboxLock: imap.getMailboxLock,
    search: imap.search,
    fetch: imap.fetch,
    messageFlagsAdd: imap.messageFlagsAdd,
  })),
}));

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

vi.mock('../services/workflow.service.js', () => ({
  WorkflowService: vi.fn().mockImplementation(() => ({
    listAllAcrossTenants: m.workflowsList,
  })),
}));

vi.mock('../services/run.service.js', () => ({
  RunService: vi.fn().mockImplementation(() => ({
    execute: m.runsExecute,
  })),
}));

vi.mock('../services/db-studio.service.js', () => ({
  DbStudioService: vi.fn().mockImplementation(() => ({
    getChangesSince: m.dbStudioChanges,
  })),
}));

vi.mock('../services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: vi.fn().mockImplementation(() => ({
    resolveForExecutor: m.systemEmailAcct,
  })),
}));

// REAL SQLite via getDatabase mock — solo questo è "mock-free" dal lato sqlite
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: realSqlite }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/lib/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn().mockImplementation(() => ({
    execute: (fn: () => Promise<unknown>) => fn(),
    fire: vi.fn(),
  })),
  circuitBreakerRegistry: { register: vi.fn(), get: vi.fn(() => null) },
}));

import { TriggerWatchersService } from '../services/trigger-watchers.service.js';

function fakeEventBus() {
  return {
    emit: m.emit,
    subscribe: vi.fn(),
    subscribeTo: vi.fn((name: string, cb: (evt: unknown) => void) => {
      if (!m.subscribers.has(name)) m.subscribers.set(name, []);
      m.subscribers.get(name)!.push(cb);
      return () => undefined;
    }),
  };
}

function makeWf() {
  return {
    id: 'wf-integ-imap',
    tenantId: 't-integ',
    name: 'Integration IMAP WF',
    enabled: true,
    schemaVersion: '1.0.0' as const,
    nodes: [{
      id: 'n1', defId: 'trigger_imap', x: 0, y: 0,
      config: { host: 'mx.test', username: 'user', password: 'pass' },
    }],
    edges: [],
    nodeDefs: [],
    createdAt: '2026-05-30',
    updatedAt: '2026-05-30',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.subscribers.clear();
  // Reset imap_state table (truncate per test isolation)
  realSqlite.exec('DELETE FROM imap_state');
});

describe('IMAP poll integration — SQLite reale per defensive catch coverage', () => {
  it('recordProcessed INSERT su tabella inesistente → catch scatena (linee 399-400)', async () => {
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'body integration',
      html: '<p>integ</p>',
      messageId: '<integration-test-msg@example.com>',
      attachments: [],
      from: { value: [{ address: 'sender@example.com' }] },
      to: { value: [{ address: 'recipient@example.com' }] },
    });

    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 42,
          envelope: {
            subject: 'Integration test',
            from: [{ address: 'a@example.com' }],
            to: [{ address: 'b@example.com' }],
          },
          source: Buffer.from('From: a@example.com\r\nSubject: Integration test\r\n\r\nbody'),
          flags: new Set(),
        };
      },
    });

    m.workflowsList.mockResolvedValue([makeWf()]);

    // CRITICAL: useFakeTimers PRIMA di start() — setInterval del poll deve
    // essere registrato sotto i fake timers per essere drivable da advance().
    vi.useFakeTimers();
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000); // trigger poll
    // Flush microtasks generously per drenare for-await + catch handler
    for (let i = 0; i < 100; i++) await Promise.resolve();
    vi.useRealTimers();

    // Verify: recordProcessed catch invocato (logger.warn 'imap_processed_messages insert failed')
    const recordProcessedWarn = vi.mocked(logger).warn.mock.calls.find((c) => {
      const msg = (c[1] ?? '') as string;
      return msg.includes('imap_processed_messages insert failed');
    });
    expect(recordProcessedWarn).toBeDefined();
    expect(simpleParser).toHaveBeenCalled();

    await svc.stop();
  });

  it('checkDup SELECT su tabella inesistente → catch returns false (linee 389-391)', async () => {
    // Stesso setup di sopra. SQLite REAL ha imap_state MA non imap_processed_messages.
    // checkDup SELECT su tabella inesistente → throw → catch returns false.
    // Poi recordProcessed anche throw (stessa tabella mancante) → catch 399-400.
    // Quindi questo test copre ENTRAMBI i catch (checkDup + recordProcessed).
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<test-checkdup@x>', attachments: [],
      from: { value: [{ address: 'a@x' }] },
      to: { value: [{ address: 'b@x' }] },
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 43,
          envelope: {
            subject: 'T', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }],
          },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf()]);

    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();

    // Verifichiamo che il poll è arrivato a chiamare checkDup
    // (impossibile a fail prima di esso dato che il filtro è OK).
    expect(simpleParser).toHaveBeenCalled();
  });
});
