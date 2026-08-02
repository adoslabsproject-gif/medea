/**
 * Test 2026-grade — GAP 1 "Visible Auto-Map": Edge.mapMode nell'engine.
 *
 * NON green-smoke: ogni test traccia QUANTE volte e CON QUALE input gira
 * l'executor vero (spy per chiamata) e verifica l'ALLINEAMENTO PER INDICE
 * dei risultati — la garanzia anti-footgun ($itemMatching) è il contratto,
 * non un dettaglio. Coperti anche: back-compat 'off', contratto 'each',
 * tolleranza 'auto', soft/fatal error per-item, cap anti-runaway, nodi
 * non mappabili, precedenza del pin globale, interop con stopAfterNodeId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowEngine } from './workflow-engine.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import type { Workflow, Edge } from '@medea/engine-core-schema';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';

interface Call {
  input: unknown;
}
let calls: Map<string, Call[]>;
let failOn: Map<string, (input: unknown) => boolean>;

function defOf(id: string, branching = false) {
  return {
    id,
    label: id,
    kind: 'action' as const,
    category: 'test',
    inputs: [],
    outputs: branching ? ['yes', 'no'] : [],
    configSchema: {} as never,
    ...(branching ? { branching: true } : {}),
  };
}

function mod(defId: string, branching = false) {
  return {
    def: defOf(defId, branching),
    executor: async (_c: unknown, input: unknown, _ctx: NodeExecutionContext) => {
      const list = calls.get(defId) ?? [];
      list.push({ input });
      calls.set(defId, list);
      if (failOn.get(defId)?.(input) === true) throw new Error(`boom su ${JSON.stringify(input)}`);
      return { output: { processed: input }, chosenBranch: branching ? 'yes' : undefined };
    },
  };
}

function makeWorkflow(
  nodes: { id: string; defId: string; continueOnFail?: boolean }[],
  edges: Edge[],
): Workflow {
  return {
    schemaVersion: '1.0.0',
    id: 'wf-map',
    name: 'Map',
    enabled: true,
    nodes: nodes.map((n, i) => ({
      id: n.id,
      defId: n.defId,
      x: i,
      y: 0,
      config: {},
      ...(n.continueOnFail !== undefined ? { continueOnFail: n.continueOnFail } : {}),
    })),
    edges,
    nodeDefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeEngine(...mods: object[]): WorkflowEngine {
  return new WorkflowEngine(new InMemoryEventBus(), { nodeRegistry: mods as never[] });
}

const savedMax = process.env.MEDEA_ENGINE_MAX_MAP_ITEMS;
beforeEach(() => {
  calls = new Map();
  failOn = new Map();
  delete process.env.MEDEA_ENGINE_MAX_MAP_ITEMS;
});
afterEach(() => {
  if (savedMax === undefined) delete process.env.MEDEA_ENGINE_MAX_MAP_ITEMS;
  else process.env.MEDEA_ENGINE_MAX_MAP_ITEMS = savedMax;
});

/** src (emette l'array passato come triggerInput) → [mapMode] → dst → sink */
function chain(mapMode: Edge['mapMode'], dstOpts: { continueOnFail?: boolean } = {}): Workflow {
  return makeWorkflow(
    [
      { id: 'src', defId: 'src' },
      { id: 'dst', defId: 'dst', ...dstOpts },
      { id: 'sink', defId: 'sink' },
    ],
    [
      { from: 'src', to: 'dst', ...(mapMode !== undefined ? { mapMode } : {}) },
      { from: 'dst', to: 'sink' },
    ],
  );
}

/** src ritorna il triggerInput così com'è (pass-through). */
function passthroughSrc() {
  return {
    def: defOf('src'),
    executor: async (_c: unknown, input: unknown, _ctx: NodeExecutionContext) => ({
      output: input,
      chosenBranch: undefined,
    }),
  };
}

describe('🚨 mapMode=auto — fan-out per-item su array', () => {
  it("🚨 3 item → executor dst gira 3 VOLTE coi singoli item; risultati ALLINEATI per indice; sink riceve l'array", async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain('auto'), triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');

    const dstCalls = calls.get('dst') ?? [];
    expect(dstCalls.map((c) => c.input)).toEqual(['a', 'b', 'c']); // un item per chiamata
    // ($index/$item per le espressioni passano via interpreter scope; l'indice
    // OSSERVABILE del contratto è step.iterationIndex, asserito più sotto.)

    // sink riceve l'ARRAY aggregato allineato: results[i] = f(items[i])
    const sinkCalls = calls.get('sink') ?? [];
    expect(sinkCalls[0]?.input).toEqual([
      { processed: 'a' },
      { processed: 'b' },
      { processed: 'c' },
    ]);

    // osservabilità: uno step per item con iterationIndex/total + loopId map:<nodeId>
    const dstSteps = result.steps.filter((s) => s.nodeId === 'dst');
    expect(dstSteps).toHaveLength(3);
    expect(dstSteps.map((s) => s.iterationIndex)).toEqual([0, 1, 2]);
    expect(dstSteps.every((s) => s.iterationTotal === 3)).toBe(true);
    expect(dstSteps.every((s) => s.loopId === 'map:dst')).toBe(true);
  });

  it('🚨 auto su input NON-array → pass-through standard (1 esecuzione, input intatto)', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain('auto'), triggerInput: { single: true } });
    expect(result.status).toBe('success');
    const dstCalls = calls.get('dst') ?? [];
    expect(dstCalls).toHaveLength(1);
    expect(dstCalls[0]?.input).toEqual({ single: true });
  });
});

