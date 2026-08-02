/**
 * E2E — GAP 5 (a+b+c) sul flusso DUREVOLE (review on_error 2026-06-19).
 *
 * STACK REALE: RunService vero + WorkflowService vero + engine vero + SQLite vero.
 * La notifica d'errore NON è più fire-and-forget: executeWithPins ENQUEUE gli eventi
 * nell'outbox (atomico col mark-errored); il fan-out viene poi dispatchato dal worker
 * dell'outbox. Qui guidiamo UNO sweep deterministico (stessi dispatcher del bootstrap)
 * e asseriamo CHI parte. L'unico spy è startAsync (per non eseguire l'handler).
 *
 * Direzione bug-bounty: i NEGATIVI contano quanto i positivi — anti-self e anti-loop
 * devono impedire che la riga 'fanout' venga PROPRIO creata (verificato sull'outbox),
 * non solo che lo sweep non trovi nulla.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { WorkflowService } from './workflow.service.js';
import { RunService } from './run.service.js';
import { AuditLogService } from './audit.service.js';
import { AiExplainService } from './ai-explain.service.js';
import {
  getTenantErrorWorkflowId,
  setTenantErrorWorkflowId,
  resetErrorWorkflowFlagForTests,
} from './error-workflow-flag.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { getDatabase } from '@/storage/db.js';
import { runMigrations } from '@/storage/migrate.js';
import { ensureCredentialsTable } from './credentials.service.js';
import { runOutboxSweepOnce } from './error-outbox/worker.js';
import { buildOutboxDispatchers } from './error-outbox/wiring.js';
import { makeErrorHandlerStarter } from './error-outbox/error-handler-starter.js';
import {
  checkErrorFanoutRateLimit,
  __testHooks__ as rateLimitHooks,
} from './error-outbox/fanout-rate-limit.js';

const bus = new InMemoryEventBus();
const workflows = new WorkflowService(bus);
const runService = new RunService(bus);

let brokenWfId = ''; // workflow che fallisce SEMPRE (defId inesistente)
let handlerAId = ''; // error-handler per-workflow
let handlerBId = ''; // error-handler catch-all tenant

async function createBrokenWorkflow(name: string, errorWorkflowId?: string): Promise<string> {
  const wf = await workflows.create({
    name,
    enabled: true,
    tenantId: 'default',
    nodes: [{ id: 'boom', defId: 'def_inesistente_gap5', x: 0, y: 0, config: {} }],
    edges: [],
    ...(errorWorkflowId !== undefined ? { errorWorkflowId } : {}),
  });
  return wf.id;
}

/** Dispatcher reali (identici al bootstrap) — il fan-out chiama runService.startAsync. */
function buildRealDispatchers(): ReturnType<typeof buildOutboxDispatchers> {
  const startErrorHandler = makeErrorHandlerStarter({
    getWorkflow: (id, tenantId) => workflows.get(id, tenantId),
    explainRun: (tenantId, runId) => new AiExplainService().explain({ tenantId, runId }),
    startAsync: async (input) => {
      await runService.startAsync(input);
    },
  });
  return buildOutboxDispatchers({
    getWorkflow: (id, tenantId) => workflows.get(id, tenantId),
    getErrorWorkflowId: (id, tenantId) => workflows.getErrorWorkflowId(id, tenantId),
    getTenantErrorWorkflowId,
    checkRateLimit: checkErrorFanoutRateLimit,
    startErrorHandler,
    // niente webhook/email onError in questi workflow → quei dispatcher non vengono invocati.
  });
}

/** Guida UNO sweep dell'outbox (dispatcher reali). */
async function sweepOutbox(): Promise<void> {
  const { sqlite } = getDatabase();
  await runOutboxSweepOnce({ sqlite, dispatchers: buildRealDispatchers() });
}

function fanoutRowCount(runId: string): number {
  const { sqlite } = getDatabase();
  const row = sqlite
    .prepare("SELECT COUNT(*) AS c FROM error_outbox WHERE run_id = ? AND channel = 'fanout'")
    .get(runId) as { c: number };
  return row.c;
}

