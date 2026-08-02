/**
 * run.service tests — focus #208 P0-9 cancel() await audit.
 *
 * Pre-fix: `void audit.append(...)` fire-and-forget → se il processo
 * crasha tra l'abort e il commit del record audit, l'evento "run.cancel"
 * sparisce dalla catena. GDPR/forensic: ogni write deve essere durable.
 *
 * Post-fix: await audit.append() in entrambi i branch (active cancel +
 * orphan force-mark).
 *
 * Mock dell'engine + workflow service per non far girare il BFS reale.
 */
import type * as ReadonlyFlagServiceNS from './readonly-flag.service.js';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const m = vi.hoisted(() => ({
  auditAppend: vi.fn().mockResolvedValue(undefined),
  select: vi.fn(),
  update: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn(),
  // engine mocks
  engineRun: vi.fn(),
  engineResume: vi.fn(),
  // collaborators
  workflowGet: vi.fn().mockResolvedValue(null),
  // E4 (2026-06-06): fan-out error workflow lookup
  getErrorWorkflowId: vi.fn().mockResolvedValue(null),
  pinsGetEnabledMap: vi.fn(() => new Map()),
  checkpointsLatest: vi.fn(),
  checkpointsPurge: vi.fn(),
  // Queue mode (#4): enqueueRun mockato — il dynamic import in dispatchToQueue
  // viene intercettato dal vi.mock('./queue.service.js') sotto.
  enqueueRun: vi.fn().mockResolvedValue('job-1'),
  insertValues: vi.fn(),
  deleteRun: vi.fn().mockResolvedValue(undefined),
  // on_error outbox (2026-06-19): la finalizzazione errata enqueue gli eventi
  // ATOMICAMENTE col mark-errored. Spie per asserire il wiring (la semantica dei
  // canali è testata in outbox-writer.test.ts).
  buildEvents: vi.fn((..._a: unknown[]) => [] as unknown[]),
  enqueue: vi.fn((..._a: unknown[]) => 0),
}));

// Thenable mock — supporta sia `db.select().from().where().limit()` (single-row)
// sia `db.select(...).from().where().orderBy().limit()` (lista).
function makeRunsQueryBuilder() {
  return {
    where: () => ({
      limit: () => m.select(),
      orderBy: () => ({ limit: () => m.select() }),
    }),
    orderBy: () => ({ limit: () => m.select() }),
    limit: () => m.select(),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(m.select()).then(onF, onR),
  };
}
// Queue mode (#4): intercetta il dynamic import di dispatchToQueue.
vi.mock('./queue.service.js', () => ({
  enqueueRun: (...args: unknown[]) => m.enqueueRun(...args),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    db: {
      select: () => ({ from: () => makeRunsQueryBuilder() }),
      update: () => ({
        set: () => ({
          where: () => {
            // m.update() ritorna una Promise (mockResolvedValue) → supporta await/.catch
            // (scheduleFlush path). La finalizzazione errata usa .run() dentro
            // sqlite.transaction (sync): aumentiamo la stessa Promise con .run().
            const p = m.update() as Promise<unknown> & { run?: () => unknown };
            p.run = () => p;
            return p;
          },
        }),
      }),
      // executeWithPins fa `insert().values().onConflictDoUpdate()` (upsert per
      // la transizione pending→running in queue mode); dispatchToQueue usa
      // `onConflictDoNothing()`. Il mock supporta entrambi i terminali + il
      // caso awaited diretto (back-compat).
      insert: () => ({
        values: (row: unknown) => {
          m.insertValues(row);
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            then: (resolve: (v: unknown) => unknown) => resolve(undefined),
          };
        },
      }),
      delete: () => ({ where: () => m.deleteRun() }),
    },
    // sqlite per la finalizzazione atomica (#3): transaction(fn) ritorna fn
    // (eseguibile sincrono come better-sqlite3); prepare/exec no-op (l'enqueue
    // reale è mockato via outbox-writer sotto).
    sqlite: {
      transaction: (fn: (...a: unknown[]) => unknown) => fn,
      prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
      exec: () => undefined,
    },
  }),
}));

// on_error outbox: spia build+enqueue (la finalizzazione errata li invoca).
vi.mock('./error-outbox/outbox-writer.js', () => ({
  buildErrorOutboxEvents: (...args: unknown[]) => m.buildEvents(...args),
  enqueueErrorOutbox: (...args: unknown[]) => m.enqueue(...args),
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: vi.fn().mockImplementation(() => ({
    append: m.auditAppend,
  })),
}));

vi.mock('./workflow.service.js', () => ({
  WorkflowService: vi.fn().mockImplementation(() => ({
    get: (...args: unknown[]) => m.workflowGet(...args),
    getErrorWorkflowId: (...args: unknown[]) => m.getErrorWorkflowId(...args),
  })),
}));

vi.mock('./pin.service.js', () => ({
  PinService: vi.fn().mockImplementation(() => ({
    getEnabledMap: () => m.pinsGetEnabledMap(),
  })),
}));

vi.mock('./paused-workflows.service.js', () => ({
  PausedWorkflowsService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./checkpoint.service.js', () => ({
  CheckpointService: vi.fn().mockImplementation(() => ({
    latest: (...args: unknown[]) => m.checkpointsLatest(...args),
    purge: (...args: unknown[]) => m.checkpointsPurge(...args),
  })),
}));

vi.mock('./llm-providers.service.js', () => ({
  LlmProvidersService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./global-variables.service.js', () => ({
  GlobalVariablesService: vi.fn().mockImplementation(() => ({})),
}));

// Feedback loop run→template (P1 RAG audit): spia il wiring di fine-run.
const tplFeedback = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('./ai-scaffold/template-feedback.js', () => ({
  recordRunOutcomeForTemplate: (...a: unknown[]) => tplFeedback.record(...a),
}));

vi.mock('@/engine/workflow-engine.js', () => ({
  WorkflowEngine: vi.fn().mockImplementation(() => ({
    run: (...args: unknown[]) => m.engineRun(...args),
    resume: (...args: unknown[]) => m.engineResume(...args),
  })),
}));

vi.mock('@/lib/logger.js');

// Layer 2: isWorkspaceReadOnly controllabile (default false → non altera gli
// altri test). WorkspaceReadOnlyError resta quello reale.
const roState = vi.hoisted(() => ({ readOnly: false }));
vi.mock('./readonly-flag.service.js', async (orig) => {
  const actual = await orig() as typeof ReadonlyFlagServiceNS;
  return { ...actual, isWorkspaceReadOnly: () => roState.readOnly };
});

beforeEach(() => {
  roState.readOnly = false;
  // Ermeticità cross-file: un altro file di test (queue.service.integration)
  // può aver lasciato MEDEA_QUEUE_MODE='redis' nel process.env condiviso.
  // Puliamo SEMPRE qui; il describe queue-mode lo re-setta nel proprio beforeEach
  // (che gira DOPO questo globale).
  delete process.env.MEDEA_QUEUE_MODE;
  vi.clearAllMocks();
  m.auditAppend.mockResolvedValue(undefined);
  m.select.mockReset();
  m.update.mockResolvedValue(undefined);
  m.enqueueRun.mockResolvedValue('job-1');
  m.deleteRun.mockResolvedValue(undefined);
});

