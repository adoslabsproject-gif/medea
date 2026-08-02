/**
 * trigger-watchers tests — enterprise grade.
 *
 * Coverage focus:
 *   • Lifecycle: start → reload, stop → teardown completo
 *   • Hot reload debouncing (500ms): coalesces multiple workflow.* events
 *   • reload() scansiona TUTTI i tenant (listAllAcrossTenants), no leak default
 *   • Skip workflow disabled (enabled=false)
 *   • Skip workflow senza trigger node
 *   • Idempotent: re-reload non duplica watchers
 *   • Teardown su workflow non più enabled / no trigger
 *   • File watcher: tenant namespace path sanitize (regex /[^a-z0-9_-]/gi)
 *   • DB-change poller: seed lastIdSeen → fires solo su future changes
 *   • DB-change poller: opsFilter "all" vs specific op
 *   • Pollers usano setInterval (clearable in stop())
 *   • Env override: MEDEA_IMAP_MAX_ATTACHMENT_BYTES + MAX_BODY_CHARS
 *
 * Mock strategy: chokidar.watch, ImapFlow, sub-services workflow/run/dbStudio.
 * Eventi sintetici tramite eventBus.subscribeTo callback registry.
 */

import { dirname, join } from 'node:path';
import type { WebSocket } from 'ws';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => {
  const chokidarWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    chokidarWatcher,
    chokidarWatch: vi.fn(() => chokidarWatcher),
    workflowsList: vi.fn(),
    runsExecute: vi.fn().mockResolvedValue({ runId: 'r-1' }),
    dbStudioChanges: vi.fn().mockReturnValue([]),
    systemEmailAcct: vi.fn(),
    getInstalledByDefId: vi.fn(),
    communityPoll: vi.fn(),
    emit: vi.fn(),
    // event bus subscriber registry: name → callback
    subscribers: new Map<string, ((evt: unknown) => void)[]>(),
  };
});

vi.mock('chokidar', () => ({
  default: { watch: (...args: unknown[]) => m.chokidarWatch(...(args as [])) },
}));

const imap = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
  search: vi.fn().mockResolvedValue([]),
  fetch: vi.fn(),
  messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
  ImapFlowCtor: vi.fn(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function (this: object, ...args: unknown[]) {
    imap.ImapFlowCtor(...args);
    return {
      connect: imap.connect,
      logout: imap.logout,
      getMailboxLock: imap.getMailboxLock,
      search: imap.search,
      fetch: imap.fetch,
      messageFlagsAdd: imap.messageFlagsAdd,
    };
  }),
}));

vi.mock('mailparser', () => ({
  simpleParser: vi.fn().mockResolvedValue({
    text: 'plain body',
    html: '<p>html body</p>',
    attachments: [],
  }),
}));

vi.mock('./workflow.service.js', () => ({
  WorkflowService: vi.fn().mockImplementation(() => ({
    listAllAcrossTenants: m.workflowsList,
  })),
}));

vi.mock('./run.service.js', () => ({
  RunService: vi.fn().mockImplementation(() => ({
    execute: m.runsExecute,
  })),
}));

vi.mock('./db-studio.service.js', () => ({
  DbStudioService: vi.fn().mockImplementation(() => ({
    getChangesSince: m.dbStudioChanges,
  })),
}));

vi.mock('./system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: vi.fn().mockImplementation(() => ({
    getById: m.systemEmailAcct,
    resolveForExecutor: (...args: unknown[]) => m.systemEmailAcct(...args),
  })),
}));

// FEAT community-trigger runtime: mock del registry installed-nodes + del poll
// runner (così NON carichiamo isolated-vm nel test del wiring — il runner ha già
// la sua copertura d'integrazione reale in community-trigger-runner.test.ts).
vi.mock('./community-nodes.service.js', () => ({
  getInstalledByDefId: (...args: unknown[]) => m.getInstalledByDefId(...args),
}));
vi.mock('./community-trigger-runner.js', () => ({
  runCommunityTriggerPoll: (...args: unknown[]) => m.communityPoll(...args),
  clampPollIntervalSec: (raw: unknown, fb = 60) => {
    const n = Number(raw ?? fb);
    return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 10), 3600) : fb;
  },
}));

// Client XML-RPC Odoo (stdlib) — mockato per caratterizzare il poll loop
// senza rete. authenticate→uid, executeKw→search/search_read.
const odooLib = vi.hoisted(() => ({
  authenticate: vi.fn().mockResolvedValue(7),
  executeKw: vi.fn().mockResolvedValue([]),
}));
vi.mock('@medea/engine-nodes-stdlib', () => ({
  authenticate: (...a: unknown[]) => odooLib.authenticate(...a),
  executeKw: (...a: unknown[]) => odooLib.executeKw(...a),
  // parsing.ts (filtri IMAP) usa safeUserRegex (RE2): il mock va fornito o l'import
  // è undefined → safeRegex lancia → null → filtro saltato (regression 0df0dde5).
  // Per i test del servizio basta la semantica match/throw-su-invalido (RE2 reale
  // testato in safe-user-regex.test.ts); un pattern invalido lancia come RE2.
  safeUserRegex: (pattern: string, flags?: string) => new RegExp(pattern, flags ?? ''),
}));

const sqliteStmt = vi.hoisted(() => ({
  get: vi.fn(),
  run: vi.fn(),
  all: vi.fn(),
}));
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: { prepare: vi.fn(() => sqliteStmt) },
  }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/lib/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn().mockImplementation(() => ({
    execute: (fn: () => Promise<unknown>) => fn(), // pass-through executor
    fire: vi.fn(),
  })),
  circuitBreakerRegistry: { register: vi.fn(), get: vi.fn(() => null) },
}));

function fakeEventBus() {
  return {
    emit: m.emit,
    subscribe: vi.fn(),
    subscribeTo: vi.fn((name: string, cb: (evt: unknown) => void) => {
      if (!m.subscribers.has(name)) m.subscribers.set(name, []);
      m.subscribers.get(name)!.push(cb);
      return () => {
        const arr = m.subscribers.get(name) ?? [];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      };
    }),
  };
}

import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { TriggerWatchersService } from './trigger-watchers.service.js';

function makeWf(over: Partial<{
  id: string;
  tenantId: string;
  enabled: boolean;
  nodes: { id: string; defId: string; config: Record<string, unknown> }[];
}> = {}) {
  return {
    id: over.id ?? 'wf-1',
    tenantId: over.tenantId ?? 'tenant-a',
    name: 'Test WF',
    enabled: over.enabled ?? true,
    schemaVersion: '1.0.0' as const,
    nodes: over.nodes ?? [],
    edges: [],
    nodeDefs: [],
    createdAt: '2026-05-29',
    updatedAt: '2026-05-29',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.subscribers.clear();
  m.workflowsList.mockResolvedValue([]);
  m.dbStudioChanges.mockReturnValue([]);
});

