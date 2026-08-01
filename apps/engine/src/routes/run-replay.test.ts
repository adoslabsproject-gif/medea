/**
 * Test 2026-grade — run-replay route (re-run workflow from failed node).
 *
 * 🚨 BUSINESS-LOGIC critica: pinnedOutputs = step outputs PRIMA del fromNode,
 *    così l'engine NON ri-esegue HTTP/DB/LLM costose ma usa cache.
 *
 * 🚨 INPUT VALIDATION:
 *  - fromNode query required → 400
 *  - workflow inesistente → 404
 *  - original run inesistente → 404
 *
 * 🚨 BFS walk: itera step ORIGINALI fino a fromNode (esclusivo).
 *   Solo step status='success' con output non-null vengono pinnati.
 *
 * 🚨 TRIGGER INPUT OVERRIDE: body { triggerInput } sovrascrive original.
 *   Malformed body → 400 (contratto GAP 4: un body rotto non può degradare
 *   in silenzio a "replay senza i miei edit").
 *
 * 🚨 GAP 4 (esecuzione parziale): fromNode/toNode validati contro i nodi REALI
 *   del workflow (fix bug: fromNode fantasma pinnava TUTTO e restituiva gli
 *   output storici spacciandoli per replay); toNode → stopAfterNodeId;
 *   pinnedOverrides = pin-edit al volo (vince sui pin storici).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const workflowGetMock = vi.fn();
class WorkflowServiceMock {
  get = workflowGetMock;
}
vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: WorkflowServiceMock,
}));

const executeWithPinsMock = vi.fn();
class RunServiceMock {
  executeWithPins = executeWithPinsMock;
}
vi.mock('@/services/run.service.js', () => ({
  RunService: RunServiceMock,
}));

const runsRow = { current: null as Record<string, unknown> | null };
const mockDb = {
  select: vi.fn(function (this: typeof mockDb) { return this; }),
  from: vi.fn(function (this: typeof mockDb) { return this; }),
  where: vi.fn(function (this: typeof mockDb) { return this; }),
  orderBy: vi.fn(function (this: typeof mockDb) { return this; }),
  limit: vi.fn(() => Promise.resolve(runsRow.current ? [runsRow.current] : [])),
};
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ db: mockDb }),
}));

vi.mock('@/storage/schema.js', () => ({
  runs: { id: 'id', workflowId: 'workflowId', tenantId: 'tenantId', startedAt: 'startedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({}), and: () => ({}), desc: () => ({}),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-A',
}));
vi.mock('@/lib/actor.js', () => ({
  getActorId: () => 'actor-1',
}));

const { createRunReplayRoutes } = await import('./run-replay.js');

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/v1', createRunReplayRoutes({} as never));
  return app;
}

async function replay(wfId: string, runId: string, fromNode: string, body?: unknown): Promise<Response> {
  const app = makeApp();
  const url = `/api/v1/workflows/${wfId}/runs/${runId}/replay${fromNode ? `?fromNode=${fromNode}` : ''}`;
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** Nodi del workflow mock — la route valida fromNode/toNode contro QUESTI. */
const WF_NODE_IDS = ['n1', 'n2', 'n3', 'n4', 'n9', 'node-x', 'fromX', 'any', 'failed-node-xyz'];

beforeEach(() => {
  vi.clearAllMocks();
  workflowGetMock.mockResolvedValue({
    id: 'wf-1',
    name: 'Test',
    nodes: WF_NODE_IDS.map((id) => ({ id, defId: 'noop', x: 0, y: 0, config: {} })),
  });
  executeWithPinsMock.mockResolvedValue({ id: 'new-run-id', status: 'success' });
  runsRow.current = null;
});

describe('🚨 input validation', () => {
  it('🚨 fromNode query mancante → 400', async () => {
    const res = await replay('wf-1', 'run-1', '');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/fromNode/u);
  });

  it('🚨 workflow inesistente → 404', async () => {
    workflowGetMock.mockResolvedValueOnce(null);
    const res = await replay('wf-missing', 'run-1', 'node-x');
    expect(res.status).toBe(404);
  });

  it('🚨 original run inesistente → 404', async () => {
    runsRow.current = null; // no run row
    const res = await replay('wf-1', 'run-missing', 'node-x');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/Original run/u);
  });
});