beforeAll(async () => {
  runMigrations();
  ensureCredentialsTable();
  brokenWfId = await createBrokenWorkflow('gap5-broken');
  const handlerA = await workflows.create({
    name: 'gap5-handler-A',
    enabled: true,
    tenantId: 'default',
    nodes: [{ id: 't', defId: 'trigger_error', x: 0, y: 0, config: {} }],
    edges: [],
  });
  handlerAId = handlerA.id;
  const handlerB = await workflows.create({
    name: 'gap5-handler-B',
    enabled: true,
    tenantId: 'default',
    nodes: [{ id: 't', defId: 'trigger_error', x: 0, y: 0, config: {} }],
    edges: [],
  });
  handlerBId = handlerB.id;
}, 30_000);

afterEach(() => {
  setTenantErrorWorkflowId(null);
  resetErrorWorkflowFlagForTests();
  rateLimitHooks.errorFanoutBuckets.clear();
  vi.restoreAllMocks();
});

describe('🚨 flag service — persistenza system_flags reale', () => {
  it('🚨 set → get → sopravvive al reset della cache (riletto dal DB)', () => {
    setTenantErrorWorkflowId('wf-catchall');
    expect(getTenantErrorWorkflowId()).toBe('wf-catchall');
    resetErrorWorkflowFlagForTests();
    expect(getTenantErrorWorkflowId()).toBe('wf-catchall'); // dal DB, non dalla cache
  });

  it('🚨 null/stringa vuota = rimozione (nessun catch-all)', () => {
    setTenantErrorWorkflowId('wf-x');
    setTenantErrorWorkflowId(null);
    resetErrorWorkflowFlagForTests();
    expect(getTenantErrorWorkflowId()).toBeNull();
  });
});

describe('🚨 audit strutturato — la scatola nera del run fallito', () => {
  it('🚨 run errore → riga audit workflow.run.errored con metadata strutturati + hash-chain INTEGRA', async () => {
    const result = await runService.executeWithPins(
      { workflowId: brokenWfId, tenantId: 'default', triggerInput: {} },
      new Map(),
    );
    expect(result.status).toBe('error');

    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(
        "SELECT * FROM audit_log WHERE action = 'workflow.run.errored' AND resource_id = ? LIMIT 1",
      )
      .get(result.runId) as { metadata_json: string; resource_type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.resource_type).toBe('run');
    const meta = JSON.parse(row!.metadata_json) as Record<string, unknown>;
    expect(meta.workflowId).toBe(brokenWfId);
    expect(meta.failedNodeId).toBe('boom');
    expect(String(meta.error)).toMatch(/def_inesistente_gap5|Unknown/u);

    // l'evento è dentro la CATENA immutabile, non un log qualunque
    const integrity = await new AuditLogService().verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });
});