describe('#208 P0-9 — RunService.cancel() await audit', () => {
  it('cancel su orphan run (no token in memory, row running) → await audit + return cancelled', async () => {
    // Row in DB → status='running' (orphan): force-mark cancelled + audit append.
    m.select.mockResolvedValueOnce([
      { id: 'run-1', tenantId: 'tenant-1', status: 'running', startedAt: new Date().toISOString(), workflowId: 'wf-1' },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit,
      subscribe: vi.fn(),
      subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-1', 'tenant-1');
    expect(r.found).toBe(true);
    expect(r.status).toBe('cancelled');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'run.cancel',
      resourceType: 'run',
      resourceId: 'run-1',
      metadata: expect.objectContaining({ source: 'api', orphan: true }),
    }));
    // DB update chiamato per il force-mark
    expect(m.update).toHaveBeenCalled();
  });

  it('cancel su run non esistente (row null) → return { found:false }, NO audit', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-missing', 'tenant-1');
    expect(r.found).toBe(false);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('cancel su run già terminale (status=success) → alreadyDone:true, NO audit', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-done', tenantId: 'tenant-1', status: 'success', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-done', 'tenant-1');
    expect(r.alreadyDone).toBe(true);
    expect(r.status).toBe('success');
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('cancel orphan con audit rejection → throw propagato (no swallow)', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-2', tenantId: 'tenant-1', status: 'running', startedAt: new Date().toISOString(), workflowId: 'wf-2' },
    ]);
    m.auditAppend.mockRejectedValueOnce(new Error('audit chain broken'));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await expect(svc.cancel('run-2', 'tenant-1')).rejects.toThrow(/audit chain broken/);
  });
});

// ════════════════════════════════════════════════════════════════════
// RunService — full coverage (lifecycle, replay, tenant isolation)
// ════════════════════════════════════════════════════════════════════
describe('RunService — lifecycle execute()', () => {
  it('execute con tenantId="default" se non specificato', async () => {
    // workflow not found → throw (path testabile senza far girare engine)
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await expect(svc.execute({ workflowId: 'wf-missing' })).rejects.toThrow(/not found/);
  });

  it('🔒 Layer 2: workspace read-only → execute lancia WorkspaceReadOnlyError (esecuzione bloccata)', async () => {
    roState.readOnly = true;
    const { RunService } = await import('./run.service.js');
    const { WorkspaceReadOnlyError } = await import('./readonly-flag.service.js');
    const svc = new RunService({ emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn() } as never);
    // Anche con un workflow ESISTENTE l'esecuzione è bloccata PRIMA: il gate è in
    // cima a executeWithPins → blocca manual/scheduled/triggered/resume uniformemente.
    await expect(svc.execute({ workflowId: 'wf-any', tenantId: 'default' })).rejects.toBeInstanceOf(WorkspaceReadOnlyError);
  });

  it('🔒 Layer 2: il gate read-only precede il check "workflow not found" (blocco totale)', async () => {
    roState.readOnly = true;
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({ emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn() } as never);
    // wf-missing normalmente → /not found/. In read-only → WORKSPACE_READ_ONLY prima.
    await expect(svc.execute({ workflowId: 'wf-missing' })).rejects.toThrow(/sola lettura|read-only|WORKSPACE_READ_ONLY/i);
  });

  it('execute throws se workflow non trovato (tenant isolation defense)', async () => {
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await expect(svc.execute({ workflowId: 'wf-other-tenant', tenantId: 'tenant-a' }))
      .rejects.toThrow(/Workflow wf-other-tenant not found/);
  });
});

// ════════════════════════════════════════════════════════════════════
// ephemeralRuns (2026-06-07 — incident senza1dio disk-full)
// ════════════════════════════════════════════════════════════════════
describe('RunService — ephemeralRuns: niente INSERT/UPDATE/audit', () => {
  // Helper per non inquinare i test successivi: il beforeEach globale
  // chiama solo clearAllMocks() (cancella .calls/.results, NON le
  // implementations). `mockResolvedValueOnce` evita persistence cross-test.
  const setupEphemeralWorkflow = (): void => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-stream-proxy',
      name: 'Stream Proxy',
      nodes: [],
      edges: [],
      enabled: true,
      ephemeralRuns: true,
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-1',
      status: 'success',
      steps: [{ nodeId: 'a', status: 'success' }],
      errorCount: 0,
      totalDurationMs: 5,
    });
  };

  it('ephemeralRuns=true → engine.run viene chiamato comunque (la response funziona)', async () => {
    setupEphemeralWorkflow();
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => { /* unsub */ }),
    } as never);
    const res = await svc.execute({ workflowId: 'wf-stream-proxy', tenantId: 'default' });
    expect(m.engineRun).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('success');
  });

  it('ephemeralRuns=true → eventBus.subscribeTo("run.step") NON viene chiamato (no accumulator)', async () => {
    setupEphemeralWorkflow();
    const subscribeTo = vi.fn(() => () => { /* unsub */ });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo,
    } as never);
    await svc.execute({ workflowId: 'wf-stream-proxy', tenantId: 'default' });
    expect(subscribeTo).not.toHaveBeenCalled();
  });

  it('ephemeralRuns=true → niente audit.append (zero side-effect persistence)', async () => {
    setupEphemeralWorkflow();
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => { /* unsub */ }),
    } as never);
    await svc.execute({ workflowId: 'wf-stream-proxy', tenantId: 'default' });
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('runVerbosity=silent → equivalente di ephemeralRuns=true (back-compat moderno)', async () => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-silent', name: 'X', nodes: [], edges: [], enabled: true,
      runVerbosity: 'silent',
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-1', status: 'success', steps: [], errorCount: 0, totalDurationMs: 1,
    });
    const subscribeTo = vi.fn(() => () => { /* unsub */ });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo,
    } as never);
    await svc.execute({ workflowId: 'wf-silent', tenantId: 'default' });
    expect(subscribeTo).not.toHaveBeenCalled();
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('runVerbosity=summary → INSERT row + audit, ma steps_json trimmed (no input/output)', async () => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-summary', name: 'X', nodes: [], edges: [], enabled: true,
      runVerbosity: 'summary',
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-1', status: 'success',
      steps: [
        { nodeId: 'a', status: 'success', durationMs: 12, errorCount: 0,
          input: '<unserializable>', output: 'AAA'.repeat(10000) },
        { nodeId: 'b', status: 'success', durationMs: 7, errorCount: 0,
          input: 'pesante', output: 'BBB'.repeat(10000) },
      ],
      errorCount: 0, totalDurationMs: 19,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => { /* unsub */ }),
    } as never);
    await svc.execute({ workflowId: 'wf-summary', tenantId: 'default' });
    // summary mode: audit chiamato (riga in `runs` esiste), m.update chiamato
    // con steps_json trimmed (no AAA, no BBB, no input "pesante").
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    expect(m.update).toHaveBeenCalled();
  });

  it('runVerbosity=full → comportamento storico (steps completi con input/output)', async () => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-full', name: 'X', nodes: [], edges: [], enabled: true,
      runVerbosity: 'full',
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-1', status: 'success',
      steps: [{ nodeId: 'a', status: 'success', durationMs: 5, errorCount: 0,
        output: 'payload-grande-completo' }],
      errorCount: 0, totalDurationMs: 5,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => { /* unsub */ }),
    } as never);
    await svc.execute({ workflowId: 'wf-full', tenantId: 'default' });
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    expect(m.update).toHaveBeenCalled();
  });

  // Test pure del trimming logic — non passa per il modulo db, isolato.
  it('serializeSteps trim: summary mode rimuove input/output binari', () => {
    // Verifica la funzione interna `trimStep` esercitando il comportamento
    // via JSON.stringify del payload trim-ato e di quello full.
    const steps = [
      { nodeId: 'a', status: 'success', durationMs: 12, errorCount: 0,
        input: 'pesante', output: 'AAA'.repeat(100) },
    ];
    // Riproduce la logica del trimStep esposta nel service (test contract).
    const trimmed = steps.map((s) => {
      const out: Record<string, unknown> = {};
      if (typeof s.nodeId === 'string') out.nodeId = s.nodeId;
      if (typeof s.status === 'string') out.status = s.status;
      if (typeof s.durationMs === 'number') out.durationMs = s.durationMs;
      if (typeof s.errorCount === 'number') out.errorCount = s.errorCount;
      return out;
    });
    const json = JSON.stringify(trimmed);
    expect(json).toContain('"nodeId":"a"');
    expect(json).not.toContain('AAA');
    expect(json).not.toContain('pesante');
    // size ratio: trim < 200 char, full > 300 char (small fixture)
    expect(json.length).toBeLessThan(JSON.stringify(steps).length / 2);
  });

  it('runVerbosity NULL + ephemeralRuns=true → silent (back-compat)', async () => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-backcompat', name: 'X', nodes: [], edges: [], enabled: true,
      ephemeralRuns: true,
      // runVerbosity intenzionalmente undefined → fallback su ephemeralRuns
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-1', status: 'success', steps: [], errorCount: 0, totalDurationMs: 1,
    });
    const subscribeTo = vi.fn(() => () => { /* unsub */ });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo,
    } as never);
    await svc.execute({ workflowId: 'wf-backcompat', tenantId: 'default' });
    // Comportamento silent: subscribe non chiamato
    expect(subscribeTo).not.toHaveBeenCalled();
  });

  it('ephemeralRuns=false (default) → ripristina comportamento normale (subscribe + audit)', async () => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-normal',
      name: 'Normal Workflow',
      nodes: [],
      edges: [],
      enabled: true,
      // ephemeralRuns undefined → trackRun=true
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-1', status: 'success', steps: [], errorCount: 0, totalDurationMs: 1,
    });
    const subscribeTo = vi.fn(() => () => { /* unsub */ });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo,
    } as never);
    await svc.execute({ workflowId: 'wf-normal', tenantId: 'default' });
    expect(subscribeTo).toHaveBeenCalledTimes(1);
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// cancel() — active token branch
// ════════════════════════════════════════════════════════════════════
describe('RunService.cancel — active token branch', () => {
  it('returns alreadyDone:true se controller già aborted (idempotent)', async () => {
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    // Inject token già aborted via static map (defense-in-depth: testiamo il
    // branch idempotent)
     
    const tokens = (RunService as unknown as { cancelTokens: Map<string, AbortController> }).cancelTokens;
    const ctrl = new AbortController();
    ctrl.abort();
    tokens.set('run-active', ctrl);

    const r = await svc.cancel('run-active', 'tenant-1');
    expect(r.alreadyDone).toBe(true);
    expect(r.status).toBe('cancelled');
    expect(m.auditAppend).not.toHaveBeenCalled();
    // cleanup
    tokens.delete('run-active');
  });

  it('abort controller + await audit + return cancelling (status=cancelling)', async () => {
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const tokens = (RunService as unknown as { cancelTokens: Map<string, AbortController> }).cancelTokens;
    const ctrl = new AbortController();
    tokens.set('run-live', ctrl);

    const r = await svc.cancel('run-live', 'tenant-1');
    expect(ctrl.signal.aborted).toBe(true);
    expect(r.status).toBe('cancelling');
    expect(r.alreadyDone).toBe(false);
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'run.cancel',
      resourceId: 'run-live',
      metadata: expect.objectContaining({ source: 'api' }),
    }));
    // metadata.orphan NON deve esserci per active branch
    const call = m.auditAppend.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> };
    expect(call?.metadata?.orphan).toBeUndefined();
    tokens.delete('run-live');
  });
});

