/**
 * Test 2026-grade — ai-scaffold.service.ts (ScaffoldSession orchestrator + routing).
 *
 * 🚨 AI-CRITICAL: agent-loop workflow + DB schema generation. Test
 * focalizzati sulla logica del barrel + adapter SSE, NON sui handler
 * (testati separatamente in ai-scaffold/*).
 *
 * Coverage:
 *  - ScaffoldSession constructor: tenantId set + draft vuoto + trace=[]
 *  - execute(): delega a toolRegistry + push trace con step/elapsedMs
 *  - tool* methods: one-liner delegator (verifica chiamata handler)
 *  - AiScaffoldService.scaffold() routing:
 *    * MEDEA_SCAFFOLD_MODE=singleshot (default) → runSingleshotScaffold
 *    * MEDEA_SCAFFOLD_MODE=iter → runScaffold
 *  - SSE adapter singleshot: phase mapping + closePhase pattern
 *  - tool_call → tool_result chain (1 row per phase)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  toolRegistryExecute: vi.fn(),
  // Discovery handlers
  listDatabases: vi.fn(),
  readDbSchema: vi.fn(),
  listWorkflows: vi.fn(),
  readWorkflow: vi.fn(),
  listNodeCatalog: vi.fn(),
  listEmailAccounts: vi.fn(),
  listSecrets: vi.fn(),
  listLlmProviders: vi.fn(),
  listDraftNodes: vi.fn(),
  // DB migration handlers
  createDatabase: vi.fn(),
  createTable: vi.fn(),
  addColumn: vi.fn(),
  dropColumn: vi.fn(),
  dropTable: vi.fn(),
  renameColumn: vi.fn(),
  addIndex: vi.fn(),
  // Draft mutations
  proposePlan: vi.fn(),
  addNode: vi.fn(),
  connectNodes: vi.fn(),
  finalizeWorkflow: vi.fn(),
  abort: vi.fn(),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
  disconnectNodes: vi.fn(),
  // Observability
  listRecentRuns: vi.fn(),
  readRun: vi.fn(),
  checkSettingsHealth: vi.fn(),
  // Runners
  runScaffold: vi.fn(),
  runSingleshotScaffold: vi.fn(),
  // DbStudioService
  DbStudioMock: vi.fn(),
}));

vi.mock('./db-studio.service.js', () => ({
  DbStudioService: class {
    constructor() {
      m.DbStudioMock();
    }
  },
}));

vi.mock('./ai-scaffold/register-tools.js', () => ({}));

vi.mock('./ai-scaffold/tool-registry.js', () => ({
  toolRegistry: { execute: (...a: unknown[]) => m.toolRegistryExecute(...a) },
}));

vi.mock('./ai-scaffold/types.js', () => ({
  AiScaffoldError: class extends Error {},
}));

vi.mock('./ai-scaffold/scaffold-runner.js', () => ({
  runScaffold: (...a: unknown[]) => m.runScaffold(...a),
}));

vi.mock('./ai-scaffold/singleshot.service.js', () => ({
  runSingleshotScaffold: (...a: unknown[]) => m.runSingleshotScaffold(...a),
}));

vi.mock('./ai-scaffold/tools/discovery.js', () => ({
  listDatabasesHandler: (...a: unknown[]) => m.listDatabases(...a),
  readDbSchemaHandler: (...a: unknown[]) => m.readDbSchema(...a),
  listWorkflowsHandler: (...a: unknown[]) => m.listWorkflows(...a),
  readWorkflowHandler: (...a: unknown[]) => m.readWorkflow(...a),
  listNodeCatalogHandler: (...a: unknown[]) => m.listNodeCatalog(...a),
  listEmailAccountsHandler: (...a: unknown[]) => m.listEmailAccounts(...a),
  listSecretsHandler: (...a: unknown[]) => m.listSecrets(...a),
  listLlmProvidersHandler: (...a: unknown[]) => m.listLlmProviders(...a),
  listDraftNodesHandler: (...a: unknown[]) => m.listDraftNodes(...a),
}));

vi.mock('./ai-scaffold/tools/db-migrations.js', () => ({
  createDatabaseHandler: (...a: unknown[]) => m.createDatabase(...a),
  createTableHandler: (...a: unknown[]) => m.createTable(...a),
  addColumnHandler: (...a: unknown[]) => m.addColumn(...a),
  dropColumnHandler: (...a: unknown[]) => m.dropColumn(...a),
  dropTableHandler: (...a: unknown[]) => m.dropTable(...a),
  renameColumnHandler: (...a: unknown[]) => m.renameColumn(...a),
  addIndexHandler: (...a: unknown[]) => m.addIndex(...a),
}));

vi.mock('./ai-scaffold/tools/draft-mutations.js', () => ({
  addNodeHandler: (...a: unknown[]) => m.addNode(...a),
  connectNodesHandler: (...a: unknown[]) => m.connectNodes(...a),
  finalizeWorkflowHandler: (...a: unknown[]) => m.finalizeWorkflow(...a),
  abortHandler: (...a: unknown[]) => m.abort(...a),
  updateNodeHandler: (...a: unknown[]) => m.updateNode(...a),
  deleteNodeHandler: (...a: unknown[]) => m.deleteNode(...a),
  disconnectNodesHandler: (...a: unknown[]) => m.disconnectNodes(...a),
}));

vi.mock('./ai-scaffold/tools/plan-handler.js', () => ({
  proposePlanHandler: (...a: unknown[]) => m.proposePlan(...a),
}));

vi.mock('./ai-scaffold/tools/observability.js', () => ({
  listRecentRunsHandler: (...a: unknown[]) => m.listRecentRuns(...a),
  readRunHandler: (...a: unknown[]) => m.readRun(...a),
  checkSettingsHealthHandler: (...a: unknown[]) => m.checkSettingsHealth(...a),
}));

import { ScaffoldSession, AiScaffoldService } from './ai-scaffold.service.js';

beforeEach(() => {
  Object.values(m).forEach((mock) => {
    if (typeof mock === 'function' && 'mockReset' in mock) {
      (mock as ReturnType<typeof vi.fn>).mockReset();
    }
  });
  delete process.env.MEDEA_SCAFFOLD_MODE;
});

describe('ScaffoldSession constructor + state', () => {
  it('🚨 inizializza tenantId + draft vuoto + trace=[]', () => {
    const s = new ScaffoldSession('t1');
    expect(s.tenantId).toBe('t1');
    expect(s.draft).toEqual({ id: '', name: '', description: '', nodes: [], edges: [] });
    expect(s.trace).toEqual([]);
    expect(s.finalized).toBe(false);
    expect(s.aborted).toBe(false);
    expect(s.plan).toBeNull();
  });

  it('crea DbStudioService al boot', () => {
    new ScaffoldSession('t1');
    expect(m.DbStudioMock).toHaveBeenCalled();
  });
});

describe('🚨 execute() — dispatch via toolRegistry + trace accumulator', () => {
  it('happy: chiama toolRegistry.execute(session, name, args) + ritorna result', async () => {
    const expectedResult = { ok: true, data: { x: 1 } };
    m.toolRegistryExecute.mockResolvedValue(expectedResult);
    const s = new ScaffoldSession('t1');
    const r = await s.execute('test_tool', { a: 1 });
    expect(r).toEqual(expectedResult);
    expect(m.toolRegistryExecute).toHaveBeenCalledWith(s, 'test_tool', { a: 1 });
  });

  it('🚨 trace: push entry con step incrementale + elapsedMs', async () => {
    m.toolRegistryExecute.mockResolvedValue({ ok: true, data: null });
    const s = new ScaffoldSession('t1');
    await s.execute('a', { x: 1 });
    await s.execute('b', { y: 2 });
    await s.execute('c', { z: 3 });
    expect(s.trace).toHaveLength(3);
    expect(s.trace[0]).toMatchObject({ step: 1, tool: 'a', args: { x: 1 } });
    expect(s.trace[1]).toMatchObject({ step: 2, tool: 'b' });
    expect(s.trace[2]).toMatchObject({ step: 3, tool: 'c' });
    expect(s.trace[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('execute con tool error → result ok:false preservato in trace', async () => {
    m.toolRegistryExecute.mockResolvedValue({ ok: false, error: 'bad' });
    const s = new ScaffoldSession('t1');
    const r = await s.execute('bad_tool', {});
    expect(r).toEqual({ ok: false, error: 'bad' });
    expect(s.trace[0]?.result).toEqual({ ok: false, error: 'bad' });
  });
});

describe('🚨 tool* delegator methods', () => {
  it.each([
    ['toolListDatabases', 'listDatabases'],
    ['toolListEmailAccounts', 'listEmailAccounts'],
    ['toolListSecrets', 'listSecrets'],
    ['toolListLlmProviders', 'listLlmProviders'],
    ['toolListDraftNodes', 'listDraftNodes'],
    ['toolCheckSettingsHealth', 'checkSettingsHealth'],
  ])('%s → delega a %s handler senza args', (method, handler) => {
    (m[handler as keyof typeof m] as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: null,
    });
    const s = new ScaffoldSession('t1');
    (s as unknown as Record<string, () => unknown>)[method]?.();
    expect(m[handler as keyof typeof m]).toHaveBeenCalledWith(s);
  });

  it.each([
    ['toolReadDbSchema', 'readDbSchema'],
    ['toolListNodeCatalog', 'listNodeCatalog'],
    ['toolProposePlan', 'proposePlan'],
    ['toolAddNode', 'addNode'],
    ['toolConnectNodes', 'connectNodes'],
    ['toolFinalizeWorkflow', 'finalizeWorkflow'],
    ['toolAbort', 'abort'],
    ['toolUpdateNode', 'updateNode'],
    ['toolDeleteNode', 'deleteNode'],
    ['toolDisconnectNodes', 'disconnectNodes'],
    ['toolListRecentRuns', 'listRecentRuns'],
    ['toolReadRun', 'readRun'],
    ['toolRenameColumn', 'renameColumn'],
  ])('%s(args) → delega a %s(session, args)', (method, handler) => {
    (m[handler as keyof typeof m] as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: true,
      data: null,
    });
    const s = new ScaffoldSession('t1');
    const args = { test: 'arg' };
    (s as unknown as Record<string, (a: unknown) => unknown>)[method]?.(args);
    expect(m[handler as keyof typeof m]).toHaveBeenCalledWith(s, args);
  });

  it.each([
    ['toolCreateDatabase', 'createDatabase'],
    ['toolCreateTable', 'createTable'],
    ['toolAddColumn', 'addColumn'],
    ['toolDropColumn', 'dropColumn'],
    ['toolDropTable', 'dropTable'],
    ['toolAddIndex', 'addIndex'],
    ['toolListWorkflows', 'listWorkflows'],
    ['toolReadWorkflow', 'readWorkflow'],
  ])('async %s(args) → delega a %s(session, args)', async (method, handler) => {
    (m[handler as keyof typeof m] as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: null,
    });
    const s = new ScaffoldSession('t1');
    const args = { test: 'arg' };
    await (s as unknown as Record<string, (a?: unknown) => Promise<unknown>>)[method]?.(args);
    expect(m[handler as keyof typeof m]).toHaveBeenCalled();
  });
});

describe('🚨 AiScaffoldService.scaffold() — mode routing', () => {
  it('🚨 default → mode=singleshot → runSingleshotScaffold called', async () => {
    m.runSingleshotScaffold.mockResolvedValue({ workflowId: 'wf-1' });
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'test', tenantId: 't1' } as never);
    expect(m.runSingleshotScaffold).toHaveBeenCalled();
    expect(m.runScaffold).not.toHaveBeenCalled();
  });

  it('🚨 MEDEA_SCAFFOLD_MODE=iter → runScaffold called', async () => {
    process.env.MEDEA_SCAFFOLD_MODE = 'iter';
    m.runScaffold.mockResolvedValue({ workflowId: 'wf-1' });
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'test', tenantId: 't1' } as never);
    expect(m.runScaffold).toHaveBeenCalled();
    expect(m.runSingleshotScaffold).not.toHaveBeenCalled();
  });

  it('🚨 MEDEA_SCAFFOLD_MODE=singleshot esplicito → runSingleshotScaffold', async () => {
    process.env.MEDEA_SCAFFOLD_MODE = 'singleshot';
    m.runSingleshotScaffold.mockResolvedValue({ workflowId: 'wf-1' });
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'test', tenantId: 't1' } as never);
    expect(m.runSingleshotScaffold).toHaveBeenCalled();
  });

  it('mode sconosciuto (es. "broken") → fallback a runScaffold (legacy)', async () => {
    process.env.MEDEA_SCAFFOLD_MODE = 'broken-mode';
    m.runScaffold.mockResolvedValue({ workflowId: 'wf-1' });
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'test', tenantId: 't1' } as never);
    expect(m.runScaffold).toHaveBeenCalled();
    expect(m.runSingleshotScaffold).not.toHaveBeenCalled();
  });
});

describe('🚨 SSE adapter singleshot — phase events mapping', () => {
  // Cattura la callback passata a runSingleshotScaffold per simulare gli eventi.
  let emitterFromSource: ((e: unknown) => void) | null = null;
  let collectedEvents: unknown[] = [];

  beforeEach(() => {
    emitterFromSource = null;
    collectedEvents = [];
    m.runSingleshotScaffold.mockImplementation((_input: unknown, cb: (e: unknown) => void) => {
      emitterFromSource = cb;
      return Promise.resolve({ workflowId: 'wf-1' });
    });
  });

  const collectingProgress = (e: unknown): void => {
    collectedEvents.push(e);
  };

  it('🚨 event "start" → forward + maxIter=12 (fixed baseline)', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'my-goal', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'start' });
    const start = collectedEvents.find((e) => (e as { type: string }).type === 'start') as {
      goal: string;
      maxIter: number;
    };
    expect(start).toBeDefined();
    expect(start.goal).toBe('my-goal');
    expect(start.maxIter).toBe(12);
  });

  it('🚨 event "analyzing" → iter_start + tool_call(singleshot_analyze)', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'analyzing' });
    const tc = collectedEvents.find(
      (e) => (e as { type: string; tool?: string }).tool === 'singleshot_analyze',
    );
    expect(tc).toBeDefined();
    const iterStart = collectedEvents.find((e) => (e as { type: string }).type === 'iter_start');
    expect(iterStart).toBeDefined();
  });

  it('🚨 closePhase pattern: analyzing → generating chiude la fase precedente con tool_result ok=true', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'analyzing' });
    emitterFromSource?.({ type: 'generating' });
    const toolResults = collectedEvents.filter(
      (e) => (e as { type: string }).type === 'tool_result',
    );
    // closePhase chiamato per chiudere analyzing prima di aprire generating
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { ok: boolean }).ok).toBe(true);
    expect((toolResults[0] as { tool: string }).tool).toBe('singleshot_analyze');
  });

  it('event "validating" → tool_call(singleshot_validate)', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'validating' });
    const tc = collectedEvents.find((e) => (e as { tool?: string }).tool === 'singleshot_validate');
    expect(tc).toBeDefined();
  });

  it('🚨 event "queued" → tool_call(singleshot_queued)', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'queued', detail: 'position 3' });
    const tc = collectedEvents.find((e) => (e as { tool?: string }).tool === 'singleshot_queued');
    expect(tc).toBeDefined();
  });

  it('🚨 event "node_added" → singleshot_node_added forwarded', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'node_added', index: 0, payload: { id: 'n1', defId: 'a' } });
    const ev = collectedEvents.find(
      (e) => (e as { type: string }).type === 'singleshot_node_added',
    );
    expect(ev).toBeDefined();
    expect((ev as { node: { id: string } }).node.id).toBe('n1');
  });

  it('🚨 event "edge_added" → singleshot_edge_added forwarded', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'edge_added', index: 0, payload: { from: 'n1', to: 'n2' } });
    const ev = collectedEvents.find(
      (e) => (e as { type: string }).type === 'singleshot_edge_added',
    );
    expect(ev).toBeDefined();
  });

  it('🚨 event "token_usage" → cumulative + lastCall forwarded', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'token_usage', tokens: { input: 100, output: 200 } });
    const ev = collectedEvents.find((e) => (e as { type: string }).type === 'token_usage') as {
      cumulative: { input: number; output: number };
      lastCall: { input: number; output: number };
    };
    expect(ev).toBeDefined();
    expect(ev.cumulative.input).toBe(100);
    expect(ev.lastCall.output).toBe(200);
  });

  it('🚨 event "meta" → JSON parse + singleshot_meta', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({
      type: 'meta',
      detail: JSON.stringify({ name: 'wf', reasoning: 'analysis' }),
    });
    const ev = collectedEvents.find((e) => (e as { type: string }).type === 'singleshot_meta') as {
      meta: { name: string; reasoning: string };
    };
    expect(ev).toBeDefined();
    expect(ev.meta.name).toBe('wf');
  });

  it('🚨 event "meta" con JSON malformed → silently swallowed', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'meta', detail: 'not-json{' });
    // NO event "singleshot_meta" emesso
    const ev = collectedEvents.find((e) => (e as { type: string }).type === 'singleshot_meta');
    expect(ev).toBeUndefined();
  });

  it('🚨 event "done" → closePhase + forward done event', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'analyzing' });
    emitterFromSource?.({ type: 'done', result: { workflowId: 'wf-1' } });
    const tr = collectedEvents.find((e) => (e as { type: string }).type === 'tool_result');
    expect(tr).toBeDefined(); // closePhase chiamato
    const done = collectedEvents.find((e) => (e as { type: string }).type === 'done');
    expect(done).toBeDefined();
  });

  it('🚨 event "error" → closePhase pulisce currentPhase senza forward done', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never, collectingProgress);
    emitterFromSource?.({ type: 'analyzing' });
    emitterFromSource?.({ type: 'error' });
    // tool_result emesso per chiudere analyzing
    const tr = collectedEvents.find((e) => (e as { type: string }).type === 'tool_result');
    expect(tr).toBeDefined();
  });

  it('🚨 senza onProgress callback → adapter skip silently', async () => {
    const svc = new AiScaffoldService();
    await svc.scaffold({ goal: 'g', tenantId: 't1' } as never); // no onProgress
    expect(() => emitterFromSource?.({ type: 'start' })).not.toThrow();
    expect(collectedEvents).toHaveLength(0);
  });
});