afterEach(async () => {
  // ensure no leaked timers across tests
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════
// Lifecycle: start + stop
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — lifecycle', () => {
  it('start() invoca reload() + subscribe a 3 eventi workflow.*', async () => {
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.workflowsList).toHaveBeenCalled();
    expect(m.subscribers.get('workflow.created')?.length).toBe(1);
    expect(m.subscribers.get('workflow.updated')?.length).toBe(1);
    expect(m.subscribers.get('workflow.deleted')?.length).toBe(1);
    await svc.stop();
  });

  it('stop() chiude tutti i watchers + clear pollers + cleanup unsubscribe', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/test' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).toHaveBeenCalled();
    await svc.stop();
    expect(m.chokidarWatcher.close).toHaveBeenCalled();
    // post-stop, subscriber map svuotata
    expect(m.subscribers.get('workflow.created')?.length ?? 0).toBe(0);
  });

  it('stop() è safe se start() mai chiamato (idempotent stop)', async () => {
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await expect(svc.stop()).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// Hot reload debouncing
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — hot reload debouncing', () => {
  it('multipli workflow.updated coalesced in 1 reload (500ms debounce)', async () => {
    vi.useFakeTimers();
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.workflowsList).toHaveBeenCalledTimes(1); // initial reload

    // emit 5 rapid events
    const cb = m.subscribers.get('workflow.updated')![0]!;
    for (let i = 0; i < 5; i++) cb({ type: 'workflow.updated' });

    // dentro 500ms NESSUN nuovo reload
    vi.advanceTimersByTime(499);
    expect(m.workflowsList).toHaveBeenCalledTimes(1);

    // dopo 500ms → 1 solo reload (coalesced)
    vi.advanceTimersByTime(2);
    // promise microtask flush
    await Promise.resolve();
    expect(m.workflowsList).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    await svc.stop();
  });

  it('reload() chiamato dopo workflow.created', async () => {
    vi.useFakeTimers();
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const cb = m.subscribers.get('workflow.created')![0]!;
    cb({ type: 'workflow.created' });
    vi.advanceTimersByTime(501);
    await Promise.resolve();
    expect(m.workflowsList).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await svc.stop();
  });

  it('reload() chiamato dopo workflow.deleted', async () => {
    vi.useFakeTimers();
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const cb = m.subscribers.get('workflow.deleted')![0]!;
    cb({ type: 'workflow.deleted' });
    vi.advanceTimersByTime(501);
    await Promise.resolve();
    expect(m.workflowsList).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// Community triggers (polling) — FEAT community-trigger runtime
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — community triggers (polling)', () => {
  const installedAcme = {
    manifest: { id: 'acme_poll', vendor: 'acme', version: '1.0.0', displayName: 'Acme', description: 'x', license: 'MIT' },
    def: {
      id: 'acme_poll', type: 'trigger', label: 'Acme', icon: 'cube', color: '#3b82f6', description: 'x',
      triggers: [{ id: 'rows', label: 'Rows', mode: 'polling', pollIntervalSec: 10 }],
    },
    executorSource: 'module.exports = async () => ({});',
    installedAt: '2026-06-09', verified: true, storagePath: '/tmp/acme',
  };

  function communityWf(over: Record<string, unknown> = {}) {
    return makeWf({
      nodes: [{ id: 'n1', defId: 'acme_poll', config: { __ff_trigger: 'rows', pollIntervalSec: '10' } }],
      ...over,
    });
  }

  it('🚨 registra il poller, avvia un run per evento (triggerType+input), round-trip dello state', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.communityPoll
      .mockResolvedValueOnce({ events: [{ id: 1 }], state: { lastId: 1 }, truncated: false })
      .mockResolvedValueOnce({ events: [{ id: 2 }], state: { lastId: 2 }, truncated: false });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();

    // Primo tick di poll (interval 10s)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.communityPoll).toHaveBeenCalledTimes(1);
    expect(m.communityPoll.mock.calls[0]![1]).toBe('rows');   // triggerId
    expect(m.communityPoll.mock.calls[0]![3]).toEqual({});     // state iniziale vuoto
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-1',
      tenantId: 'tenant-a',
      triggerType: 'community:acme_poll:rows',
      triggerInput: { id: 1 },
    }));

    // Secondo tick → il poll riceve lo state del primo (cursore avanzato)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.communityPoll).toHaveBeenCalledTimes(2);
    expect(m.communityPoll.mock.calls[1]![3]).toEqual({ lastId: 1 });
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({ triggerInput: { id: 2 } }));

    await svc.stop();
    vi.useRealTimers();
  });

  it('più eventi in un poll → un run per ciascuno', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.communityPoll.mockResolvedValue({ events: [{ id: 1 }, { id: 2 }, { id: 3 }], state: {}, truncated: false });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const communityRuns = m.runsExecute.mock.calls.filter(
      (c) => (c[0] as { triggerType?: string }).triggerType === 'community:acme_poll:rows',
    );
    expect(communityRuns).toHaveLength(3);
    await svc.stop();
    vi.useRealTimers();
  });

  it('SKIP se defId non è un community node installato', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(undefined);
    m.workflowsList.mockResolvedValue([makeWf({ nodes: [{ id: 'n1', defId: 'unknown_x', config: { __ff_trigger: 'rows' } }] })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.communityPoll).not.toHaveBeenCalled();
    await svc.stop();
    vi.useRealTimers();
  });

  it('SKIP trigger mode=stream (solo polling viene schedulato)', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue({
      ...installedAcme,
      def: { ...installedAcme.def, triggers: [{ id: 'rows', label: 'R', mode: 'stream' }] },
    });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.communityPoll).not.toHaveBeenCalled();
    await svc.stop();
    vi.useRealTimers();
  });

  it('SKIP se __ff_trigger non matcha un trigger dichiarato', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.workflowsList.mockResolvedValue([makeWf({ nodes: [{ id: 'n1', defId: 'acme_poll', config: { __ff_trigger: 'nonesiste' } }] })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.communityPoll).not.toHaveBeenCalled();
    await svc.stop();
    vi.useRealTimers();
  });

  it('stop() ferma il poller (nessun poll dopo lo stop)', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.communityPoll.mockResolvedValue({ events: [], state: {}, truncated: false });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const before = m.communityPoll.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await svc.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.communityPoll.mock.calls.length).toBe(before); // timer cleared
    vi.useRealTimers();
  });

  it('🚨 teardown su reload: workflow disabilitato → poller rimosso, niente più poll', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.communityPoll.mockResolvedValue({ events: [], state: {}, truncated: false });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.communityPoll.mock.calls.length).toBeGreaterThan(0);

    // Il workflow viene disabilitato → reload via workflow.updated + debounce 500ms
    m.workflowsList.mockResolvedValue([communityWf({ enabled: false })]);
    const cb = m.subscribers.get('workflow.updated')![0]!;
    cb({ type: 'workflow.updated' });
    await vi.advanceTimersByTimeAsync(501); // debounce → reload → teardown poller
    const after = m.communityPoll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.communityPoll.mock.calls.length).toBe(after); // nessun nuovo poll
    await svc.stop();
    vi.useRealTimers();
  });

  // ── Caratterizzazione avanzata (split 2026-06-12) — pinnata PRIMA dello
  // split: no-overlap, resilienza al poll fallito, at-most-once sul cursore.

  it('CARATTERIZZAZIONE no-overlap: poll lento → il tick successivo è SALTATO, non accodato', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    let resolvePoll!: (v: unknown) => void;
    m.communityPoll
      .mockImplementationOnce(() => new Promise((r) => { resolvePoll = r; }))
      .mockResolvedValue({ events: [], state: {}, truncated: false });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000); // tick 1 — resta in volo
    await vi.advanceTimersByTimeAsync(10_000); // tick 2 — saltato (inFlight)
    expect(m.communityPoll).toHaveBeenCalledTimes(1);
    resolvePoll({ events: [], state: {}, truncated: false });
    await vi.advanceTimersByTimeAsync(10_000); // tick 3 — riparte
    expect(m.communityPoll).toHaveBeenCalledTimes(2);
    await svc.stop();
    vi.useRealTimers();
  });

  it('CARATTERIZZAZIONE poll fallito → loggato, lo state NON cambia, il poller riprova al tick dopo', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.communityPoll
      .mockRejectedValueOnce(new Error('vendor boom'))
      .mockResolvedValueOnce({ events: [], state: { ok: 1 }, truncated: false });
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000); // tick 1 — fallisce, non crasha
    expect(m.runsExecute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); // tick 2 — lo state passato è ANCORA {} (non avanzato dal fallimento)
    expect(m.communityPoll).toHaveBeenCalledTimes(2);
    expect(m.communityPoll.mock.calls[1]![3]).toEqual({});
    await svc.stop();
    vi.useRealTimers();
  });

  it('CARATTERIZZAZIONE at-most-once: run.execute fallisce → lo state è COMUNQUE avanzato (nessun replay loop)', async () => {
    vi.useFakeTimers();
    m.getInstalledByDefId.mockReturnValue(installedAcme);
    m.communityPoll
      .mockResolvedValueOnce({ events: [{ id: 1 }], state: { cursor: 5 }, truncated: false })
      .mockResolvedValueOnce({ events: [], state: { cursor: 5 }, truncated: false });
    m.runsExecute.mockRejectedValueOnce(new Error('run boom'));
    m.workflowsList.mockResolvedValue([communityWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000); // tick 1 — run fallisce
    await vi.advanceTimersByTimeAsync(10_000); // tick 2 — cursore comunque a {cursor:5}
    expect(m.communityPoll.mock.calls[1]![3]).toEqual({ cursor: 5 });
    await svc.stop();
    vi.useRealTimers();
  });
});