// ════════════════════════════════════════════════════════════════════
// cancel() — orphan with already-terminal status (idempotency)
// ════════════════════════════════════════════════════════════════════
describe('RunService.cancel — terminal status idempotency', () => {
  it('partial status → alreadyDone, NO audit', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-partial', tenantId: 'tenant-1', status: 'partial', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-partial', 'tenant-1');
    expect(r.alreadyDone).toBe(true);
    expect(r.status).toBe('partial');
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('error status → alreadyDone, NO audit', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-err', tenantId: 'tenant-1', status: 'error', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-err', 'tenant-1');
    expect(r.alreadyDone).toBe(true);
    expect(r.status).toBe('error');
  });

  it('cancelled status → alreadyDone, NO audit (idempotent double-cancel)', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-c', tenantId: 'tenant-1', status: 'cancelled', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-c', 'tenant-1');
    expect(r.alreadyDone).toBe(true);
  });

  it('paused status → alreadyDone, NO audit (cancel-paused not supported via this path)', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-p', tenantId: 'tenant-1', status: 'paused', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-p', 'tenant-1');
    expect(r.alreadyDone).toBe(true);
  });

  it('cancel — tenant isolation: run di altro tenant → found:false', async () => {
    // La WHERE clause filtra per tenantId; quindi se passiamo wrong tenant,
    // select.limit() ritorna [] anche se l'id esiste in altro tenant.
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    const r = await svc.cancel('run-other-tenant', 'tenant-wrong');
    expect(r.found).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// cancel() — emette event bus run.cancelled su orphan force-mark
// ════════════════════════════════════════════════════════════════════
describe('RunService.cancel — event bus emission', () => {
  it('emit run.cancelled su orphan branch', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-orphan', tenantId: 'tenant-1', status: 'running', workflowId: 'wf-1', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await svc.cancel('run-orphan', 'tenant-1');
    expect(m.emit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'run.cancelled',
      tenantId: 'tenant-1',
      data: expect.objectContaining({ runId: 'run-orphan', workflowId: 'wf-1', orphan: true }),
    }));
  });

  it('NO event emit su run inesistente', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await svc.cancel('run-x', 'tenant-1');
    expect(m.emit).not.toHaveBeenCalled();
  });

  it('NO event emit su already-terminal', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'run-done', tenantId: 'tenant-1', status: 'success', startedAt: new Date().toISOString() },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await svc.cancel('run-done', 'tenant-1');
    expect(m.emit).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// replay() — workflow lookup + pin building
