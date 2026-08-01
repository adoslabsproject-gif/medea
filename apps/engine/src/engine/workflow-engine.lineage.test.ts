/**
 * Bug-bounty test — GAP #2 fase 4.2: l'ENGINE popola il lineage durante i run.
 *
 * Fino alla 4.1 `$('Node').item`/`itemMatching` erano API-only (ritornavano
 * undefined: l'engine non costruiva il RunItemGraph). Questi test provano la
 * catena VIVA end-to-end: BFS → itemGraph → scope.lineage → interpolazione
 * config → executor. L'osservabile è ciò che l'executor RICEVE in config dopo
 * l'interpolazione (probe), non lo stato interno: se l'ancoraggio (S, i)
 * slittasse, l'euristica inventasse pairing, o la dichiarazione dell'executor
 * venisse droppata lungo la dispatch chain, i valori visti dai probe cambiano
 * e i test falliscono.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine, type EngineSnapshot } from './workflow-engine.js';
import type { PauseArgs } from './ports.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import type { Workflow, Edge } from '@flowforge/core-schema';
import type { ExecutionItem } from '@flowforge/core-schema';
import { findStdlibNode, type NodeExecutionContext } from '@flowforge/nodes-stdlib';

let seen: Map<string, unknown[]>; // defId → valori config.probe interpolati, in ordine di esecuzione

function defOf(id: string) {
  return {
    id, label: id, kind: 'action' as const, category: 'test',
    inputs: [], outputs: [], configSchema: {} as never,
  };
}

/** Nodo sonda: registra il valore di config.probe DOPO l'interpolazione. */
function probeMod(defId: string) {
  return {
    def: defOf(defId),
    executor: async (config: Record<string, unknown>, _input: unknown, _ctx: NodeExecutionContext) => {
      const list = seen.get(defId) ?? [];
      list.push(config.probe);
      seen.set(defId, list);
      return { output: { echo: config.probe }, chosenBranch: undefined };
    },
  };
}

/** Sorgente: emette il triggerInput così com'è. */
function passthroughMod(defId: string) {
  return {
    def: defOf(defId),
    executor: async (_c: unknown, input: unknown, _ctx: NodeExecutionContext) => ({ output: input, chosenBranch: undefined }),
  };
}

/** Transform same-length: array di scalari → array di oggetti {v: upper}. */
function upperMod(defId: string) {
  return {
    def: defOf(defId),
    executor: async (_c: unknown, input: unknown, _ctx: NodeExecutionContext) => ({
      output: (input as string[]).map((v) => ({ v: v.toUpperCase() })),
      chosenBranch: undefined,
    }),
  };
}

/**
 * Nodo che DICHIARA il proprio lineage (NodeExecutionResult.items): emette un
 * blob non-deducibile (1 output da 3 input) ma dichiara che l'item 0 della sua
 * vista deriva dall'item 2 dell'input — il caso filter "tiene solo a3".
 */
function declaringMod(defId: string, items: ExecutionItem[]) {
  return {
    def: defOf(defId),
    executor: async (_c: unknown, _input: unknown, _ctx: NodeExecutionContext) => ({
      output: { keptCount: items.length, blob: true },
      chosenBranch: undefined,
      items,
    }),
  };
}

/** Fan-out node che fallisce su un input specifico (per il soft-fail). */
function flakyMod(defId: string, failOnInput: unknown) {
  return {
    def: defOf(defId),
    executor: async (_c: unknown, input: unknown, _ctx: NodeExecutionContext) => {
      if (input === failOnInput) throw new Error(`boom su ${String(input)}`);
      return { output: { ok: input }, chosenBranch: undefined };
    },
  };
}