describe('🚨 pinnedOutputs BFS walk', () => {
  it('🚨 pin ALL success steps BEFORE fromNode', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: '{"k":1}' },
        { nodeId: 'n2', status: 'success', output: '{"k":2}' },
        { nodeId: 'n3', status: 'success', output: '{"k":3}' }, // fromNode = n3 → escluso
        { nodeId: 'n4', status: 'success', output: '{"k":4}' },
      ]),
      input: '{}',
    };
    const res = await replay('wf-1', 'run-1', 'n3');
    expect(res.status).toBe(200);
    const json = await res.json() as { pinnedCount: number; replayedFromNode: string };
    expect(json.pinnedCount).toBe(2); // n1 + n2
    expect(json.replayedFromNode).toBe('n3');
    const pinsArg = executeWithPinsMock.mock.calls[0]![1] as Map<string, unknown>;
    expect(pinsArg.size).toBe(2);
    expect(pinsArg.get('n1')).toEqual({ k: 1 });
    expect(pinsArg.get('n2')).toEqual({ k: 2 });
  });

  it('🚨 SKIP step status != success', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: '{"a":1}' },
        { nodeId: 'n2', status: 'error', output: 'oops' },
        { nodeId: 'n3', status: 'success', output: '{"a":3}' },
      ]),
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'n3');
    const json = await res.json() as { pinnedCount: number };
    expect(json.pinnedCount).toBe(1); // solo n1 (n2 errored)
  });

  it('🚨 SKIP step senza output (null/empty)', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: null },
        { nodeId: 'n2', status: 'success', output: '{"x":1}' },
      ]),
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'fromX');
    const json = await res.json() as { pinnedCount: number };
    expect(json.pinnedCount).toBe(1); // solo n2
  });

  it('🚨 output non-JSON string → preservato come string raw (no crash)', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: 'plain text not json' },
      ]),
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'fromX');
    expect(res.status).toBe(200);
    const pinsArg = executeWithPinsMock.mock.calls[0]![1] as Map<string, unknown>;
    expect(pinsArg.get('n1')).toBe('plain text not json');
  });

  it('🚨 stepsJson malformato → originalSteps[] vuoto, pinnedCount=0', async () => {
    runsRow.current = {
      stepsJson: 'NOT-JSON{{{',
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'any');
    expect(res.status).toBe(200);
    const json = await res.json() as { pinnedCount: number };
    expect(json.pinnedCount).toBe(0);
  });

  it('🚨 fromNode è il PRIMO step → 0 pinning (immediate break)', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: '{}' },
        { nodeId: 'n2', status: 'success', output: '{}' },
      ]),
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'n1');
    const json = await res.json() as { pinnedCount: number };
    expect(json.pinnedCount).toBe(0);
  });

  it('🚨 fromNode nel WORKFLOW ma non negli steps (run errorata prima) → tutti steps pinnati', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: '{}' },
        { nodeId: 'n2', status: 'success', output: '{}' },
        { nodeId: 'n3', status: 'success', output: '{}' },
      ]),
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'n9'); // n9 esiste nel wf, mai raggiunto
    const json = await res.json() as { pinnedCount: number };
    expect(json.pinnedCount).toBe(3);
  });

  it('🚨 BUG-FIX: fromNode FANTASMA (non nel workflow) → 400, non replay-tutto-pinnato silenzioso', async () => {
    runsRow.current = {
      stepsJson: JSON.stringify([{ nodeId: 'n1', status: 'success', output: '{}' }]),
      input: null,
    };
    const res = await replay('wf-1', 'run-1', 'fromXYZ');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/fromNode "fromXYZ" not found/u);
    expect(executeWithPinsMock).not.toHaveBeenCalled(); // NESSUNA run lanciata
  });
});

describe('🚨 triggerInput override', () => {
  beforeEach(() => {
    runsRow.current = {
      stepsJson: '[]',
      input: '{"original":true}',
    };
  });

  it('🚨 no body → triggerInput = originalRun.input parsed', async () => {
    await replay('wf-1', 'run-1', 'node-x');
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { triggerInput: unknown };
    expect(inputArg.triggerInput).toEqual({ original: true });
  });

  it('🚨 body { triggerInput: ... } → override', async () => {
    await replay('wf-1', 'run-1', 'node-x', { triggerInput: { custom: 42 } });
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { triggerInput: unknown };
    expect(inputArg.triggerInput).toEqual({ custom: 42 });
  });

  it('🚨 body malformato → 400 esplicito (un edit perso in silenzio è il bug peggiore)', async () => {
    const res = await replay('wf-1', 'run-1', 'node-x', '{{{NOT-JSON');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/Invalid JSON/u);
    expect(executeWithPinsMock).not.toHaveBeenCalled();
  });

  it('🚨 body senza triggerInput field → keep original', async () => {
    await replay('wf-1', 'run-1', 'node-x', { otherField: 'x' });
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { triggerInput: unknown };
    expect(inputArg.triggerInput).toEqual({ original: true });
  });

  it('🚨 original input null → triggerInput undefined (no setting)', async () => {
    runsRow.current = { stepsJson: '[]', input: null };
    await replay('wf-1', 'run-1', 'node-x');
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { triggerInput?: unknown };
    expect(inputArg.triggerInput).toBeUndefined();
  });
});