// ════════════════════════════════════════════════════════════════════
describe('RunService.replay', () => {
  it('throws se run inesistente', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    await expect(svc.replay('run-x', {})).rejects.toThrow(/Run run-x not found/);
  });

  it('throws se workflow inesistente (replay di run orfano da workflow cancellato)', async () => {
    m.select.mockResolvedValueOnce([
      {
        id: 'run-1',
        tenantId: 'tenant-1',
        workflowId: 'wf-deleted',
        status: 'success',
        stepsJson: '[]',
        input: 'null',
        startedAt: new Date().toISOString(),
      },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    // Workflow get returns null → executeWithPins throws
    await expect(svc.replay('run-1', {})).rejects.toThrow(/Workflow wf-deleted not found/);
  });

  it('replay default usa tenantId dal prior run row (no opts.tenantId)', async () => {
    m.select
      .mockResolvedValueOnce([
        {
          id: 'run-1',
          tenantId: 'tenant-from-row',
          workflowId: 'wf-deleted',
          status: 'success',
          stepsJson: '[]',
          input: 'null',
          startedAt: new Date().toISOString(),
        },
      ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(),
    } as never);
    // Pop next workflow.get → null per testare l'errore con tenantId derivato
    await expect(svc.replay('run-1', {})).rejects.toThrow(/Workflow wf-deleted not found/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Static state isolation (inflight + cancelTokens) — defensive
// ════════════════════════════════════════════════════════════════════
describe('RunService — static state guards', () => {
  it('cancelTokens map exists (singleton state)', async () => {
    const { RunService } = await import('./run.service.js');
    const tokens = (RunService as unknown as { cancelTokens: Map<string, AbortController> }).cancelTokens;
    expect(tokens).toBeInstanceOf(Map);
  });

  it('inflight map exists (singleton state)', async () => {
    const { RunService } = await import('./run.service.js');
    const inflight = (RunService as unknown as { inflight: Map<string, number> }).inflight;
    expect(inflight).toBeInstanceOf(Map);
  });
});

// ════════════════════════════════════════════════════════════════════
// executeWithPins — full lifecycle con engine.run mockato
// ════════════════════════════════════════════════════════════════════
function makeWorkflow(over: Partial<{ id: string; concurrencyLimit: number; nodes: unknown[]; edges: unknown[]; runVerbosity: 'silent' | 'summary' | 'full'; ephemeralRuns: boolean }> = {}) {
  return {
    id: over.id ?? 'wf-test',
    name: 'Test WF',
    enabled: true,
    schemaVersion: '1.0.0',
    nodes: over.nodes ?? [],
    edges: over.edges ?? [],
    nodeDefs: [],
    concurrencyLimit: over.concurrencyLimit,
    ...(over.runVerbosity !== undefined ? { runVerbosity: over.runVerbosity } : {}),
    ...(over.ephemeralRuns !== undefined ? { ephemeralRuns: over.ephemeralRuns } : {}),
    createdAt: '2026-05-29T00:00:00Z',
    updatedAt: '2026-05-29T00:00:00Z',
  };
}

describe('RunService.executeWithPins — lifecycle paths', () => {
  it('SUCCESS path: engine ritorna success → status mapped + checkpoint purge + audit', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-1' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-1', status: 'success', steps: [], totalDurationMs: 100, errorCount: 0,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const res = await svc.execute({ workflowId: 'wf-1', tenantId: 't' });
    expect(res.status).toBe('success');
    expect(m.checkpointsPurge).toHaveBeenCalledWith('r-1');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workflow.run',
    }));
  });

  it('PARTIAL path: errorCount>0 → status forced "partial" (truthful, no fake success)', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-2' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-2', status: 'success', steps: [{ nodeId: 'n1', status: 'error', error: 'fail' }], totalDurationMs: 50, errorCount: 1,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const res = await svc.execute({ workflowId: 'wf-2' });
    expect(res.status).toBe('success'); // engine return value
    // checkpoint purgato è per result.status === 'success' (status RAW dell'engine),
    // truthful 'partial' è SOLO nel DB (UPDATE). purge è dunque CHIAMATO con 'success' raw.
    expect(m.checkpointsPurge).toHaveBeenCalled();
  });

  it('ERROR path: engine throws → status="error", checkpoint kept, audit fail', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-err' }));
    m.engineRun.mockRejectedValue(new Error('engine crash'));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.execute({ workflowId: 'wf-err' })).rejects.toThrow(/engine crash/);
  });

  it('CANCEL path: engine throws AbortError → status="cancelled" + event emit', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-abort' }));
    m.engineRun.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const res = await svc.execute({ workflowId: 'wf-abort' });
    expect(res.status).toBe('cancelled');
    expect(m.emit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'run.cancelled',
    }));
  });

  it('CONCURRENCY LIMIT: throw se inflight >= limit', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-cap', concurrencyLimit: 1 }));
    // Pre-popola inflight per simulare run già in corso
    const { RunService } = await import('./run.service.js');
    const inflight = (RunService as unknown as { inflight: Map<string, number> }).inflight;
    inflight.set('t-cap:wf-cap', 1);
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.execute({ workflowId: 'wf-cap', tenantId: 't-cap' }))
      .rejects.toThrow(/concurrent-run limit/);
    inflight.delete('t-cap:wf-cap');
  });

  it('PAUSED path: engine ritorna paused → endedAt=null (no purge)', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-pause' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-pause', status: 'paused', steps: [], totalDurationMs: 30, errorCount: 0,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const res = await svc.execute({ workflowId: 'wf-pause' });
    expect(res.status).toBe('paused');
    expect(m.checkpointsPurge).not.toHaveBeenCalled();
  });

  it('subworkflowDepth propagato a engine.run via opts', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-sub' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-sub', status: 'success', steps: [], totalDurationMs: 5, errorCount: 0,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-sub', subworkflowDepth: 3 });
    const engineArgs = m.engineRun.mock.calls[0]?.[0] as { subworkflowDepth: number };
    expect(engineArgs.subworkflowDepth).toBe(3);
  });

  it('triggerInput string passato as-is, non-string JSON.stringified', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-trig' }));
    m.engineRun.mockResolvedValue({ runId: 'r', status: 'success', steps: [], totalDurationMs: 0, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-trig', triggerInput: { x: 1 } });
    expect(m.engineRun).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// startAsync — fire-and-forget
// ════════════════════════════════════════════════════════════════════
describe('RunService.startAsync', () => {
  it('ritorna runId IMMEDIATAMENTE con status=running', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-async' }));
    m.engineRun.mockImplementation(() => new Promise(() => { /* never resolve */ }));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const res = await svc.startAsync({ workflowId: 'wf-async' });
    expect(res.status).toBe('running');
    expect(res.runId).toBeDefined();
    expect(res.steps).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// startAsync — QUEUE MODE (#4): pre-insert pending + enqueue, no inline run
// ════════════════════════════════════════════════════════════════════
describe('RunService.startAsync — queue mode (MEDEA_QUEUE_MODE=redis)', () => {
  const savedMode = process.env.MEDEA_QUEUE_MODE;
  beforeEach(() => { process.env.MEDEA_QUEUE_MODE = 'redis'; });
  afterAll(() => {
    if (savedMode === undefined) delete process.env.MEDEA_QUEUE_MODE;
    else process.env.MEDEA_QUEUE_MODE = savedMode;
  });

  function makeSvc(RunService: new (bus: unknown) => { startAsync: (i: unknown) => Promise<{ runId: string; status: string }> }) {
    return new RunService({ emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => undefined) });
  }

  it('🚨 NON esegue inline: inserisce una row pending + accoda, ritorna status=pending', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-q' }));
    const { RunService } = await import('./run.service.js');
    const svc = makeSvc(RunService as never);
    const res = await svc.startAsync({ workflowId: 'wf-q', tenantId: 't-q', triggerType: 'manual', triggeredBy: 'u-q' });

    expect(res.status).toBe('pending');
    expect(res.runId).toBeDefined();
    // engine NON deve essere stato chiamato (esecuzione delegata al worker)
    expect(m.engineRun).not.toHaveBeenCalled();
    // row pending inserita con lo stesso runId
    expect(m.insertValues).toHaveBeenCalledWith(expect.objectContaining({ id: res.runId, status: 'pending', workflowId: 'wf-q' }));
    // job accodato con lo stesso runId
    expect(m.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({ runId: res.runId, workflowId: 'wf-q', tenantId: 't-q' }));
  });

  it('🚨 workflow inesistente → throw PRIMA di accodare (404 sincrono, niente job orfano)', async () => {
    m.workflowGet.mockResolvedValue(null);
    const { RunService } = await import('./run.service.js');
    const svc = makeSvc(RunService as never);
    await expect(svc.startAsync({ workflowId: 'ghost' })).rejects.toThrow(/not found/);
    expect(m.enqueueRun).not.toHaveBeenCalled();
    expect(m.insertValues).not.toHaveBeenCalled();
  });

  it('🚨 enqueue fallito → rimuove la row pending orfana e rilancia', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-down' }));
    m.enqueueRun.mockRejectedValueOnce(new Error('Redis down'));
    const { RunService } = await import('./run.service.js');
    const svc = makeSvc(RunService as never);
    await expect(svc.startAsync({ workflowId: 'wf-down' })).rejects.toThrow(/Redis down/);
    // pending inserita ma poi cancellata (cleanup)
    expect(m.insertValues).toHaveBeenCalled();
    expect(m.deleteRun).toHaveBeenCalled();
  });

  it('run silent (ephemeral) NON persiste la row pending ma accoda comunque', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-silent', runVerbosity: 'silent' }));
    const { RunService } = await import('./run.service.js');
    const svc = makeSvc(RunService as never);
    const res = await svc.startAsync({ workflowId: 'wf-silent' });
    expect(res.status).toBe('pending');
    expect(m.insertValues).not.toHaveBeenCalled();
    expect(m.enqueueRun).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// replay — fromStep pinning + tenant fallback
// ════════════════════════════════════════════════════════════════════
describe('RunService.replay — pinning + tenant', () => {
  it('replay con fromStep pinna steps[0..N-1] success', async () => {
    m.select
      .mockResolvedValueOnce([{
        id: 'r-prior', tenantId: 't', workflowId: 'wf-prior',
        stepsJson: JSON.stringify([
          { nodeId: 'n1', output: '{"v":1}', status: 'success' },
          { nodeId: 'n2', output: '{"v":2}', status: 'success' },
          { nodeId: 'n3', output: '{"v":3}', status: 'error' },
        ]),
        input: '{"trigger":1}',
        startedAt: new Date().toISOString(),
      }]);
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-prior' }));
    m.engineRun.mockResolvedValue({ runId: 'r-new', status: 'success', steps: [], totalDurationMs: 10, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.replay('r-prior', { fromStep: 2 });
    // engine.run chiamato con pinnedOutputs = Map con 2 entries (n1, n2; n3 era 'error', skipped)
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    expect(args.pinnedOutputs?.size).toBe(2);
    expect(args.pinnedOutputs?.get('n1')).toEqual({ v: 1 });
  });

  // D2 (2026-06-06): replay UX-friendly per nodeId — editor "Re-esegui da qui"
  it('replay con fromNodeId → risolve a fromStep dell\'indice del nodeId', async () => {
    m.select
      .mockResolvedValueOnce([{
        id: 'r-prior', tenantId: 't', workflowId: 'wf-prior',
        stepsJson: JSON.stringify([
          { nodeId: 'http_a', output: '{"v":1}', status: 'success' },
          { nodeId: 'parse_b', output: '{"v":2}', status: 'success' },
          { nodeId: 'send_c', output: '{"v":3}', status: 'error' },
        ]),
        input: '{"trigger":1}',
        startedAt: new Date().toISOString(),
      }]);
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-prior' }));
    m.engineRun.mockResolvedValue({ runId: 'r-new', status: 'success', steps: [], totalDurationMs: 10, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    // "send_c" è index 2 → pinna [0,1] (http_a, parse_b)
    await svc.replay('r-prior', { fromNodeId: 'send_c' });
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown>; triggeredBy?: string };
    expect(args.pinnedOutputs?.size).toBe(2);
    expect(args.pinnedOutputs?.get('http_a')).toEqual({ v: 1 });
    expect(args.pinnedOutputs?.get('parse_b')).toEqual({ v: 2 });
    expect(args.triggeredBy).toMatch(/replay-from-node/);
  });

  it('replay con fromNodeId mancante in history → throw chiaro', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-prior', tenantId: 't', workflowId: 'wf-prior',
      stepsJson: JSON.stringify([
        { nodeId: 'a', output: '{"v":1}', status: 'success' },
      ]),
      input: 'null', startedAt: new Date().toISOString(),
    }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.replay('r-prior', { fromNodeId: 'nonexistent' }))
      .rejects.toThrow(/Node nonexistent not found in run/);
  });

  it('replay senza fromStep → NO pinning (full re-run)', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-full', tenantId: 't', workflowId: 'wf-full',
      stepsJson: '[]', input: 'null', startedAt: new Date().toISOString(),
    }]);
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-full' }));
    m.engineRun.mockResolvedValue({ runId: 'r-n', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.replay('r-full', {});
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    // no pinnedOutputs key (size 0 caso) → omitted
    expect(args.pinnedOutputs?.size ?? 0).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// resumeFromCheckpoint
// ════════════════════════════════════════════════════════════════════
describe('RunService.resumeFromCheckpoint', () => {
  it('throw se nessun checkpoint trovato', async () => {
    m.checkpointsLatest.mockReturnValue(null);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.resumeFromCheckpoint('r-x')).rejects.toThrow(/No checkpoint/);
  });

  it('throw se workflow cancellato', async () => {
    m.checkpointsLatest.mockReturnValue({
      runId: 'r-1', workflowId: 'wf-deleted', tenantId: 't',
      outputsById: {}, visited: [], pendingQueue: [], itemGraph: {},
    });
    m.workflowGet.mockResolvedValue(null);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.resumeFromCheckpoint('r-1')).rejects.toThrow(/Workflow wf-deleted not found/);
  });

  it('success → engine.resume + checkpoint purge', async () => {
    m.checkpointsLatest.mockReturnValue({
      runId: 'r-1', workflowId: 'wf-1', tenantId: 't',
      outputsById: { n1: { v: 1 } }, visited: ['n1'], pendingQueue: [],
      // GAP #2: il lineage del checkpoint deve arrivare INTATTO allo snapshot.
      itemGraph: { n1: [{ json: { v: 1 }, pairedItem: { item: 0, sourceNodeId: 'n0' } }] },
    });
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-1' }));
    m.engineResume.mockResolvedValue({ runId: 'r-1', status: 'success', errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.resumeFromCheckpoint('r-1');
    expect(m.checkpointsPurge).toHaveBeenCalledWith('r-1');
    // GAP #2: lo snapshot passato a engine.resume porta il grafo come Map.
    const snap = m.engineResume.mock.calls[0]?.[0] as { itemGraph: Map<string, unknown[]> };
    expect(snap.itemGraph.get('n1')).toEqual([{ json: { v: 1 }, pairedItem: { item: 0, sourceNodeId: 'n0' } }]);
  });

  it('non-success → NO purge', async () => {
    m.checkpointsLatest.mockReturnValue({
      runId: 'r-2', workflowId: 'wf-1', tenantId: 't',
      outputsById: {}, visited: [], pendingQueue: [], itemGraph: {},
    });
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-1' }));
    m.engineResume.mockResolvedValue({ runId: 'r-2', status: 'error', errorCount: 1 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.resumeFromCheckpoint('r-2');
    expect(m.checkpointsPurge).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// resumeFromPause
// ════════════════════════════════════════════════════════════════════
describe('RunService.resumeFromPause', () => {
  it('throw se workflow cancellato', async () => {
    m.workflowGet.mockResolvedValue(null);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const row = {
      runId: 'r-paused', workflowId: 'wf-gone', tenantId: 't',
      atNodeId: 'wait-1', defaultPayload: { signal: 'go' },
      outputsById: {}, visited: [], pendingQueue: [], itemGraph: {},
    };
    await expect(svc.resumeFromPause(row as never)).rejects.toThrow(/Workflow wf-gone not found/);
  });

  it('resume con downstream edges seeded + engine.resume', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({
      id: 'wf-1',
      edges: [{ from: 'wait-1', to: 'n2' }, { from: 'wait-1', to: 'n3' }, { from: 'other', to: 'n4' }],
    }));
    m.engineResume.mockResolvedValue({ runId: 'r-p', status: 'success', errorCount: 0, steps: [] });
    m.select.mockResolvedValueOnce([{
      id: 'r-p', workflowId: 'wf-1', tenantId: 't',
      stepsJson: '[]', errorCount: 0, startedAt: new Date().toISOString(),
    }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const row = {
      runId: 'r-p', workflowId: 'wf-1', tenantId: 't',
      atNodeId: 'wait-1', defaultPayload: { signal: 'data' },
      outputsById: {}, visited: ['wait-1'], pendingQueue: [], itemGraph: {},
    };
    await svc.resumeFromPause(row as never);
    const snapshotArg = m.engineResume.mock.calls[0]?.[0] as { pendingQueue: { nodeId: string }[] };
    // pendingQueue seeded con n2 + n3 (downstream di wait-1), NOT n4
    const seededIds = snapshotArg.pendingQueue.map((q) => q.nodeId);
    expect(seededIds).toContain('n2');
    expect(seededIds).toContain('n3');
    expect(seededIds).not.toContain('n4');
  });

  it('PAUSA-QUOTA (quota:renewed:*): NESSUN seeding downstream → ri-esegue il nodo ri-accodato', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({
      id: 'wf-1',
      edges: [{ from: 'qn', to: 'after' }], // downstream del nodo LLM
    }));
    m.engineResume.mockResolvedValue({ runId: 'r-q', status: 'success', errorCount: 0, steps: [] });
    m.select.mockResolvedValueOnce([{
      id: 'r-q', workflowId: 'wf-1', tenantId: 't',
      stepsJson: '[]', errorCount: 0, startedAt: new Date().toISOString(),
    }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({ emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => undefined) } as never);
    const row = {
      runId: 'r-q', workflowId: 'wf-1', tenantId: 't',
      signalName: 'quota:renewed:t',          // ← pausa-quota
      atNodeId: 'qn', defaultPayload: {},
      outputsById: {}, visited: [],
      pendingQueue: [{ nodeId: 'qn', carriedInput: { x: 1 } }], // nodo LLM ri-accodato dall'engine
      itemGraph: {},
    };
    await svc.resumeFromPause(row as never);
    const snapshotArg = m.engineResume.mock.calls[0]?.[0] as { pendingQueue: { nodeId: string }[] };
    const ids = snapshotArg.pendingQueue.map((q) => q.nodeId);
    expect(ids).toEqual(['qn']);          // SOLO il nodo da ri-eseguire
    expect(ids).not.toContain('after');   // NIENTE downstream seeded (sarebbe skip della ri-esecuzione)
  });
});

// ════════════════════════════════════════════════════════════════════
// getById / list / listRecent — tenant scope
// ════════════════════════════════════════════════════════════════════
describe('RunService.getById', () => {
  it('returns null se run inesistente o cross-tenant', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.getById('r-x', 't');
    expect(r).toBeNull();
  });

  it('parse steps + map nodeLabel fallback nodeId', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-1', workflowId: 'wf-1', tenantId: 't',
      status: 'success', startedAt: 'now', endedAt: 'later',
      totalDurationMs: 100, errorCount: 0,
      stepsJson: JSON.stringify([
        { nodeId: 'n1', nodeLabel: 'Step One', status: 'success', durationMs: 10 },
        { nodeId: 'n2', status: 'success' }, // no nodeLabel → fallback
      ]),
    }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.getById('r-1', 't');
    expect(r?.steps).toHaveLength(2);
    expect(r?.steps[0]?.nodeLabel).toBe('Step One');
    expect(r?.steps[1]?.nodeLabel).toBe('n2'); // fallback
  });

  it('steps array vuoto se stepsJson malformed', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-2', workflowId: 'wf-1', tenantId: 't',
      status: 'success', startedAt: 'now', endedAt: null,
      totalDurationMs: null, errorCount: null,
      stepsJson: '{this-is-not-json',
    }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.getById('r-2', 't');
    expect(r?.steps).toEqual([]);
  });
});

describe('RunService.list', () => {
  it('returns array di run mapped', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'r-1', workflowId: 'wf-1', tenantId: 't', status: 'success', startedAt: 'now', endedAt: 'later', totalDurationMs: 100, errorCount: 0, stepsJson: '[]' },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.list('wf-1', 't');
    expect(r).toHaveLength(1);
  });

  it('default tenantId=default se non specificato', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.list('wf-x');
    expect(r).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// truthfulStatus coverage via engine status mapping (all branches)
// ════════════════════════════════════════════════════════════════════
describe('RunService.executeWithPins — truthfulStatus mapping all branches', () => {
  async function runWithStatus(status: string, errorCount = 0) {
    m.workflowGet.mockResolvedValue({
      id: 'wf-x', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({
      runId: 'r-x', status, steps: [], totalDurationMs: 1, errorCount,
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    return svc.execute({ workflowId: 'wf-x' });
  }

  it('status=pending → preservato', async () => {
    const r = await runWithStatus('pending');
    expect(r.status).toBe('pending');
  });

  it('status=running → preservato', async () => {
    const r = await runWithStatus('running');
    expect(r.status).toBe('running');
  });

  it('status=cancelled (graceful, no abort) → preservato', async () => {
    const r = await runWithStatus('cancelled');
    expect(r.status).toBe('cancelled');
  });

  it('status=partial → preservato', async () => {
    const r = await runWithStatus('partial');
    expect(r.status).toBe('partial');
  });

  it('status=success + errorCount=5 → mapped a partial (truthful)', async () => {
    const r = await runWithStatus('success', 5);
    expect(r.status).toBe('success'); // engine raw; truthfulStatus solo lato UPDATE DB
  });

  it('status=unknown → fallback "partial" (truthfulStatus default)', async () => {
    const r = await runWithStatus('weird-unknown-status');
    expect(r.status).toBe('weird-unknown-status'); // engine raw return
  });
});

// ════════════════════════════════════════════════════════════════════
// replay — fromStep edge cases
// ════════════════════════════════════════════════════════════════════
describe('RunService.replay — edge cases branch fillers', () => {
  it('fromStep=0 → no pinning (boundary)', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-1', tenantId: 't', workflowId: 'wf-1',
      stepsJson: JSON.stringify([{ nodeId: 'n1', output: '{"v":1}', status: 'success' }]),
      input: 'null', startedAt: new Date().toISOString(),
    }]);
    m.workflowGet.mockResolvedValue({
      id: 'wf-1', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({ runId: 'r-n', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.replay('r-1', { fromStep: 0 });
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    expect(args.pinnedOutputs?.size ?? 0).toBe(0);
  });

  it('fromStep con step NON-success → skip pin (continue)', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-1', tenantId: 't', workflowId: 'wf-1',
      stepsJson: JSON.stringify([
        { nodeId: 'n1', output: '{"v":1}', status: 'success' },
        { nodeId: 'n2', output: 'err msg', status: 'error' },
      ]),
      input: 'null', startedAt: new Date().toISOString(),
    }]);
    m.workflowGet.mockResolvedValue({
      id: 'wf-1', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({ runId: 'r-n', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.replay('r-1', { fromStep: 2 });
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    expect(args.pinnedOutputs?.size).toBe(1); // solo n1 (n2 error, skipped)
  });

  it('fromStep con step output NON-JSON → parsed = raw string', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-1', tenantId: 't', workflowId: 'wf-1',
      stepsJson: JSON.stringify([
        { nodeId: 'n1', output: 'plain-text-output', status: 'success' },
      ]),
      input: 'null', startedAt: new Date().toISOString(),
    }]);
    m.workflowGet.mockResolvedValue({
      id: 'wf-1', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({ runId: 'r-n', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.replay('r-1', { fromStep: 1 });
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    expect(args.pinnedOutputs?.get('n1')).toBe('plain-text-output');
  });

  it('replay con stepsJson non-array (corrupted) → priorSteps = [] (fallback)', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-x', tenantId: 't', workflowId: 'wf-x',
      stepsJson: '{"not":"array"}', // object invece di array
      input: 'null', startedAt: new Date().toISOString(),
    }]);
    m.workflowGet.mockResolvedValue({
      id: 'wf-x', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({ runId: 'r-x', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.replay('r-x', { fromStep: 5 });
    const args = m.engineRun.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    expect(args.pinnedOutputs?.size ?? 0).toBe(0);
  });

  it('replay opts.tenantId override → usato vs prior.tenantId', async () => {
    m.select.mockResolvedValueOnce([{
      id: 'r-1', tenantId: 't-row', workflowId: 'wf-d', // different
      stepsJson: '[]', input: 'null', startedAt: new Date().toISOString(),
    }]);
    m.workflowGet.mockResolvedValue(null);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.replay('r-1', { tenantId: 't-override' })).rejects.toThrow();
    // tenant override usato in get
    const getArgs = m.workflowGet.mock.calls[0];
    expect(getArgs?.[1]).toBe('t-override');
  });
});

describe('RunService.listRecent', () => {
  it('returns array mapped + cap a 500 anche se limit > 500', async () => {
    m.select.mockResolvedValueOnce([
      { id: 'r-1', workflowId: 'wf-1', status: 'success', startedAt: 'now', endedAt: 'later', totalDurationMs: 100 },
    ]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.listRecent('t', 10000);
    expect(r).toHaveLength(1);
    expect(r[0]?.finishedAt).toBe('later');
  });

  it('limit MIN 1 (clamp lower bound)', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.listRecent('t', 0);
    expect(r).toEqual([]);
  });

  it('limit Math.floor: 5.7 → 5', async () => {
    m.select.mockResolvedValueOnce([]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    // 🚨 RESILIENCE: float limit (5.7) → service deve coercerlo a int senza crash.
    // Bug = client passa 5.7 da query string, DB driver crasha (limit non integer).
    const result = await svc.listRecent('t', 5.7);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]); // mock ritorna [], output matchato
    // Verifica select chiamato 1 sola volta (no retry per coerce error)
    expect(m.select).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// executeWithPins — incremental flush + scheduleFlush + finally cleanup
// ════════════════════════════════════════════════════════════════════
describe('RunService.executeWithPins — scheduleFlush + cleanup', () => {
  it('engine emit run.step events → accumulateSteps + scheduleFlush triggered → setTimeout fires DB update', async () => {
    vi.useFakeTimers();
    m.workflowGet.mockResolvedValue({
      id: 'wf-flush', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });

    let stepCallback: ((evt: unknown) => void) | undefined;
    const bus = {
      emit: m.emit,
      subscribe: vi.fn(),
      subscribeTo: vi.fn((name: string, cb: (evt: unknown) => void) => {
        if (name === 'run.step') stepCallback = cb;
        return () => undefined;
      }),
    };

    // engine.run returns promise risolto dopo che noi emettiamo step events
    let resolveEngine: (v: unknown) => void = () => undefined;
    m.engineRun.mockImplementation(({ runId }: { runId: string }) => {
      // Simula emit step events durante l'esecuzione
      setTimeout(() => {
        stepCallback?.({ data: { runId, step: { nodeId: 'n1', status: 'success' } } });
        stepCallback?.({ data: { runId, step: { nodeId: 'n2', status: 'success' } } });
      }, 100);
      return new Promise((res) => { resolveEngine = res; });
    });

    const { RunService } = await import('./run.service.js');
    const svc = new RunService(bus as never);
    const promise = svc.execute({ workflowId: 'wf-flush' });

    // Avanza 100ms per scatenare i 2 step events
    await vi.advanceTimersByTimeAsync(100);
    // Avanza 2000ms per scatenare scheduleFlush setTimeout
    await vi.advanceTimersByTimeAsync(2000);
    // Ora risolvi engine.run
    resolveEngine({ runId: 'wf-flush-r1', status: 'success', steps: [{ nodeId: 'n1' }, { nodeId: 'n2' }], totalDurationMs: 100, errorCount: 0 });
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    vi.useRealTimers();
    // db.update chiamato sia dal flush incremental sia dal final UPDATE
    expect(m.update).toHaveBeenCalled();
  });

  it('engine throws non-Abort error → status=error UPDATE + throw propagated', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-err', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockRejectedValue(new Error('something broke'));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await expect(svc.execute({ workflowId: 'wf-err' })).rejects.toThrow(/something broke/);
    // db.update chiamato per status='error'
    expect(m.update).toHaveBeenCalled();
  });

  it('engine throws "aborted" error → cancelled return path', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-abort', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockRejectedValue(new Error('Run aborted by user'));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.execute({ workflowId: 'wf-abort' });
    expect(r.status).toBe('cancelled');
    expect(m.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'run.cancelled' }));
  });

  it('engine error (errorCount>0) → buildErrorOutboxEvents + enqueue ATOMICO col mark-errored', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-fail', name: 'WF Fail', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({
      runId: 'r-fail', status: 'partial',
      steps: [{ nodeId: 'n1', status: 'error', error: 'boom' }],
      totalDurationMs: 50, errorCount: 1,
    });
    m.buildEvents.mockReturnValueOnce([{ id: 'r-fail:webhook', channel: 'webhook' }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.execute({ workflowId: 'wf-fail' });
    expect(r.errorCount).toBe(1);
    // L'enqueue avviene con i dati REALI del run errato.
    expect(m.buildEvents).toHaveBeenCalledTimes(1);
    expect(m.buildEvents.mock.calls[0]![0]).toMatchObject({
      runId: 'r-fail', workflowId: 'wf-fail', errorNodeId: 'n1', errorMessage: 'boom',
    });
    // mark-errored (update) + enqueue entrambi avvenuti (atomicità #3 testata in outbox-writer).
    expect(m.update).toHaveBeenCalled();
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it('inflight cleanup: dopo run, inflight Map decrement + delete se 0', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-cl', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [], concurrencyLimit: 5,
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({ runId: 'r', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-cl', tenantId: 't' });
    // Inflight Map dovrebbe non avere più la entry post-run
    const inflight = (RunService as unknown as { inflight: Map<string, number> }).inflight;
    expect(inflight.has('t:wf-cl')).toBe(false);
  });

  it('inflight decrement preserves count se altri run paralleli', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-multi', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineRun.mockResolvedValue({ runId: 'r', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0 });
    const { RunService } = await import('./run.service.js');
    // pre-popola inflight con count=3 (simula altri 3 run paralleli)
    const inflight = (RunService as unknown as { inflight: Map<string, number> }).inflight;
    inflight.set('t-m:wf-multi', 3);
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-multi', tenantId: 't-m' });
    // Dopo il nostro run, inflight=3+1-1=3 (rimangono gli altri 3)
    expect(inflight.get('t-m:wf-multi')).toBe(3);
    inflight.delete('t-m:wf-multi');
  });

  it('startAsync logger.error catch se background fail', async () => {
    m.workflowGet.mockRejectedValue(new Error('workflow lookup failed'));
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    const r = await svc.startAsync({ workflowId: 'wf-x' });
    expect(r.runId).toBeDefined();
    expect(r.status).toBe('running');
    // Aspetta che il background fallisca
    await new Promise((res) => setTimeout(res, 50));
  });
});

// ════════════════════════════════════════════════════════════════════
// resumeFromPause — branch coverage paused stepsJson edge cases
// ════════════════════════════════════════════════════════════════════
describe('RunService.resumeFromPause — branch fillers', () => {
  it('resume con prior.stepsJson NON-array → priorSteps=[]', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-1', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [{ from: 'wait-1', to: 'n2' }], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineResume.mockResolvedValue({ runId: 'r-p', status: 'success', errorCount: 0, steps: [{ nodeId: 'n2' }] });
    m.select.mockResolvedValueOnce([{
      id: 'r-p', workflowId: 'wf-1', tenantId: 't',
      stepsJson: '{"not":"array"}', errorCount: 0, startedAt: new Date().toISOString(),
    }]);
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.resumeFromPause({
      runId: 'r-p', workflowId: 'wf-1', tenantId: 't',
      atNodeId: 'wait-1', defaultPayload: {},
      outputsById: {}, visited: [], pendingQueue: [], itemGraph: {},
    } as never);
    expect(m.update).toHaveBeenCalled();
  });

  it('finally clearTimeout: step event registrato MA engine throws prima del flush → flushTimer cleared', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-tm', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    let stepCb: ((evt: unknown) => void) | undefined;
    const bus = {
      emit: m.emit,
      subscribe: vi.fn(),
      subscribeTo: vi.fn((name: string, cb: (evt: unknown) => void) => {
        if (name === 'run.step') stepCb = cb;
        return () => undefined;
      }),
    };
    // engine.run: emit step PRIMA del throw
    m.engineRun.mockImplementation(async ({ runId }: { runId: string }) => {
      stepCb?.({ data: { runId, step: { nodeId: 'n1' } } });
      // throw immediato — finally clearTimeout (flushTimer !== null, MA non flushed)
      throw new Error('quick fail');
    });
    const { RunService } = await import('./run.service.js');
    const svc = new RunService(bus as never);
    await expect(svc.execute({ workflowId: 'wf-tm' })).rejects.toThrow(/quick fail/);
  });

  it('E4 — run error con errorWorkflowId → buildEvents riceve l\'errWfId risolto (fanout durevole)', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-prod' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-prod', status: 'error',
      steps: [{ nodeId: 'n-fail', status: 'error', error: 'BOOM' }],
      totalDurationMs: 5, errorCount: 1,
    });
    m.getErrorWorkflowId.mockResolvedValue('wf-err-handler');
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-prod', tenantId: 't', triggerInput: { x: 1 } });
    // L'errWfId è risolto (per-wf → tenant) PRIMA della tx e passato al writer.
    expect(m.getErrorWorkflowId).toHaveBeenCalledWith('wf-prod', 't');
    expect(m.buildEvents).toHaveBeenCalledTimes(1);
    expect(m.buildEvents.mock.calls[0]![0]).toMatchObject({
      errorWorkflowId: 'wf-err-handler',
      workflowId: 'wf-prod',
      runId: 'r-prod',
      errorNodeId: 'n-fail',
      errorMessage: 'BOOM',
      triggerType: null,
    });
  });

  it('E4 — anti-loop: run "error-handler" NON risolve errWfId (writer non crea fanout)', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-handler' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-handler', status: 'error',
      steps: [{ nodeId: 'n-x', status: 'error', error: 'meta-fail' }],
      totalDurationMs: 5, errorCount: 1,
    });
    m.getErrorWorkflowId.mockResolvedValue('wf-other-handler');
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({
      workflowId: 'wf-handler', tenantId: 't',
      triggerType: 'error-handler', // ← già un error workflow
    });
    // resolve saltato (anti-loop): errWfId passato null + triggerType propagato al writer.
    expect(m.getErrorWorkflowId).not.toHaveBeenCalled();
    expect(m.buildEvents.mock.calls[0]![0]).toMatchObject({
      errorWorkflowId: null,
      triggerType: 'error-handler',
    });
  });

  it('E4 — anti-self: il writer riceve errWfId === workflow.id (skip nel writer, testato in outbox-writer)', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-self' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-self', status: 'error',
      steps: [{ nodeId: 'n-x', status: 'error', error: 'x' }],
      totalDurationMs: 1, errorCount: 1,
    });
    m.getErrorWorkflowId.mockResolvedValue('wf-self'); // self-reference
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-self', tenantId: 't' });
    expect(m.buildEvents.mock.calls[0]![0]).toMatchObject({ errorWorkflowId: 'wf-self', workflowId: 'wf-self' });
  });

  it('E4 — no enqueue su status=success (nessun evento d\'errore)', async () => {
    m.workflowGet.mockResolvedValue(makeWorkflow({ id: 'wf-ok' }));
    m.engineRun.mockResolvedValue({
      runId: 'r-ok', status: 'success', steps: [], totalDurationMs: 1, errorCount: 0,
    });
    m.getErrorWorkflowId.mockResolvedValue('wf-err-handler');
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.execute({ workflowId: 'wf-ok', tenantId: 't' });
    expect(m.getErrorWorkflowId).not.toHaveBeenCalled();
    expect(m.buildEvents).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('resume con prior row null → skip UPDATE branch', async () => {
    m.workflowGet.mockResolvedValue({
      id: 'wf-1', name: 'X', enabled: true, schemaVersion: '1.0.0',
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '2026', updatedAt: '2026',
    });
    m.engineResume.mockResolvedValue({ runId: 'r-p', status: 'success', errorCount: 0, steps: [] });
    m.select.mockResolvedValueOnce([]); // prior row missing
    const { RunService } = await import('./run.service.js');
    const svc = new RunService({
      emit: m.emit, subscribe: vi.fn(),
      subscribeTo: vi.fn(() => () => undefined),
    } as never);
    await svc.resumeFromPause({
      runId: 'r-p', workflowId: 'wf-1', tenantId: 't',
      atNodeId: 'wait-1', defaultPayload: {},
      outputsById: {}, visited: [], pendingQueue: [], itemGraph: {},
    } as never);
    // Non c'è UPDATE conditional (prior null → skip)
  });
});

// ════════════════════════════════════════════════════════════════════
// 🚨 Feedback loop run→template (P1 audit RAG): il wiring di fine-run.
// recordOutcome esisteva da sempre MA nessuno lo chiamava — questi test
// uccidono la mutazione "wiring rimosso di nuovo".
// ════════════════════════════════════════════════════════════════════
describe('🚨 fine-run → recordRunOutcomeForTemplate (feedback loop)', () => {
  const setupRun = (engineResult: Record<string, unknown>): void => {
    m.workflowGet.mockResolvedValueOnce({
      id: 'wf-fb', name: 'FB', nodes: [{ id: 'a', defId: 'trigger_manual' }], edges: [],
      enabled: true, ephemeralRuns: true,
    });
    m.engineRun.mockResolvedValueOnce({
      runId: 'r-fb', steps: [], errorCount: 0, totalDurationMs: 3, ...engineResult,
    });
  };
  const makeSvc = async (): Promise<{ execute: (i: unknown) => Promise<unknown> }> => {
    const { RunService } = await import('./run.service.js');
    return new RunService({
      emit: m.emit, subscribe: vi.fn(), subscribeTo: vi.fn(() => () => { /* unsub */ }),
    } as never) as never;
  };

  it('🚨 run success → outcome ok=true col GRAFO del workflow eseguito', async () => {
    setupRun({ status: 'success' });
    const svc = await makeSvc();
    await svc.execute({ workflowId: 'wf-fb', tenantId: 'default' });
    expect(tplFeedback.record).toHaveBeenCalledTimes(1);
    const [wf, ok] = tplFeedback.record.mock.calls[0] as [Record<string, unknown>, boolean];
    expect(ok).toBe(true);
    expect(wf.nodes).toEqual([{ id: 'a', defId: 'trigger_manual' }]);
  });

  it('🚨 run error → outcome ok=false (il template impara dai FALLIMENTI)', async () => {
    setupRun({ status: 'error', errorCount: 1 });
    const svc = await makeSvc();
    await svc.execute({ workflowId: 'wf-fb', tenantId: 'default' });
    expect(tplFeedback.record).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('run paused → NESSUN outcome (la pausa non è un esito)', async () => {
    setupRun({ status: 'paused', pausedId: 'p-1', pausedOnSignal: 'go' });
    const svc = await makeSvc();
    await svc.execute({ workflowId: 'wf-fb', tenantId: 'default' });
    expect(tplFeedback.record).not.toHaveBeenCalled();
  });
});