function makeWorkflow(
  nodes: { id: string; defId: string; config?: Record<string, string>; continueOnFail?: boolean }[],
  edges: Edge[],
): Workflow {
  return {
    schemaVersion: '1.0.0', id: 'wf-lineage', name: 'Lineage', enabled: true,
    nodes: nodes.map((n, i) => ({
      id: n.id, defId: n.defId, x: i, y: 0, config: n.config ?? {},
      ...(n.continueOnFail !== undefined ? { continueOnFail: n.continueOnFail } : {}),
    })),
    edges, nodeDefs: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function makeEngine(...mods: object[]): WorkflowEngine {
  return new WorkflowEngine(new InMemoryEventBus(), { nodeRegistry: mods as never[] });
}

beforeEach(() => { seen = new Map(); });

describe('🚨 fan-out (edge.mapMode): $(\'src\').item è l\'item ACCOPPIATO della sorgente', () => {
  it('per ogni iterazione i, .item risolve src[i] — allineamento per indice end-to-end', async () => {
    const workflow = makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'probe', defId: 'probe', config: { probe: "{{ $('src').item.json.value }}" } },
      ],
      [{ from: 'src', to: 'probe', mapMode: 'auto' }],
    );
    const engine = makeEngine(passthroughMod('src'), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // Se l'ancoraggio fosse fisso a 0 (mutazione itemIndex) → ['a','a','a'].
    // Se il lineage non fosse popolato (pre-4.2) → [undefined × 3].
    expect(seen.get('probe')).toEqual(['a', 'b', 'c']);
  });

  it('multi-hop: il pairing sopravvive a un transform same-length in mezzo (euristica 1:1)', async () => {
    const workflow = makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'upper', defId: 'upper' },
        { id: 'probe', defId: 'probe', config: { probe: "{{ $('src').item.json.value }}" } },
      ],
      [
        { from: 'src', to: 'upper' },
        { from: 'upper', to: 'probe', mapMode: 'each' },
      ],
    );
    const engine = makeEngine(passthroughMod('src'), upperMod('upper'), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // probe itera sugli output di 'upper': la risoluzione di $('src') deve
    // camminare upper[i] → (euristica posizionale 1:1) → src[i].
    expect(seen.get('probe')).toEqual(['a', 'b', 'c']);
  });

  it('🚨 soft-fail per-item: l\'error-item OCCUPA la posizione e il pairing NON slitta', async () => {
    const workflow = makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'flaky', defId: 'flaky', continueOnFail: true },
        { id: 'probe', defId: 'probe', config: { probe: "{{ $('src').item.json.value }}" } },
      ],
      [
        { from: 'src', to: 'flaky', mapMode: 'auto' },
        { from: 'flaky', to: 'probe', mapMode: 'auto' },
      ],
    );
    const engine = makeEngine(passthroughMod('src'), flakyMod('flaky', 'b'), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // flaky fallisce su 'b' (posizione 1) ma l'error-item tiene il posto:
    // dal probe, $('src').item per i=0,1,2 risolve 'a','b','c' SENZA slittare.
    // Un pairing posizionale ricalcolato sull'array compattato darebbe
    // ['a','c',undefined] — l'anti-footgun che n8n chiama $itemMatching.
    expect(seen.get('probe')).toEqual(['a', 'b', 'c']);
  });
});

describe('🚨 dichiarazione executor (NodeExecutionResult.items) — il caso NON deducibile', () => {
  it('itemMatching attraversa un nodo 3→1 SOLO grazie agli items dichiarati', async () => {
    // declaring emette un blob (1 item) da 3 input e dichiara: "il mio item 0
    // deriva dall'input 2". L'euristica da sola (fromMany) darebbe src[0]='a'.
    const workflow = makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'declaring', defId: 'declaring' },
        { id: 'probe', defId: 'probe', config: { probe: "{{ $('src').itemMatching(0).json.value }}" } },
      ],
      [
        { from: 'src', to: 'declaring' },
        { from: 'declaring', to: 'probe' },
      ],
    );
    const engine = makeEngine(
      passthroughMod('src'),
      declaringMod('declaring', [{ json: { v: 'c' }, pairedItem: { item: 2 } }]),
      probeMod('probe'),
    );
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // 'c' = src[2] via dichiarazione. Se la dispatch chain droppasse
    // result.items (mutazione runWithRetry) l'euristica fromMany darebbe 'a'.
    expect(seen.get('probe')).toEqual(['c']);
  });
});