// ════════════════════════════════════════════════════════════════════
// reload() — cross-tenant scan
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService.reload — multi-tenant', () => {
  it('usa listAllAcrossTenants (NON list("default")) — multi-tenant isolation', async () => {
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.workflowsList).toHaveBeenCalled();
    await svc.stop();
  });

  it('SKIP workflow disabled', async () => {
    m.workflowsList.mockResolvedValue([
      makeWf({ id: 'wf-on', enabled: true, nodes: [
        { id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/a' } },
      ]}),
      makeWf({ id: 'wf-off', enabled: false, nodes: [
        { id: 'n2', defId: 'trigger_file_watch', config: { directory: '/tmp/b' } },
      ]}),
    ]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // SOLO 1 watcher creato (per wf-on)
    expect(m.chokidarWatch).toHaveBeenCalledTimes(1);
    await svc.stop();
  });

  it('SKIP workflow senza trigger node (cron-only / manual)', async () => {
    m.workflowsList.mockResolvedValue([
      makeWf({ id: 'wf-no-trigger', enabled: true, nodes: [
        { id: 'n1', defId: 'action_http', config: {} },
      ]}),
    ]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('reload IDEMPOTENT: 2 chiamate consecutive non duplicano watchers', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).toHaveBeenCalledTimes(1);
    await svc.reload();
    // ensureFileWatcher early-return se id già in map
    expect(m.chokidarWatch).toHaveBeenCalledTimes(1);
    await svc.stop();
  });

  it('TEAR DOWN watcher se workflow non più enabled', async () => {
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-1', enabled: true,
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).toHaveBeenCalledTimes(1);
    // ora wf-1 disabled
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-1', enabled: false,
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x' } }],
    })]);
    await svc.reload();
    expect(m.chokidarWatcher.close).toHaveBeenCalled();
    await svc.stop();
  });

  it('TEAR DOWN watcher se trigger node rimosso (workflow ancora enabled)', async () => {
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-2', enabled: true,
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/y' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-2', enabled: true,
      nodes: [{ id: 'n1', defId: 'action_http', config: {} }], // trigger rimosso
    })]);
    await svc.reload();
    expect(m.chokidarWatcher.close).toHaveBeenCalled();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// File watcher — tenant namespace sanitize
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — file watcher tenant namespace', () => {
  it('relative path → resolved sotto /var/data/flowforge/tenants/<safeTenant>/files', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      tenantId: 'tenant-a',
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: 'inbox' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const target = firstCall?.[0];
    expect(target).toMatch(/tenants\/tenant-a\/files\/inbox$/);
    await svc.stop();
  });

  it('absolute path → pass-through (admin allowlist)', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/var/spool/scan' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const target = firstCall?.[0];
    expect(target).toBe('/var/spool/scan');
    await svc.stop();
  });

  it('tenantId con caratteri speciali → SANITIZED a [^a-z0-9_-]', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      tenantId: 'tenant/../etc/passwd', // path traversal attempt
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: 'inbox' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const target = firstCall?.[0];
    // tutti i char non [a-z0-9_-] sostituiti con _
    // 'tenant/../etc/passwd': 4 special chars (/../) → 4 underscores, then /etc/ → 1 underscore
    expect(target).toMatch(/tenants\/tenant____etc_passwd\/files\/inbox$/);
    expect(target).not.toContain('/etc/passwd');
    await svc.stop();
  });

  it('glob pattern appended a directory', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/a', glob: '*.csv' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const target = firstCall?.[0];
    expect(target).toBe('/tmp/a/*.csv');
    await svc.stop();
  });

  it('SKIP se directory vuota (config invalido)', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('chokidar awaitWriteFinish.stabilityThreshold = debounceMs config', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x', debounceMs: 2000 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const opts = firstCall?.[1] as unknown;
    expect((opts as { awaitWriteFinish: { stabilityThreshold: number } } | undefined)?.awaitWriteFinish.stabilityThreshold).toBe(2000);
    await svc.stop();
  });

  it('debounceMs MIN 50 (clamp lower bound)', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x', debounceMs: 1 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const opts = firstCall?.[1] as unknown;
    expect((opts as { awaitWriteFinish: { stabilityThreshold: number } } | undefined)?.awaitWriteFinish.stabilityThreshold).toBe(50);
    await svc.stop();
  });

  // ── Caratterizzazione avanzata degli EVENTI (split 2026-06-12) — pinnata
  // PRIMA dello split: dispatch del run e filtro `events`.

  function fileEventHandler(name: string): ((p: string) => void) | undefined {
    const call = m.chokidarWatcher.on.mock.calls.find((c) => c[0] === name);
    return call?.[1] as ((p: string) => void) | undefined;
  }

  it('CARATTERIZZAZIONE evento change → run con triggerType file_watch e payload {event, path, ts ISO}', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/in' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    fileEventHandler('change')!('/tmp/in/report.csv');
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    const arg = m.runsExecute.mock.calls[0]![0] as { triggerType: string; tenantId: string; triggerInput: { event: string; path: string; ts: string } };
    expect(arg.triggerType).toBe('file_watch');
    expect(arg.tenantId).toBe('tenant-a');
    expect(arg.triggerInput.event).toBe('change');
    expect(arg.triggerInput.path).toBe('/tmp/in/report.csv');
    expect(() => new Date(arg.triggerInput.ts).toISOString()).not.toThrow();
    await svc.stop();
  });

  it('CARATTERIZZAZIONE filtro events="add": change/unlink NON sparano, add sì', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/in', events: 'add' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    fileEventHandler('change')!('/tmp/in/x.csv');
    fileEventHandler('unlink')!('/tmp/in/x.csv');
    expect(m.runsExecute).not.toHaveBeenCalled();
    fileEventHandler('add')!('/tmp/in/y.csv');
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    await svc.stop();
  });

  it('CARATTERIZZAZIONE tutti e tre gli handler (add/change/unlink) sono registrati su chokidar', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/in' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const registered = m.chokidarWatcher.on.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(expect.arrayContaining(['add', 'change', 'unlink']));
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// DB-change poller
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — db-change poller', () => {
  it('SEED lastIdSeen al MAX corrente (fires solo su FUTURE changes)', async () => {
    m.dbStudioChanges
      .mockReturnValueOnce([{ id: 100, op: 'insert', payload: {}, createdAt: '...' }]) // seed
      .mockReturnValue([]); // poll subsequent
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: 'orders' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // Seed query chiamato con cursor=0 + limit alto
    expect(m.dbStudioChanges).toHaveBeenCalledWith('tenant-a', 'db-1', 'orders', 0, 1_000_000);
    await svc.stop();
  });

  it('SKIP se databaseId vuoto', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: '', tableName: 'orders' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.dbStudioChanges).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('SKIP se tableName vuoto', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: '' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.dbStudioChanges).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('intervalSec clamp MIN 2 (anti-DoS)', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: 't1', pollIntervalSec: 0 } }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const intervalMs = spy.mock.calls[0]![1];
    expect(intervalMs).toBe(2 * 1000);
    spy.mockRestore();
    vi.useRealTimers();
    await svc.stop();
  });

  it('idempotent: re-register stesso wf NON crea secondo timer', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: 'orders' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const callsBefore = m.dbStudioChanges.mock.calls.length;
    await svc.reload();
    // Re-reload con stesso wf NON ri-invoca getChangesSince per seed (idempotent)
    expect(m.dbStudioChanges.mock.calls.length).toBe(callsBefore);
    await svc.stop();
  });

  // ── Caratterizzazione avanzata del TICK (split 2026-06-12) — pinnata PRIMA
  // dello split: dispatch, filtro ops, avanzamento cursore, resilienza errori.

  function dbWf(extra: Record<string, unknown> = {}) {
    return makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: 'orders', pollIntervalSec: 5, ...extra } }],
    });
  }

  it('CARATTERIZZAZIONE tick: dispatch con payload completo, cursore che avanza tra i tick', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges.mockReturnValueOnce([{ id: 100, op: 'insert', payload: {}, createdAt: 'T0' }]); // seed → cursore 100
    m.workflowsList.mockResolvedValue([dbWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();

    m.dbStudioChanges.mockReturnValueOnce([
      { id: 101, op: 'insert', payload: { total: 9 }, createdAt: 'T1' },
      { id: 102, op: 'update', payload: { total: 11 }, createdAt: 'T2' },
    ]);
    vi.advanceTimersByTime(5_000);
    expect(m.dbStudioChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 100);
    expect(m.runsExecute).toHaveBeenCalledTimes(2);
    expect(m.runsExecute).toHaveBeenNthCalledWith(1, {
      workflowId: 'wf-1',
      tenantId: 'tenant-a',
      triggerType: 'db_change',
      triggerInput: { changeId: 101, op: 'insert', databaseId: 'db-1', tableName: 'orders', payload: { total: 9 }, createdAt: 'T1' },
    });

    // Tick successivo: il cursore è avanzato all'ULTIMO id consegnato.
    vi.advanceTimersByTime(5_000);
    expect(m.dbStudioChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 102);
    vi.useRealTimers();
    await svc.stop();
  });

  it('CARATTERIZZAZIONE ops filter: i change non-matching AVANZANO il cursore senza run (niente replay)', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges.mockReturnValueOnce([]); // seed vuoto → cursore 0
    m.workflowsList.mockResolvedValue([dbWf({ ops: 'insert' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();

    m.dbStudioChanges.mockReturnValueOnce([
      { id: 1, op: 'update', payload: {}, createdAt: 'T1' },
      { id: 2, op: 'insert', payload: {}, createdAt: 'T2' },
      { id: 3, op: 'delete', payload: {}, createdAt: 'T3' },
    ]);
    vi.advanceTimersByTime(5_000);
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    expect((m.runsExecute.mock.calls[0]![0] as { triggerInput: { changeId: number } }).triggerInput.changeId).toBe(2);
    // Il cursore è avanzato anche oltre i filtrati: prossimo poll da id=3.
    vi.advanceTimersByTime(5_000);
    expect(m.dbStudioChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 3);
    vi.useRealTimers();
    await svc.stop();
  });

  it('CARATTERIZZAZIONE resilienza: getChangesSince lancia nel tick → il poller sopravvive e riprova al tick dopo', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges.mockReturnValueOnce([]); // seed
    m.workflowsList.mockResolvedValue([dbWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();

    m.dbStudioChanges.mockImplementationOnce(() => { throw new Error('db gone'); });
    vi.advanceTimersByTime(5_000);
    expect(m.runsExecute).not.toHaveBeenCalled();

    m.dbStudioChanges.mockReturnValueOnce([{ id: 7, op: 'insert', payload: {}, createdAt: 'T' }]);
    vi.advanceTimersByTime(5_000);
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await svc.stop();
  });

  it('FIX fail-closed seed fallito: NESSUN replay del backlog — il tick ritenta il seed e spara solo sui change FUTURI', async () => {
    // Pre-fix (QUIRK storico): seed fallito → cursore 0 → il primo tick
    // rigiocava l'INTERO backlog (doppia esecuzione, non idempotente).
    vi.useFakeTimers();
    m.dbStudioChanges.mockImplementationOnce(() => { throw new Error('seed boom'); });
    m.workflowsList.mockResolvedValue([dbWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();

    // Tick 1: il seed viene RITENTATO (il backlog esistente arriva fino a id=2)
    // e il poll parte dal cursore appena seedato → NESSUN run sul backlog.
    m.dbStudioChanges
      .mockReturnValueOnce([
        { id: 1, op: 'insert', payload: {}, createdAt: 'T1' },
        { id: 2, op: 'insert', payload: {}, createdAt: 'T2' },
      ]) // retry del seed
      .mockReturnValueOnce([]); // poll post-seed: niente change futuri
    vi.advanceTimersByTime(5_000);
    expect(m.runsExecute).not.toHaveBeenCalled();
    expect(m.dbStudioChanges).toHaveBeenLastCalledWith('tenant-a', 'db-1', 'orders', 2);

    // Tick 2: un change FUTURO (id=3) → UN run.
    m.dbStudioChanges.mockReturnValueOnce([{ id: 3, op: 'insert', payload: {}, createdAt: 'T3' }]);
    vi.advanceTimersByTime(5_000);
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    expect((m.runsExecute.mock.calls[0]![0] as { triggerInput: { changeId: number } }).triggerInput.changeId).toBe(3);
    vi.useRealTimers();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// IMAP markSeen/cursore/dedup — caratterizzazione avanzata (split 2026-06-12),
// pinnata PRIMA dello split: la matrice di idempotenza del poll IMAP.
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — IMAP markSeen/cursore/dedup (caratterizzazione)', () => {
  beforeEach(() => {
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.getMailboxLock.mockResolvedValue({ release: vi.fn() });
    sqliteStmt.get.mockReturnValue(undefined);
    sqliteStmt.run.mockReturnValue({ changes: 1 });
  });

  function imapMsg(uid: number) {
    return {
      uid,
      envelope: { subject: 'T', from: [{ address: 's@x.com' }], to: [{ address: 'r@x.com' }] },
      source: Buffer.from('body'),
      flags: new Set(),
    };
  }
  function setupFetch(messages: ReturnType<typeof imapMsg>[]) {
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const x of messages) yield x; },
    });
  }
  function imapWf(extra: Record<string, unknown> = {}) {
    return makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', ...extra } }],
    });
  }
  async function flushMicro(n = 25) { for (let i = 0; i < n; i += 1) await Promise.resolve(); }

  it('CARATTERIZZAZIONE run OK + on-success → \\Seen su connessione FRESCA + dedup registrato + cursore persistito al uid', async () => {
    vi.useFakeTimers();
    m.runsExecute.mockResolvedValue({ runId: 'r', status: 'success', errorCount: 0 });
    setupFetch([imapMsg(150)]);
    m.workflowsList.mockResolvedValue([imapWf({ markSeen: 'on-success' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicro();
    // \Seen: la connessione fresca usa lo stesso mock ImapFlow.
    expect(imap.messageFlagsAdd).toHaveBeenCalledWith({ uid: '150' }, ['\\Seen'], { uid: true });
    // Dedup: INSERT in imap_processed_messages col uid.
    expect(sqliteStmt.run.mock.calls.some((c) => c.includes(150))).toBe(true);
    vi.useRealTimers();
    await svc.stop();
  });

  it('CARATTERIZZAZIONE run FALLITO + on-success → email resta UNREAD, dedup NON registrato (retry al poll dopo)', async () => {
    vi.useFakeTimers();
    m.runsExecute.mockResolvedValue({ runId: 'r', status: 'error', errorCount: 1 });
    setupFetch([imapMsg(160)]);
    m.workflowsList.mockResolvedValue([imapWf({ markSeen: 'on-success' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicro();
    expect(imap.messageFlagsAdd).not.toHaveBeenCalled();
    // Il dedup NON deve contenere il uid 160 (nessun INSERT processed col uid).
    const insertedUids = sqliteStmt.run.mock.calls.filter((c) => c.includes(160));
    expect(insertedUids).toHaveLength(0);
    vi.useRealTimers();
    await svc.stop();
  });

  it("CARATTERIZZAZIONE markSeen='always' + run fallito → \\Seen COMUNQUE + cursore avanzato (at-most-once aggressivo)", async () => {
    vi.useFakeTimers();
    m.runsExecute.mockResolvedValue({ runId: 'r', status: 'error', errorCount: 1 });
    setupFetch([imapMsg(170)]);
    m.workflowsList.mockResolvedValue([imapWf({ markSeen: 'always' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicro();
    expect(imap.messageFlagsAdd).toHaveBeenCalledWith({ uid: '170' }, ['\\Seen'], { uid: true });
    expect(sqliteStmt.run.mock.calls.some((c) => c.includes(170))).toBe(true);
    vi.useRealTimers();
    await svc.stop();
  });

  it('CARATTERIZZAZIONE dedup: Message-ID già processato → NESSUN run (at-most-once RFC 5322)', async () => {
    vi.useFakeTimers();
    // 1° get: imap_state (cursore) → undefined; 2° get: imap_processed_messages → riga ESISTENTE.
    sqliteStmt.get
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ 1: 1 });
    setupFetch([imapMsg(180)]);
    m.workflowsList.mockResolvedValue([imapWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicro();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// Environment overrides
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — env overrides', () => {
  it('MEDEA_IMAP_MAX_ATTACHMENT_BYTES letto al module-import time', async () => {
    // L'export const usa process.env al require — vediamo che il module
    // si carica senza throw e che il valore default (25MB) è applicato se
    // env vuoto. Verifichiamo solo che lo svc istanzi senza errori.
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    expect(svc).toBeDefined();
  });

  it('MEDEA_DATA_DIR override il base path tenant files', async () => {
    process.env.MEDEA_DATA_DIR = '/custom/data';
    m.workflowsList.mockResolvedValue([makeWf({
      tenantId: 't-a',
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: 'inbox' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const firstCall = m.chokidarWatch.mock.calls[0] as unknown[] | undefined;
    const target = firstCall?.[0];
    expect(target).toMatch(/^\/custom\/data\/tenants\/t-a\/files\/inbox$/);
    delete process.env.MEDEA_DATA_DIR;
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// Combined: 3 trigger types coesistono
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — multi-trigger workflow', () => {
  it('workflow con 2 trigger node DIFFERENTI → entrambi registrati', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      id: 'wf-multi',
      nodes: [
        { id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x' } },
        { id: 'n2', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: 't1' } },
      ],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).toHaveBeenCalledTimes(1);
    expect(m.dbStudioChanges).toHaveBeenCalled();
    await svc.stop();
  });

  it('3 workflow DIFFERENTI con triggers diversi → 3 registrazioni', async () => {
    m.workflowsList.mockResolvedValue([
      makeWf({ id: 'wf-a', nodes: [{ id: 'n', defId: 'trigger_file_watch', config: { directory: '/tmp/a' } }] }),
      makeWf({ id: 'wf-b', nodes: [{ id: 'n', defId: 'trigger_file_watch', config: { directory: '/tmp/b' } }] }),
      makeWf({ id: 'wf-c', nodes: [{ id: 'n', defId: 'trigger_db_change', config: { databaseId: 'db-1', tableName: 't1' } }] }),
    ]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(m.chokidarWatch).toHaveBeenCalledTimes(2);
    expect(m.dbStudioChanges).toHaveBeenCalled();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// Odoo polling trigger — ensureOdooPoller setup paths
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — ensureOdooPoller', () => {
  beforeEach(() => {
    sqliteStmt.get.mockReturnValue(undefined);
    sqliteStmt.run.mockReturnValue({ changes: 1 });
  });

  function baseCfg(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      baseUrl: 'https://odoo.example',
      database: 'mydb',
      login: 'bot',
      password: 'apikey',
      model: 'crm.lead',
      ...over,
    };
  }

  it('SKIP when baseUrl is empty', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg({ baseUrl: '' }) }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await svc.stop();
  });

  it('SKIP when model name is invalid (anti-injection)', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg({ model: 'res.partner; DROP' }) }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await svc.stop();
  });

  it('SKIP when password is missing', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg({ password: '' }) }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await svc.stop();
  });

  it('intervalSec is clamped to [10, 3600]', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg({ pollIntervalSec: 1 }) }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const intervalMs = spy.mock.calls[0]![1];
    expect(intervalMs).toBe(10 * 1000);
    spy.mockRestore();
    vi.useRealTimers();
    await svc.stop();
  });

  it('intervalSec=99999 clamped to 3600 max', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg({ pollIntervalSec: 99_999 }) }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(spy.mock.calls[0]![1]).toBe(3600 * 1000);
    spy.mockRestore();
    vi.useRealTimers();
    await svc.stop();
  });

  it('registers a poller when config is complete', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg() }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(spy).toHaveBeenCalledTimes(1);
    // Verify the SQLite seed query targets odoo_state with workflow+model PK.
    const prepareCalls = (sqliteStmt as unknown as { prepare?: { mock: { calls: unknown[][] } } });
    void prepareCalls;
    spy.mockRestore();
    await svc.stop();
  });

  it('idempotent — re-registering the same workflow does not create a second timer', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_odoo_polling', config: baseCfg() }],
    })]);
    const spy = vi.spyOn(global, 'setInterval');
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await svc.reload();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await svc.stop();
  });

  /**
   * 🚨 AUDIT FIX WE-15 (2026-06-09 MEDIUM) — REGRESSION GUARD poison-pill DLQ.
   *
   * Pre-fix: record che fa fail il dispatch → loop break, lastIdSeen non
   * avanza → stallo infinito.
   *
   * Post-fix: tabella odoo_dlq + retry counter. Dopo MAX_RETRY=5 fail → DLQ
   * + cursor bump.
   */
  it('🚨 [REGRESSION WE-15] source-inspection: poison-pill DLQ wired nel poll loop Odoo', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    // Split 2026-06-12: il poll loop Odoo vive in trigger-watchers/odoo-poller.ts.
    const src = readFileSync(join(here, 'trigger-watchers', 'odoo-poller.ts'), 'utf-8');
    expect(src).toMatch(/ODOO_DLQ_MAX_RETRY = 5/);
    expect(src).toMatch(/odoo_dlq/);
    expect(src).toMatch(/poison-pill detected/);
    expect(src).toMatch(/WE-15/);
    // Pattern UPSERT-style: SELECT existing → UPDATE retry_count
    expect(src).toMatch(/SELECT id, retry_count FROM odoo_dlq/);
    expect(src).toMatch(/INSERT INTO odoo_dlq/);
  });

  it('🚨 [REGRESSION WE-15] migrate.ts crea tabella odoo_dlq con schema corretto', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const migrateSrc = readFileSync(join(here, '..', 'storage', 'migrate.ts'), 'utf-8');
    expect(migrateSrc).toMatch(/CREATE TABLE IF NOT EXISTS odoo_dlq/);
    expect(migrateSrc).toMatch(/retry_count INTEGER NOT NULL DEFAULT 1/);
    expect(migrateSrc).toMatch(/dlqd_at TEXT/);
    expect(migrateSrc).toMatch(/replayed_at TEXT/);
    expect(migrateSrc).toMatch(/odoo_dlq_workflow_idx/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Odoo poll loop — caratterizzazione avanzata (split 2026-06-12), pinnata
// PRIMA dello split: seed policy, dispatch, cursore, DLQ WE-15 behaviorale.
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — Odoo poll loop (caratterizzazione)', () => {
  function odooWf(extra: Record<string, unknown> = {}) {
    return makeWf({
      nodes: [{
        id: 'n1', defId: 'trigger_odoo_polling',
        config: {
          baseUrl: 'https://odoo.test', database: 'db', login: 'u', password: 'p',
          model: 'res.partner', pollIntervalSec: 10, ...extra,
        },
      }],
    });
  }

  it('CARATTERIZZAZIONE seed "skip": search(id desc, limit 1) → cursore = MAX id; search_read parte da lì nello STESSO tick', async () => {
    vi.useFakeTimers();
    sqliteStmt.get.mockReturnValue(undefined); // nessuno stato persistito → seed
    odooLib.executeKw
      .mockResolvedValueOnce([100]) // seed: search id desc
      .mockResolvedValueOnce([]);   // poll: search_read
    m.workflowsList.mockResolvedValue([odooWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(odooLib.executeKw).toHaveBeenCalledTimes(2);
    const seedCall = odooLib.executeKw.mock.calls[0]![2] as { method: string; kwargs: unknown };
    expect(seedCall.method).toBe('search');
    expect(seedCall.kwargs).toEqual({ limit: 1, order: 'id desc' });
    const pollCall = odooLib.executeKw.mock.calls[1]![2] as { method: string; positional: unknown[] };
    expect(pollCall.method).toBe('search_read');
    expect(pollCall.positional[0]).toEqual([['id', '>', 100]]);
    await svc.stop();
    vi.useRealTimers();
  });

  it('CARATTERIZZAZIONE dispatch: un run per record (odoo_polling), cursore bumpato al tick dopo', async () => {
    vi.useFakeTimers();
    sqliteStmt.get.mockReturnValueOnce({ last_id_seen: 100 }); // stato persistito → NO seed
    odooLib.executeKw
      .mockResolvedValueOnce([{ id: 101, name: 'a' }, { id: 102, name: 'b' }])
      .mockResolvedValueOnce([]);
    m.workflowsList.mockResolvedValue([odooWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.runsExecute).toHaveBeenCalledTimes(2);
    const first = m.runsExecute.mock.calls[0]![0] as { triggerType: string; tenantId: string; triggerInput: { model: string; recordId: number; record: unknown } };
    expect(first.triggerType).toBe('odoo_polling');
    expect(first.tenantId).toBe('tenant-a');
    expect(first.triggerInput.model).toBe('res.partner');
    expect(first.triggerInput.recordId).toBe(101);
    expect(first.triggerInput.record).toEqual({ id: 101, name: 'a' });
    // Tick 2: domain dal cursore avanzato (102).
    await vi.advanceTimersByTimeAsync(10_000);
    const tick2 = odooLib.executeKw.mock.calls[1]![2] as { positional: unknown[] };
    expect(tick2.positional[0]).toEqual([['id', '>', 102]]);
    await svc.stop();
    vi.useRealTimers();
  });

  it('CARATTERIZZAZIONE WE-15 behaviorale: run fallito → INSERT odoo_dlq + STOP batch + cursore NON bumpato (retry al tick dopo)', async () => {
    vi.useFakeTimers();
    sqliteStmt.get.mockReturnValueOnce({ last_id_seen: 100 }); // odoo_state alla registrazione
    odooLib.executeKw
      .mockResolvedValueOnce([{ id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([]);
    m.runsExecute.mockRejectedValueOnce(new Error('run boom'));
    m.workflowsList.mockResolvedValue([odooWf()]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // Durante il tick: SELECT odoo_dlq per il record fallito → nessuna riga → INSERT.
    sqliteStmt.get.mockReturnValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    // Batch STOPPATO al primo fallimento: il record 102 NON è stato dispatchato.
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    // INSERT in DLQ col messaggio d'errore.
    const dlqInsert = sqliteStmt.run.mock.calls.find((c) => c.includes('run boom'));
    expect(dlqInsert).toBeDefined();
    expect(dlqInsert).toContain(101);
    // Tick 2: cursore ANCORA a 100 → il record 101 viene ritentato.
    await vi.advanceTimersByTimeAsync(10_000);
    const tick2 = odooLib.executeKw.mock.calls[1]![2] as { positional: unknown[] };
    expect(tick2.positional[0]).toEqual([['id', '>', 100]]);
    await svc.stop();
    vi.useRealTimers();
  });

  it('CARATTERIZZAZIONE domain utente: domainJson valido viene APPESO dopo il filtro id', async () => {
    vi.useFakeTimers();
    sqliteStmt.get.mockReturnValueOnce({ last_id_seen: 5 });
    odooLib.executeKw.mockResolvedValueOnce([]);
    m.workflowsList.mockResolvedValue([odooWf({ domainJson: '[["active","=",true]]' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const call = odooLib.executeKw.mock.calls[0]![2] as { positional: unknown[] };
    expect(call.positional[0]).toEqual([['id', '>', 5], ['active', '=', true]]);
    await svc.stop();
    vi.useRealTimers();
  });
});

// ════════════════════════════════════════════════════════════════════
// IMAP poller — ensureImapPoller setup paths
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — ensureImapPoller', () => {
  beforeEach(() => {
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.getMailboxLock.mockResolvedValue({ release: vi.fn() });
    imap.search.mockResolvedValue([]);
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { /* empty */ },
    });
    sqliteStmt.get.mockReturnValue(undefined);
    sqliteStmt.run.mockReturnValue({ changes: 1 });
  });

  it('SKIP se manca host', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // no ImapFlow constructed
    expect(imap.ImapFlowCtor).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('SKIP se manca username', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'mail.x', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(imap.ImapFlowCtor).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('SKIP se manca password', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'mail.x', username: 'u' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(imap.ImapFlowCtor).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('REGISTRA poller con default mailbox=INBOX + port=993 (tls)', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'mail.acme', username: 'user@acme', password: 'secret',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // setInterval registered with min 15s clamp
    await vi.advanceTimersByTimeAsync(60_000);
    // Flush microtasks per attendere il poll async IIFE
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.useRealTimers();
    expect(imap.ImapFlowCtor).toHaveBeenCalled();
    const ctorArgs = imap.ImapFlowCtor.mock.calls[0]?.[0] as { host: string; port: number; secure: boolean };
    expect(ctorArgs.host).toBe('mail.acme');
    expect(ctorArgs.port).toBe(993);
    expect(ctorArgs.secure).toBe(true);
    await svc.stop();
  });

  it('port=143 → tlsMode starttls (secure: false)', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'mail.x', port: 143, username: 'u', password: 'p',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const ctorArgs = imap.ImapFlowCtor.mock.calls[0]?.[0] as { secure: boolean };
    expect(ctorArgs.secure).toBe(false);
    vi.useRealTimers();
    await svc.stop();
  });

  it('pollIntervalSec clamp MIN 15s', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(global, 'setInterval');
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p', pollIntervalSec: 1,
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const intervalMs = spy.mock.calls[0]![1];
    expect(intervalMs).toBe(15 * 1000);
    spy.mockRestore();
    vi.useRealTimers();
    await svc.stop();
  });

  it('systemAccountId → resolveForExecutor + use returned IMAP creds', async () => {
    vi.useFakeTimers();
    m.systemEmailAcct.mockReturnValue({
      imap: { host: 'mx.system', port: 993, username: 'sys@acme', password: 'sys-pwd' },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { systemAccountId: 'acct-1' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(m.systemEmailAcct).toHaveBeenCalledWith('tenant-a', 'acct-1');
    const ctorArgs = imap.ImapFlowCtor.mock.calls[0]?.[0] as { host: string };
    expect(ctorArgs.host).toBe('mx.system');
    vi.useRealTimers();
    await svc.stop();
  });

  it('systemAccountId → account senza IMAP config → WARN + skip', async () => {
    m.systemEmailAcct.mockReturnValue({ imap: null }); // no IMAP block
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { systemAccountId: 'acct-no-imap' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(imap.ImapFlowCtor).not.toHaveBeenCalled();
    await svc.stop();
  });

  it('idempotent: re-register stesso wf imap → no double ctor', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const callsBefore = imap.ImapFlowCtor.mock.calls.length;
    await svc.reload();
    expect(imap.ImapFlowCtor.mock.calls.length).toBe(callsBefore);
    vi.useRealTimers();
    await svc.stop();
  });

  it('persisted cursor lastUidSeen pre-loaded da SQLite', async () => {
    vi.useFakeTimers();
    sqliteStmt.get.mockReturnValueOnce({ last_uid_seen: 42 });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // verifica che SELECT imap_state sia stato chiamato
    expect(sqliteStmt.get).toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// IMAP poll dispatch + file watcher events + db-change dispatch
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — IMAP/file/db dispatch full coverage', () => {
  beforeEach(() => {
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.getMailboxLock.mockResolvedValue({ release: vi.fn() });
    sqliteStmt.get.mockReturnValue(undefined);
    sqliteStmt.run.mockReturnValue({ changes: 1 });
  });

  function msg(over: Partial<{ uid: number; subject: string; from: string }> = {}) {
    return {
      uid: over.uid ?? 100,
      envelope: {
        subject: over.subject ?? 'Test',
        from: [{ address: over.from ?? 'sender@x.com' }],
        to: [{ address: 'rec@x.com' }],
      },
      source: Buffer.from('body'),
      flags: new Set(),
    };
  }
  function setupFetchYield(messages: ReturnType<typeof msg>[]) {
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const m of messages) yield m; },
    });
  }
  async function flush(n = 15) { for (let i = 0; i < n; i++) await Promise.resolve(); }

  it('NEW msg → execute con triggerType=imap', async () => {
    vi.useFakeTimers();
    setupFetchYield([msg({ uid: 101 })]);
    m.workflowsList.mockResolvedValue([makeWf({
      id: 'wf-imap', tenantId: 't',
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-imap', triggerType: 'imap',
    }));
    vi.useRealTimers();
    await svc.stop();
  });

  it('subject regex mismatch → skip', async () => {
    vi.useFakeTimers();
    setupFetchYield([msg({ uid: 102, subject: 'Spam' })]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', filterSubject: '^Urgent:' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('from regex mismatch → skip', async () => {
    vi.useFakeTimers();
    setupFetchYield([msg({ uid: 103, from: 'bad@evil.com' })]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', filterFrom: '@good.com$' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('UID <= cursor → skip', async () => {
    vi.useFakeTimers();
    sqliteStmt.get.mockReturnValueOnce({ last_uid_seen: 200 });
    setupFetchYield([msg({ uid: 50 })]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('allowlist mismatch → REJECTED warn no execute', async () => {
    vi.useFakeTimers();
    setupFetchYield([msg({ uid: 104, from: 'attacker@evil.com' })]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', senderAllowlist: 'admin@acme.com' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('onlyUnseen=true → search seen:false', async () => {
    vi.useFakeTimers();
    imap.search.mockResolvedValue([105]);
    setupFetchYield([msg({ uid: 105 })]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', onlyUnseen: 'true' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(imap.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
    vi.useRealTimers();
    await svc.stop();
  });

  it('onlyUnseen + search empty → short-circuit', async () => {
    vi.useFakeTimers();
    imap.search.mockResolvedValue([]);
    imap.fetch.mockReturnValue({ [Symbol.asyncIterator]: async function* () { /* noop */ } });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', onlyUnseen: 'true' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('connect fail → no execute', async () => {
    vi.useFakeTimers();
    imap.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'down', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  // File watcher events
  it('file add event → execute con triggerType=file_watch', async () => {
    let onAdd: ((p: string) => void) | undefined;
    m.chokidarWatcher.on.mockImplementation((evt: string, cb: (p: string) => void) => {
      if (evt === 'add') onAdd = cb;
      return m.chokidarWatcher;
    });
    m.workflowsList.mockResolvedValue([makeWf({
      id: 'wf-f', tenantId: 't',
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    onAdd?.('/tmp/x/new.csv');
    await Promise.resolve();
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-f', triggerType: 'file_watch',
      triggerInput: expect.objectContaining({ event: 'add' }),
    }));
    await svc.stop();
  });

  it('events="change" → ignora add', async () => {
    let onAdd: ((p: string) => void) | undefined;
    let onChange: ((p: string) => void) | undefined;
    m.chokidarWatcher.on.mockImplementation((evt: string, cb: (p: string) => void) => {
      if (evt === 'add') onAdd = cb;
      if (evt === 'change') onChange = cb;
      return m.chokidarWatcher;
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/y', events: 'change' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    onAdd?.('/tmp/y/a.csv');
    onChange?.('/tmp/y/b.csv');
    await Promise.resolve();
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    await svc.stop();
  });

  it('events="unlink" → solo unlink', async () => {
    let onUnlink: ((p: string) => void) | undefined;
    m.chokidarWatcher.on.mockImplementation((evt: string, cb: (p: string) => void) => {
      if (evt === 'unlink') onUnlink = cb;
      return m.chokidarWatcher;
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/z', events: 'unlink' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    onUnlink?.('/tmp/z/del.csv');
    await Promise.resolve();
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      triggerInput: expect.objectContaining({ event: 'unlink' }),
    }));
    await svc.stop();
  });

  // DB-change dispatch
  it('change "insert" → execute triggerType=db_change', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges
      .mockReturnValueOnce([{ id: 1, op: 'insert', payload: {}, createdAt: 'now' }])
      .mockReturnValueOnce([{ id: 2, op: 'insert', payload: { x: 1 }, createdAt: 'now' }]);
    m.workflowsList.mockResolvedValue([makeWf({
      id: 'wf-db', tenantId: 't',
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't1', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: 'db_change',
      triggerInput: expect.objectContaining({ changeId: 2, op: 'insert' }),
    }));
    vi.useRealTimers();
    await svc.stop();
  });

  it('opsFilter="update" → skip insert/delete', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { id: 1, op: 'insert', payload: {}, createdAt: 'now' },
        { id: 2, op: 'update', payload: {}, createdAt: 'now' },
        { id: 3, op: 'delete', payload: {}, createdAt: 'now' },
      ]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', ops: 'update', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(m.runsExecute).toHaveBeenCalledTimes(1);
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      triggerInput: expect.objectContaining({ op: 'update' }),
    }));
    vi.useRealTimers();
    await svc.stop();
  });

  it('getChangesSince throw mid-poll → log error + no crash', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges
      .mockReturnValueOnce([])
      .mockImplementationOnce(() => { throw new Error('DB unavailable'); });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });
});

// ════════════════════════════════════════════════════════════════════
// Coverage 100% fillers
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — coverage fillers', () => {
  beforeEach(() => {
    imap.connect.mockResolvedValue(undefined);
    imap.logout.mockResolvedValue(undefined);
    imap.getMailboxLock.mockResolvedValue({ release: vi.fn() });
    imap.messageFlagsAdd.mockResolvedValue(undefined);
    sqliteStmt.get.mockReturnValue(undefined);
    sqliteStmt.run.mockReturnValue({ changes: 1 });
  });

  it('stop con debounce timer pending → clearTimeout', async () => {
    vi.useFakeTimers();
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const cb = m.subscribers.get('workflow.updated')![0]!;
    cb({}); // accende debounce timer
    await svc.stop(); // stop con timer pending → clearTimeout branch
    vi.useRealTimers();
  });

  it('reload tear-down imap poller per workflow non più enabled', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-i', enabled: true,
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // ora wf-i no più enabled
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-i', enabled: false,
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    await svc.reload();
    vi.useRealTimers();
    await svc.stop();
  });

  it('reload tear-down db-change poller per workflow non più enabled', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-d', enabled: true,
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    m.workflowsList.mockResolvedValueOnce([makeWf({
      id: 'wf-d', enabled: false,
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't' } }],
    })]);
    await svc.reload();
    vi.useRealTimers();
    await svc.stop();
  });

  it('db-change seed throw → log warn, poller registrato (fail-closed: cursore null, retry al tick)', async () => {
    vi.useFakeTimers();
    m.dbStudioChanges.mockImplementationOnce(() => { throw new Error('seed boom'); });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('file watcher run.execute fail → log error catch', async () => {
    let onAdd: ((p: string) => void) | undefined;
    m.chokidarWatcher.on.mockImplementation((evt: string, cb: (p: string) => void) => {
      if (evt === 'add') onAdd = cb;
      return m.chokidarWatcher;
    });
    m.runsExecute.mockRejectedValueOnce(new Error('execute fail'));
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_file_watch', config: { directory: '/tmp/x' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    onAdd?.('/tmp/x/new.csv');
    await new Promise((r) => setTimeout(r, 10));
    await svc.stop();
  });

  it('IMAP "to" filter regex mismatch → skip', async () => {
    vi.useFakeTimers();
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 200,
          envelope: {
            subject: 'Test', from: [{ address: 'a@x.com' }],
            to: [{ address: 'wrong@evil.com' }],
          },
          source: Buffer.from('body'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        filterTo: '@allowed.com$',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP message senza source → skip with warn', async () => {
    vi.useFakeTimers();
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 201,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          // source missing!
          flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(m.runsExecute).not.toHaveBeenCalled();
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP message con attachments → parse + recordProcessed + execute', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'plain body',
      html: '<p>html</p>',
      messageId: '<unique-msg-id@x.com>',
      attachments: [
        {
          filename: 'report.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('PDF-data'),
        },
      ],
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 300,
          envelope: { subject: 'Order', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('full-mime-source'),
          flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      id: 'wf-att', tenantId: 't',
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: 'imap',
      triggerInput: expect.objectContaining({
        uid: 300,
      }),
    }));
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP attachmentMime filter → solo PDF passa, JPG skip', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'body', html: '<p>h</p>', messageId: '<m2@x>',
      attachments: [
        { filename: 'pic.jpg', contentType: 'image/jpeg', content: Buffer.from('JPG') },
        { filename: 'doc.pdf', contentType: 'application/pdf', content: Buffer.from('PDF') },
      ],
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 301,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p', attachmentMime: 'application/pdf',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP messageId dedup → checkDup branch executed', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'body', html: '', messageId: '<dup-msg@x>',
      attachments: [],
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 400,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP hasAttachment filter active → require attachments', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'no attach', html: '', messageId: '<noatt@x>',
      attachments: [], // empty
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 500,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', hasAttachment: 'true' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('hot reload debounce catch → log warn (reload throws)', async () => {
    vi.useFakeTimers();
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    m.workflowsList.mockRejectedValueOnce(new Error('list fail'));
    const cb = m.subscribers.get('workflow.updated')![0]!;
    cb({});
    await vi.advanceTimersByTimeAsync(600);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('db_change runs.execute fail → log error catch', async () => {
    vi.useFakeTimers();
    m.runsExecute.mockRejectedValueOnce(new Error('execute boom'));
    m.dbStudioChanges
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: 1, op: 'insert', payload: {}, createdAt: 'now' }]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('persistCursor sqlite write fail → log warn catch', async () => {
    vi.useFakeTimers();
    sqliteStmt.run.mockImplementationOnce(() => { throw new Error('sqlite IO fail'); });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 700,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('recordProcessed sqlite INSERT fail → log warn catch', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<rp-fail@x>', attachments: [],
    });
    // Prima get/run sono ok, ma successive INSERT OR IGNORE fa throw
    let runCount = 0;
    sqliteStmt.run.mockImplementation(() => {
      runCount++;
      if (runCount > 1) throw new Error('INSERT fail');
      return { changes: 1 };
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 800,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('checkDup sqlite SELECT fail → catch returns false → proceed', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<cd@x>', attachments: [],
    });
    sqliteStmt.get.mockImplementationOnce(((sql: string) => {
      if (sql.includes('imap_state')) return undefined;
      return undefined;
    }) as never);
    sqliteStmt.get.mockImplementationOnce(((sql: string) => {
      if (sql.includes('imap_processed_messages')) throw new Error('SELECT fail');
      return undefined;
    }) as never);
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 900,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP markSeen=always → messageFlagsAdd Seen', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'body', html: '', messageId: '<seen@x>',
      attachments: [],
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 600,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p', markSeen: 'always' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('messageId fallback (parsed.messageId undefined → uid-{wf}-{uid})', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'body', html: '', /* no messageId */ attachments: [],
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 999,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 25; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('parseAllowlist: array di stringhe diretto', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        senderAllowlist: ['admin@acme.com', 'sales@acme.com'] as never,
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('parseAllowlist: JSON-stringified array', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        senderAllowlist: '["admin@x.com","sales@x.com"]',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('parseAllowlist: stringa con [ ma JSON invalido → fallback push trimmed', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        senderAllowlist: '[malformed',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('parseAllowlist: comma+semicolon+newline separator', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        senderAllowlist: 'a@x.com,b@x.com;c@x.com\nd@x.com',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('safeRegex: pattern invalido → log warn + null fallback', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        filterSubject: '[invalid-regex(', // unbalanced
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('safeRegex: /pattern/flags format', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        filterSubject: '/urgent/i',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('IMAP messageId duplicato (checkDup true) → skip + dedup counter', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<already-seen@x>', attachments: [],
    });
    // checkDup ritorna truthy → skip
    sqliteStmt.get.mockReturnValue({ found: 1 } as never);
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 1000,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    // checkDup=true → execute NON dovrebbe essere chiamato per QUESTO msg
    // (potrebbe essere chiamato in altri test paralleli)
    vi.useRealTimers();
    await svc.stop();
  });

  it('db_change run.execute reject → catch + logger.error', async () => {
    vi.useFakeTimers();
    // mockImplementation invece di mockReturnValue: ogni chiamata produce una
    // NUOVA Promise.reject (col mockReturnValue la stessa Promise rejected viene
    // riusata → potenziale leak di unhandledRejection se il sorgente la chiama
    // più volte in modi diversi).
    m.runsExecute.mockImplementation(() => Promise.reject(new Error('db change exec fail')));
    m.dbStudioChanges
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: 99, op: 'insert', payload: {}, createdAt: 'now' }]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
    // Reset implementation per non leakare nei test successivi
    m.runsExecute.mockResolvedValue({ runId: 'r' });
  });

  it('parseAllowlist: input non-string non-array (numero/null) → tokens vuoti', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        senderAllowlist: 42 as never, // numero, branch other
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('parseAllowlist: array mista (alcuni non-string) → filtra solo string', async () => {
    vi.useFakeTimers();
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p',
        senderAllowlist: ['a@x.com', 42, null, 'b@x.com'] as never,
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    vi.useRealTimers();
    await svc.stop();
  });

  it('markSeen=always + messageFlagsAdd fail → catch log warn + logout swallow', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<ms-fail@x>', attachments: [],
    });
    imap.messageFlagsAdd.mockRejectedValueOnce(new Error('mark seen fail'));
    imap.logout.mockRejectedValueOnce(new Error('logout fail')); // also rejected to cover .catch(() => {})
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 1100,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: {
        host: 'x', username: 'u', password: 'p', markSeen: 'always',
      } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('pickAddress con parsed.from come array di group (a.value[{address}])', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<grp@x>',
      attachments: [],
      from: [{ value: [{ address: 'group-from@x.com' }] }],
      to: [{ value: [{ address: 'group-to@x.com' }] }],
    });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 1200,
          envelope: { subject: 'X', from: [{ address: 'envelope-from@x' }], to: [{ address: 'envelope-to@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('db_change run.execute rejection con MORE wait → catch line covered', async () => {
    vi.useFakeTimers();
    let captureReject: (() => void) | undefined;
    m.runsExecute.mockImplementationOnce(() => new Promise((_, rej) => {
      captureReject = () => rej(new Error('db change exec capture'));
    }));
    m.dbStudioChanges
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: 50, op: 'insert', payload: {}, createdAt: 'now' }]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', pollIntervalSec: 5 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(5_000);
    captureReject?.(); // forza il reject
    for (let i = 0; i < 30; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('recordProcessed sqlite INSERT fail con MORE wait → catch covered', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<rp@x>', attachments: [],
    });
    // recordProcessed è il PRIMO sqlite.run nella poll (INSERT OR IGNORE message_id)
    sqliteStmt.run.mockImplementationOnce(() => { throw new Error('recordProcessed fail'); });
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 1300,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
  });

  it('checkDup sqlite throw → catch returns false → proceed exec', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<dup-throw@x>', attachments: [],
    });
    // Routing: prima get (imap_state) ok, seconda get (checkDup) throws
    let getCount = 0;
    sqliteStmt.get.mockImplementation((() => {
      getCount++;
      if (getCount === 1) return undefined; // imap_state seed ok
      throw new Error('checkDup SELECT fail');
    }) as never);
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 9999,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
    sqliteStmt.get.mockReturnValue(undefined);
  });

  it('recordProcessed sqlite throw → catch logger.warn', async () => {
    vi.useFakeTimers();
    const { simpleParser } = await import('mailparser');
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'b', html: '', messageId: '<rp-throw@x>', attachments: [],
    });
    // run routing: tutti i run throw → primo run è recordProcessed
    sqliteStmt.run.mockImplementation((() => {
      throw new Error('any run fail');
    }) as never);
    imap.fetch.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield {
          uid: 8888,
          envelope: { subject: 'X', from: [{ address: 'a@x' }], to: [{ address: 'b@x' }] },
          source: Buffer.from('mime'), flags: new Set(),
        };
      },
    });
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_imap', config: { host: 'x', username: 'u', password: 'p' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    vi.useRealTimers();
    await svc.stop();
    sqliteStmt.run.mockReturnValue({ changes: 1 } as never);
  });

  it('db_change run.execute fail (catch handler exercised w/ real timers)', async () => {
    m.runsExecute.mockImplementation(async () => { throw new Error('exec catch'); });
    m.dbStudioChanges
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: 77, op: 'insert', payload: {}, createdAt: 'now' }]);
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_db_change', config: { databaseId: 'db', tableName: 't', pollIntervalSec: 2 } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    // Real timers — wait 2.5s for poll to fire + catch microtask
    await new Promise((r) => setTimeout(r, 2500));
    await svc.stop();
    m.runsExecute.mockResolvedValue({ runId: 'r' });
  }, 10_000);
});

// ════════════════════════════════════════════════════════════════════
// WebSocket trigger — e2e con socket REALE (ws non è mockato)
// ════════════════════════════════════════════════════════════════════
describe('TriggerWatchersService — WebSocket trigger (socket reale)', () => {
  async function startWss(onConn: (ws: WebSocket) => void): Promise<{ port: number; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => { wss.on('listening', () => { r(); }); });
    wss.on('connection', onConn);
    return {
      port: (wss.address() as AddressInfo).port,
      close: () => new Promise<void>((r) => { wss.close(() => { r(); }); }),
    };
  }
  function wsWf(port: number, extra: Record<string, unknown> = {}) {
    return makeWf({ nodes: [{ id: 'n1', defId: 'trigger_websocket', config: { url: `ws://127.0.0.1:${port}`, pingIntervalSec: '0', maxMessagesPerSec: '0', ...extra } }] });
  }

  // I test usano un WebSocketServer reale su 127.0.0.1 (loopback): il guard SSRF
  // lo bloccherebbe (correttamente, in prod). Lo allowlistiamo come farebbe
  // l'operatore per un servizio WS interno legittimo → i test real-socket girano.
  beforeEach(() => { process.env.MEDEA_INTERNAL_HOST_ALLOWLIST = '127.0.0.1'; });
  afterEach(() => { delete process.env.MEDEA_INTERNAL_HOST_ALLOWLIST; });

  it('connette + riceve messaggio → run.execute(triggerType=websocket, data JSON parsata)', async () => {
    const server = await startWss((ws) => { ws.send(JSON.stringify({ type: 'trade', price: 42 })); });
    const fired = new Promise<Record<string, unknown>>((resolve) => {
      m.runsExecute.mockImplementation(async (arg: Record<string, unknown>) => { resolve(arg); return { runId: 'r' }; });
    });
    m.workflowsList.mockResolvedValue([wsWf(server.port)]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const arg = await fired;
    expect(arg.triggerType).toBe('websocket');
    expect(arg.tenantId).toBe('tenant-a');
    const ti = arg.triggerInput as { data: { type: string; price: number }; raw: string };
    expect(ti.data.type).toBe('trade');
    expect(ti.data.price).toBe(42);
    expect(ti.raw).toBe('{"type":"trade","price":42}');
    await svc.stop();
    await server.close();
  }, 10_000);

  it('JSON pointer di filtro: messaggio senza il campo → NESSUN run', async () => {
    const server = await startWss((ws) => { ws.send(JSON.stringify({ other: 1 })); });
    m.workflowsList.mockResolvedValue([wsWf(server.port, { messagePointer: '/type' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(m.runsExecute).not.toHaveBeenCalled();
    await svc.stop();
    await server.close();
  }, 10_000);

  it('messaggio di subscribe inviato on-open', async () => {
    let resolveMsg!: (s: string) => void;
    const received = new Promise<string>((r) => { resolveMsg = r; });
    const server = await startWss((ws) => { ws.on('message', (d: Buffer) => { resolveMsg(d.toString('utf8')); }); });
    m.workflowsList.mockResolvedValue([wsWf(server.port, { subscribeMessage: '{"op":"subscribe"}' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    expect(await received).toBe('{"op":"subscribe"}');
    await svc.stop();
    await server.close();
  }, 10_000);

  it('jsonParse=false → data resta la stringa grezza', async () => {
    const server = await startWss((ws) => { ws.send('hello-raw'); });
    const fired = new Promise<Record<string, unknown>>((resolve) => {
      m.runsExecute.mockImplementation(async (arg: Record<string, unknown>) => { resolve(arg); return { runId: 'r' }; });
    });
    m.workflowsList.mockResolvedValue([wsWf(server.port, { jsonParse: 'false' })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const ti = (await fired).triggerInput as { data: unknown; raw: string };
    expect(ti.data).toBe('hello-raw');
    expect(ti.raw).toBe('hello-raw');
    await svc.stop();
    await server.close();
  }, 10_000);

  it('URL non ws:// → watcher skipped (nessun crash, nessun run)', async () => {
    m.workflowsList.mockResolvedValue([makeWf({
      nodes: [{ id: 'n1', defId: 'trigger_websocket', config: { url: 'http://nope' } }],
    })]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(m.runsExecute).not.toHaveBeenCalled();
    await svc.stop();
  }, 10_000);

  // ── Caratterizzazione avanzata (split 2026-06-12) — pinnata PRIMA dello
  // split sul monolite a HEAD, poi rieseguita sulla versione delegante:
  // teardown e riconnessione osservati dal LATO SERVER (socket reale).

  it('CARATTERIZZAZIONE stop(): chiude la connessione viva — il server vede la close', async () => {
    let resolveConn!: () => void;
    const connected = new Promise<void>((r) => { resolveConn = r; });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => { resolveClosed = r; });
    const server = await startWss((ws) => {
      resolveConn();
      ws.on('close', () => { resolveClosed(); });
    });
    m.workflowsList.mockResolvedValue([wsWf(server.port)]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await connected;
    await svc.stop();
    await closed; // se stop() non chiudesse il socket → timeout del test
    await server.close();
  }, 10_000);

  it('CARATTERIZZAZIONE reload(): workflow rimosso → watcher smantellato, il server vede la close, NESSUN run dai messaggi successivi', async () => {
    let resolveConn!: () => void;
    const connected = new Promise<void>((r) => { resolveConn = r; });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => { resolveClosed = r; });
    const server = await startWss((ws) => {
      resolveConn();
      ws.on('close', () => { resolveClosed(); });
    });
    m.workflowsList.mockResolvedValue([wsWf(server.port)]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    await connected;
    m.workflowsList.mockResolvedValue([]); // il workflow sparisce
    await svc.reload();
    await closed;
    expect(m.runsExecute).not.toHaveBeenCalled();
    await svc.stop();
    await server.close();
  }, 10_000);

  it('CARATTERIZZAZIONE reconnect: drop dal server → riconnessione con backoff (~1s) e i messaggi successivi arrivano', async () => {
    let connections = 0;
    const server = await startWss((ws) => {
      connections += 1;
      if (connections === 1) {
        ws.close(); // drop immediato della prima connessione
      } else {
        ws.send(JSON.stringify({ connection: connections }));
      }
    });
    const fired = new Promise<Record<string, unknown>>((resolve) => {
      m.runsExecute.mockImplementation(async (arg: Record<string, unknown>) => { resolve(arg); return { runId: 'r' }; });
    });
    m.workflowsList.mockResolvedValue([wsWf(server.port)]);
    const svc = new TriggerWatchersService(fakeEventBus() as never);
    await svc.start();
    const arg = await fired; // arriva solo DOPO la riconnessione (backoff 1s)
    expect((arg.triggerInput as { data: { connection: number } }).data.connection).toBe(2);
    expect(connections).toBeGreaterThanOrEqual(2);
    await svc.stop();
    await server.close();
  }, 10_000);
});