describe('🚨 back-compat — mapMode assente/off NON cambia NULLA', () => {
  it("🚨 senza mapMode l'array arriva INTERO (1 esecuzione) — semantica storica", async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain(undefined), triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    const dstCalls = calls.get('dst') ?? [];
    expect(dstCalls).toHaveLength(1);
    expect(dstCalls[0]?.input).toEqual(['a', 'b', 'c']);
  });

  it('🚨 mapMode=off esplicito = identico ad assente', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    await engine.run({ workflow: chain('off'), triggerInput: ['a', 'b'] });
    expect(calls.get('dst')).toHaveLength(1);
  });
});

describe('🚨 mapMode=each — contratto rigido', () => {
  it('🚨 each su NON-array → errore ESPLICITO, executor MAI chiamato, sink non gira', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain('each'), triggerInput: { single: true } });
    expect(result.errorCount).toBe(1);
    expect(calls.get('dst')).toBeUndefined(); // mai eseguito
    expect(calls.get('sink')).toBeUndefined(); // ramo morto
    const errStep = result.steps.find((s) => s.nodeId === 'dst');
    expect(errStep?.status).toBe('error');
    expect(errStep?.error).toMatch(/richiede un input ARRAY/u);
  });

  it('🚨 each su array → fan-out identico ad auto', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain('each'), triggerInput: [1, 2] });
    expect(result.status).toBe('success');
    expect(calls.get('dst')).toHaveLength(2);
  });
});

describe('🚨 LINEAGE anti-footgun — allineamento per indice con errori per-item', () => {
  it('🚨 item centrale fallisce con continueOnFail: results[1] = error-item CON index, [0]/[2] integri', async () => {
    failOn.set('dst', (input) => input === 'b');
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({
      workflow: chain('auto', { continueOnFail: true }),
      triggerInput: ['a', 'b', 'c'],
    });
    expect(result.status).toBe('success'); // soft-fail non è fatale
    const sinkInput = (calls.get('sink') ?? [])[0]?.input as unknown[];
    expect(sinkInput).toHaveLength(3); // NESSUN buco
    expect(sinkInput[0]).toEqual({ processed: 'a' });
    expect(sinkInput[2]).toEqual({ processed: 'c' });
    const errItem = sinkInput[1] as { error: { index: number; nodeId: string } };
    expect(errItem.error.index).toBe(1); // lineage esplicito
    expect(errItem.error.nodeId).toBe('dst');
    // lo step dell'item fallito è osservabile come "continued" (giallo, non rosso)
    const stepB = result.steps.find((s) => s.nodeId === 'dst' && s.iterationIndex === 1);
    expect(stepB?.continued).toBe(true);
  });

  it('🚨 item fatale SENZA continueOnFail: fan-out troncato, sink NON gira, errorCount=1', async () => {
    failOn.set('dst', (input) => input === 'b');
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain('auto'), triggerInput: ['a', 'b', 'c'] });
    expect(result.errorCount).toBe(1);
    expect(calls.get('dst')).toHaveLength(2); // 'a' ok, 'b' boom, 'c' MAI
    expect(calls.get('sink')).toBeUndefined(); // Stop-and-Error
  });
});

describe('🚨 guardrail', () => {
  it('🚨 nodo BRANCHABLE con mapMode → errore esplicito (branch per-item ambiguo), mai eseguito', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst', true), mod('sink'));
    const result = await engine.run({ workflow: chain('auto'), triggerInput: ['a'] });
    expect(result.errorCount).toBe(1);
    expect(calls.get('dst')).toBeUndefined();
    const errStep = result.steps.find((s) => s.nodeId === 'dst');
    expect(errStep?.error).toMatch(/non mappabile/u);
  });

  it('🚨 cap MEDEA_ENGINE_MAX_MAP_ITEMS: oltre il limite → errore esplicito, ZERO esecuzioni parziali', async () => {
    process.env.MEDEA_ENGINE_MAX_MAP_ITEMS = '3';
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({ workflow: chain('auto'), triggerInput: [1, 2, 3, 4] });
    expect(result.errorCount).toBe(1);
    expect(calls.get('dst')).toBeUndefined(); // niente "primi 3 poi boom"
    const errStep = result.steps.find((s) => s.nodeId === 'dst');
    expect(errStep?.error).toMatch(/cap 3/u);
  });

  it('🚨 PIN GLOBALE vince sul fan-out: nodo pinnato → output pinnato, executor mai chiamato', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const pins = new Map<string, unknown>([['dst', { pinned: true }]]);
    const result = await engine.run({
      workflow: chain('auto'),
      triggerInput: ['a', 'b'],
      pinnedOutputs: pins,
    });
    expect(result.status).toBe('success');
    expect(calls.get('dst')).toBeUndefined();
    expect((calls.get('sink') ?? [])[0]?.input).toEqual({ pinned: true });
  });

  it('🚨 interop GAP 4: stopAfterNodeId sul nodo mappato → fan-out completo ma sink scartato', async () => {
    const engine = makeEngine(passthroughSrc(), mod('dst'), mod('sink'));
    const result = await engine.run({
      workflow: chain('auto'),
      triggerInput: ['a', 'b'],
      stopAfterNodeId: 'dst',
    });
    expect(result.status).toBe('success');
    expect(calls.get('dst')).toHaveLength(2); // il fan-out completa
    expect(calls.get('sink')).toBeUndefined(); // la valle no
  });
});