describe('🚨🚨 GATE (reviewer, non negoziabile) — A→filter→C col VERO action_filter', () => {
  /**
   * Il caso che SOLO il lineage dichiarato dal filtro può risolvere:
   * A emette [a1,a2,a3]; il filtro TIENE a1,a3 (scarta a2). Da C,
   * `$('A').itemMatching(1)` = l'item di A accoppiato al secondo item
   * sopravvissuto = a3 (indice ORIGINALE 2). Un pairing posizionale
   * (re-indicizzato sull'array compattato) darebbe a2. Il fan-out da solo,
   * senza la dichiarazione del filtro, non può saperlo.
   */
  it('🚨 da C, $(\'A\').itemMatching(1) è a3 (paired via indice originale 2) — NON a2 (posizionale)', async () => {
    const filterNode = findStdlibNode('action_filter');
    expect(filterNode).toBeDefined();
    const conditions = JSON.stringify({ combinator: 'AND', rules: [{ field: 'name', op: 'not_equals', value: 'a2' }] });
    const workflow = makeWorkflow(
      [
        { id: 'A', defId: 'src' },
        { id: 'F', defId: 'action_filter', config: { conditions } },
        { id: 'C', defId: 'probe', config: {
          // item corrente (ancora 0) | item paired col 2° sopravvissuto | conferma vista filtro
          probe: "{{ $('A').item.json.name }}|{{ $('A').itemMatching(1).json.name }}|{{ $('F').itemMatching(1).json.name }}",
        } },
      ],
      [
        { from: 'A', to: 'F' },
        { from: 'F', to: 'C', fromPort: 'kept' },
      ],
    );
    const engine = makeEngine(passthroughMod('src'), filterNode as object, probeMod('probe'));
    const result = await engine.run({
      workflow,
      triggerInput: [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }],
    });
    expect(result.status).toBe('success');
    // 'a1'  = $('A').item        (ancora deterministica: primo item)
    // 'a3'  = $('A').itemMatching(1) — PAIRED attraverso il filtro (posizionale: 'a2')
    // 'a3'  = $('F').itemMatching(1) — la vista item-native del filtro stesso
    expect(seen.get('probe')).toEqual(['a1|a3|a3']);
  });

  it('il blob di output del filtro resta il contratto storico (kept/removed/counts)', async () => {
    const filterNode = findStdlibNode('action_filter');
    const conditions = JSON.stringify({ combinator: 'AND', rules: [{ field: 'name', op: 'not_equals', value: 'a2' }] });
    const workflow = makeWorkflow(
      [
        { id: 'A', defId: 'src' },
        { id: 'F', defId: 'action_filter', config: { conditions } },
        { id: 'C', defId: 'probe', config: { probe: "{{ $('F').first().json.keptCount }}" } },
      ],
      [{ from: 'A', to: 'F' }, { from: 'F', to: 'C', fromPort: 'kept' }],
    );
    const engine = makeEngine(passthroughMod('src'), filterNode as object, probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }] });
    expect(result.status).toBe('success');
    // $('F').first() legge da vars (il DATO che viaggia): il blob è intatto
    // anche se la vista lineage del filtro (graph) è item-native.
    // (l'interpolazione in config stringifica → '2')
    expect(seen.get('probe')).toEqual(['2']);
  });
});