describe('🚨 triggerType + triggeredBy', () => {
  beforeEach(() => {
    runsRow.current = { stepsJson: '[]', input: null };
  });

  it('🚨 triggerType = "replay-from:<nodeId>"', async () => {
    await replay('wf-1', 'run-1', 'failed-node-xyz');
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { triggerType: string };
    expect(inputArg.triggerType).toBe('replay-from:failed-node-xyz');
  });

  it('🚨 triggeredBy = getActorId() (audit trail)', async () => {
    await replay('wf-1', 'run-1', 'node-x');
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { triggeredBy: string };
    expect(inputArg.triggeredBy).toBe('actor-1');
  });
});

// ─── GAP 4: esecuzione parziale + pin-edit ─────────────────────────────────

async function replayPartial(fromNode: string, toNode: string | undefined, body?: unknown): Promise<Response> {
  const app = makeApp();
  const qs = `?fromNode=${fromNode}${toNode !== undefined ? `&toNode=${toNode}` : ''}`;
  return app.request(`/api/v1/workflows/wf-1/runs/run-1/replay${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('🚨 GAP 4 — toNode (esecuzione parziale)', () => {
  beforeEach(() => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: '{"k":1}' },
        { nodeId: 'n2', status: 'success', output: '{"k":2}' },
      ]),
      input: null,
    };
  });

  it('🚨 toNode valido → stopAfterNodeId passato a executeWithPins', async () => {
    const res = await replayPartial('n2', 'n2');
    expect(res.status).toBe(200);
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { stopAfterNodeId?: string };
    expect(inputArg.stopAfterNodeId).toBe('n2');
    const json = await res.json() as { stoppedAfterNode?: string };
    expect(json.stoppedAfterNode).toBe('n2');
  });

  it('🚨 senza toNode → stopAfterNodeId ASSENTE (replay classico invariato)', async () => {
    await replayPartial('n2', undefined);
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { stopAfterNodeId?: string };
    expect(inputArg.stopAfterNodeId).toBeUndefined();
  });

  it('🚨 toNode fantasma → 400, nessuna run', async () => {
    const res = await replayPartial('n2', 'ghost');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/toNode "ghost" not found/u);
    expect(executeWithPinsMock).not.toHaveBeenCalled();
  });

  it('🚨 single-node: fromNode=X&toNode=X → antenati pinnati + stop su X', async () => {
    const res = await replayPartial('n2', 'n2');
    expect(res.status).toBe(200);
    const pins = executeWithPinsMock.mock.calls[0]![1] as Map<string, unknown>;
    expect(pins.size).toBe(1); // n1 pinnato
    expect(pins.get('n1')).toEqual({ k: 1 });
    const inputArg = executeWithPinsMock.mock.calls[0]![0] as { stopAfterNodeId?: string };
    expect(inputArg.stopAfterNodeId).toBe('n2');
  });
});

describe('🚨 GAP 4 — pinnedOverrides (pin-edit al volo)', () => {
  beforeEach(() => {
    runsRow.current = {
      stepsJson: JSON.stringify([
        { nodeId: 'n1', status: 'success', output: '{"k":"storico"}' },
        { nodeId: 'n2', status: 'success', output: '{"k":2}' },
      ]),
      input: null,
    };
  });

  it('🚨 override VINCE sul pin storico (l\'edit dell\'utente è la verità)', async () => {
    const res = await replayPartial('n3', 'n3', { pinnedOverrides: { n1: { k: 'EDITATO' } } });
    expect(res.status).toBe(200);
    const pins = executeWithPinsMock.mock.calls[0]![1] as Map<string, unknown>;
    expect(pins.get('n1')).toEqual({ k: 'EDITATO' }); // non più "storico"
    expect(pins.get('n2')).toEqual({ k: 2 });          // gli altri pin intatti
    const json = await res.json() as { overriddenCount: number; pinnedCount: number };
    expect(json.overriddenCount).toBe(1);
    expect(json.pinnedCount).toBe(2);
  });

  it('🚨 override su nodo SENZA pin storico → aggiunto (pin ex-novo)', async () => {
    const res = await replayPartial('n2', undefined, { pinnedOverrides: { n9: { fresh: true } } });
    expect(res.status).toBe(200);
    const pins = executeWithPinsMock.mock.calls[0]![1] as Map<string, unknown>;
    expect(pins.get('n9')).toEqual({ fresh: true });
  });

  it('🚨 override su nodo fantasma → 400, nessuna run', async () => {
    const res = await replayPartial('n2', undefined, { pinnedOverrides: { ghost: 1 } });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/node "ghost" not found/u);
    expect(executeWithPinsMock).not.toHaveBeenCalled();
  });

  it('🚨 pinnedOverrides non-oggetto (array/null/string) → 400', async () => {
    for (const bad of [[1, 2], null, 'x']) {
      executeWithPinsMock.mockClear();
      const res = await replayPartial('n2', undefined, { pinnedOverrides: bad });
      expect(res.status).toBe(400);
      expect(executeWithPinsMock).not.toHaveBeenCalled();
    }
  });
});