describe('🚨 catch-all tenant — binding a due livelli (DUREVOLE via outbox)', () => {
  it('🚨 workflow SENZA handler proprio + flag tenant → fan-out sul catch-all con payload E4', async () => {
    setTenantErrorWorkflowId(handlerBId);
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    const run = await runService.executeWithPins(
      { workflowId: brokenWfId, tenantId: 'default', triggerInput: { q: 1 } },
      new Map(),
    );
    expect(fanoutRowCount(run.runId)).toBe(1); // riga 'fanout' enqueued atomicamente
    await sweepOutbox();
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0] as {
      workflowId: string;
      triggerType: string;
      triggerInput: Record<string, unknown>;
    };
    expect(arg.workflowId).toBe(handlerBId);
    expect(arg.triggerType).toBe('error-handler');
    expect(arg.triggerInput.workflowId).toBe(brokenWfId);
    expect(arg.triggerInput.failedNodeId).toBe('boom');
    // senza opt-in il payload NON ha il triage (zero costo LLM di default)
    expect(arg.triggerInput.aiTriage).toBeUndefined();
  });

  it('🚨 PRECEDENZA: handler per-workflow vince sul catch-all tenant', async () => {
    const withOwn = await createBrokenWorkflow('gap5-broken-own', handlerAId);
    setTenantErrorWorkflowId(handlerBId);
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    await runService.executeWithPins(
      { workflowId: withOwn, tenantId: 'default', triggerInput: {} },
      new Map(),
    );
    await sweepOutbox();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![0] as { workflowId: string }).workflowId).toBe(handlerAId); // NON handlerB
  });

  it('🚨 ANTI-SELF sul catch-all: flag tenant = il workflow stesso → NESSUNA riga fanout', async () => {
    setTenantErrorWorkflowId(brokenWfId); // configurazione illegale
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    const run = await runService.executeWithPins(
      { workflowId: brokenWfId, tenantId: 'default', triggerInput: {} },
      new Map(),
    );
    expect(fanoutRowCount(run.runId)).toBe(0); // il writer NON crea la riga (anti-self)
    await sweepOutbox();
    expect(spy).not.toHaveBeenCalled();
  });

  it('🚨 ANTI-LOOP: un error-handler che fallisce NON crea fanout (no tempesta)', async () => {
    setTenantErrorWorkflowId(handlerBId);
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    const run = await runService.executeWithPins(
      {
        workflowId: brokenWfId,
        tenantId: 'default',
        triggerType: 'error-handler',
        triggerInput: {},
      },
      new Map(),
    );
    expect(fanoutRowCount(run.runId)).toBe(0); // anti-loop: nessuna riga per run 'error-handler'
    await sweepOutbox();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('🚨 GAP 5 (c) — triage AI opt-in nel payload handler (DUREVOLE)', () => {
  it('🚨 trigger_error con aiTriage=true → payload arricchito con la diagnosi', async () => {
    const triageHandler = await workflows.create({
      name: 'gap5-handler-triage',
      enabled: true,
      tenantId: 'default',
      nodes: [{ id: 't', defId: 'trigger_error', x: 0, y: 0, config: { aiTriage: 'true' } }],
      edges: [],
    });
    setTenantErrorWorkflowId(triageHandler.id);
    const explainSpy = vi.spyOn(AiExplainService.prototype, 'explain').mockResolvedValue({
      explanation: 'Il nodo boom usa un defId inesistente',
      fix: 'Sostituisci il defId con uno del catalogo',
      root_cause: 'defId non registrato',
      risk: 'safe',
      confidence: 0.95,
    } as never);
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    const run = await runService.executeWithPins(
      { workflowId: brokenWfId, tenantId: 'default', triggerInput: {} },
      new Map(),
    );
    await sweepOutbox();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(explainSpy).toHaveBeenCalledWith({ tenantId: 'default', runId: run.runId });
    const payload = (
      spy.mock.calls[0]![0] as { triggerInput: { aiTriage?: Record<string, unknown> } }
    ).triggerInput;
    expect(payload.aiTriage).toMatchObject({
      explanation: 'Il nodo boom usa un defId inesistente',
      fix: 'Sostituisci il defId con uno del catalogo',
      rootCause: 'defId non registrato',
      risk: 'safe',
    });
  });

  it('🚨 SENZA opt-in → explain MAI chiamato (zero costo LLM di default)', async () => {
    setTenantErrorWorkflowId(handlerBId); // handler senza aiTriage
    const explainSpy = vi
      .spyOn(AiExplainService.prototype, 'explain')
      .mockResolvedValue({} as never);
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    await runService.executeWithPins(
      { workflowId: brokenWfId, tenantId: 'default', triggerInput: {} },
      new Map(),
    );
    await sweepOutbox();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(explainSpy).not.toHaveBeenCalled();
  });

  it("🚨 FAIL-SOFT: explain esplode → l'handler parte COMUNQUE, senza aiTriage", async () => {
    const triageHandler = await workflows.create({
      name: 'gap5-handler-triage-boom',
      enabled: true,
      tenantId: 'default',
      nodes: [{ id: 't', defId: 'trigger_error', x: 0, y: 0, config: { aiTriage: 'true' } }],
      edges: [],
    });
    setTenantErrorWorkflowId(triageHandler.id);
    vi.spyOn(AiExplainService.prototype, 'explain').mockRejectedValue(new Error('LLM giù'));
    const spy = vi.spyOn(runService, 'startAsync').mockResolvedValue({ runId: 'spy-run' } as never);
    await runService.executeWithPins(
      { workflowId: brokenWfId, tenantId: 'default', triggerInput: {} },
      new Map(),
    );
    await sweepOutbox();
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = (spy.mock.calls[0]![0] as { triggerInput: Record<string, unknown> })
      .triggerInput;
    expect(payload.aiTriage).toBeUndefined();
    expect(payload.failedNodeId).toBe('boom'); // il resto del payload è integro
  });
});

describe('🚨 trigger_error nel registry', () => {
  it('🚨 def presente, type trigger, gestito dal trigger-passthrough (run handler parte)', async () => {
    const result = await runService.executeWithPins(
      { workflowId: handlerAId, tenantId: 'default', triggerInput: { error: 'x' } },
      new Map(),
    );
    expect(result.status).toBe('success'); // il trigger passa l'input, nessun executor richiesto
  });
});