describe('🚨 loop body (logic_loop) — $(\'src\').item è l\'item dell\'iterazione corrente', () => {
  function loopWorkflow(loopConfig: Record<string, string>, probeExpr: string): Workflow {
    return makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'loop', defId: 'logic_loop', config: { strategy: 'naive', ...loopConfig } },
        { id: 'probe', defId: 'probe', config: { probe: probeExpr } },
      ],
      [
        { from: 'src', to: 'loop' },
        { from: 'loop', to: 'probe', fromPort: 'body' },
      ],
    );
  }
  const loopModule = (): object => findStdlibNode('logic_loop') as object;

  it('strategy naive: per ogni iterazione i, .item = src[i] (paired, non sempre il primo)', async () => {
    const workflow = loopWorkflow({}, "{{ $('src').item.json.value }}");
    const engine = makeEngine(passthroughMod('src'), loopModule(), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // Pre-fix il body non aveva scope.lineage → [undefined × 3].
    // Ancoraggio fisso a 0 darebbe ['a','a','a'].
    expect(seen.get('probe')).toEqual(['a', 'b', 'c']);
  });

  it('🚨 strategy batch: loop.index indicizza il CHUNK → lineage OMESSO (mai pairing falso)', async () => {
    const workflow = loopWorkflow(
      { strategy: 'batch', batchSize: '2' },
      "{{ $('src').item === undefined ? 'no-lineage' : 'BUG' }}",
    );
    const engine = makeEngine(passthroughMod('src'), loopModule(), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // 3 item / batchSize 2 → 2 iterazioni, entrambe senza lineage.
    expect(seen.get('probe')).toEqual(['no-lineage', 'no-lineage']);
  });

  it('🚨 itemsExpression custom (≠ input): gli indici non riferiscono la sorgente → lineage OMESSO', async () => {
    const workflow = loopWorkflow(
      { itemsExpression: "['x','y']" },
      "{{ $('src').item === undefined ? 'no-lineage' : 'BUG' }}",
    );
    const engine = makeEngine(passthroughMod('src'), loopModule(), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    expect(seen.get('probe')).toEqual(['no-lineage', 'no-lineage']);
  });
});

describe('🚨 pause → resume: il lineage SOPRAVVIVE allo snapshot (itemGraph persistito)', () => {
  /**
   * Il caso che SOLO la persistenza del grafo può risolvere: src emette
   * [a,b,c] su DUE rami. Il ramo 1 (wait_signal) sospende il run PRIMA che
   * il ramo 2 (probe in fan-out) venga eseguito → il probe resta in
   * pendingQueue con sourceNodeId='src'. Al resume, $('src').item per item i
   * risolve SOLO se graph.get('src') è stato ripristinato dallo snapshot.
   */
  function pausedWorkflow(): Workflow {
    return makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'wait', defId: 'logic_wait_signal', config: { signalName: 'go' } },
        { id: 'P', defId: 'probe', config: { probe: "{{ $('src').item.json.value }}" } },
      ],
      [
        { from: 'src', to: 'wait' },   // processato per primo → suspend
        { from: 'src', to: 'P', mapMode: 'auto' }, // resta in pendingQueue
      ],
    );
  }

  async function runUntilPause(): Promise<{ engine: WorkflowEngine; captured: PauseArgs; workflow: Workflow }> {
    let captured: PauseArgs | undefined;
    const pauseHandler = { pause: (args: PauseArgs): string => { captured = args; return 'paused-1'; } };
    const workflow = pausedWorkflow();
    const engine = new WorkflowEngine(new InMemoryEventBus(), {
      nodeRegistry: [passthroughMod('src'), findStdlibNode('logic_wait_signal'), probeMod('probe')] as never[],
      pauseHandler,
    });
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('paused');
    expect(captured).toBeDefined();
    // Il probe NON è ancora girato e il ramo residuo porta la provenienza.
    expect(seen.get('probe')).toBeUndefined();
    expect(captured!.pendingQueue).toEqual([{ nodeId: 'P', carriedInput: ['a', 'b', 'c'], mapMode: 'auto', sourceNodeId: 'src' }]);
    return { engine, captured: captured!, workflow };
  }

  function snapshotFrom(captured: PauseArgs, withGraph: boolean): EngineSnapshot {
    return {
      runId: captured.runId,
      workflowId: captured.workflowId,
      tenantId: captured.tenantId,
      outputsById: new Map(captured.outputsById),
      visited: new Set(captured.visited),
      pendingQueue: captured.pendingQueue.slice(),
      ...(withGraph ? { itemGraph: new Map(captured.itemGraph) } : {}),
      stepsSoFar: [],
      errorCount: 0,
      startedAt: Date.now(),
    };
  }

  it('🚨 il PauseArgs porta il grafo e al resume il fan-out residuo risolve $(\'src\').item', async () => {
    const { engine, captured, workflow } = await runUntilPause();
    // Lo snapshot persistito include la vista item di src col suo contenuto.
    expect(captured.itemGraph.get('src')?.map((it) => it.json)).toEqual([
      { value: 'a' }, { value: 'b' }, { value: 'c' },
    ]);
    const result = await engine.resume(snapshotFrom(captured, true), workflow);
    expect(result.status).toBe('success');
    // Pre-persistenza questo dava [undefined × 3]: il grafo moriva con la pausa.
    expect(seen.get('probe')).toEqual(['a', 'b', 'c']);
  });

  it('snapshot LEGACY senza itemGraph (pre-4.2) → lineage assente onesto, nessun crash', async () => {
    const { engine, captured, workflow } = await runUntilPause();
    const result = await engine.resume(snapshotFrom(captured, false), workflow);
    expect(result.status).toBe('success');
    // .item è undefined → l'interpolazione del template lo stringifica in ''.
    expect(seen.get('probe')).toEqual(['', '', '']);
  });
});

describe('onestà semantica — dove il pairing NON è definito ritorna undefined', () => {
  it('nodo ROOT (nessuna sorgente): .item è undefined, nessun crash', async () => {
    const workflow = makeWorkflow(
      [{ id: 'probe', defId: 'probe', config: { probe: "{{ $('probe').item === undefined ? 'no-lineage' : 'BUG' }}" } }],
      [],
    );
    const engine = makeEngine(probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a'] });
    expect(result.status).toBe('success');
    expect(seen.get('probe')).toEqual(['no-lineage']);
  });

  it('nodo standard (no fan-out) dopo sorgente multi-item: .item = item 0 deterministico', async () => {
    const workflow = makeWorkflow(
      [
        { id: 'src', defId: 'src' },
        { id: 'probe', defId: 'probe', config: { probe: "{{ $('src').item.json.value }}" } },
      ],
      [{ from: 'src', to: 'probe' }],
    );
    const engine = makeEngine(passthroughMod('src'), probeMod('probe'));
    const result = await engine.run({ workflow, triggerInput: ['a', 'b', 'c'] });
    expect(result.status).toBe('success');
    // Fuori da un fan-out il nodo vede l'input INTERO: l'item corrente è
    // ancorato deterministicamente al primo (itemIndex 0) — mai casuale.
    expect(seen.get('probe')).toEqual(['a']);
  });
});
