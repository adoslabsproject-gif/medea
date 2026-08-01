/**
 * Test 2026-grade — GAP 4 esecuzione parziale: `stopAfterNodeId` nell'engine.
 *
 * Contratto: l'engine si ferma DOPO che il nodo target ha completato — i suoi
 * downstream NON girano, la coda residua è scartata, l'output del target resta
 * negli step. Con pinnedOutputs sugli antenati = "Esegui solo questo nodo".
 *
 * NON green-smoke: ogni test traccia QUALI executor girano davvero (spy per
 * nodo) — la proprietà è "il grafo a valle NON è stato eseguito", non solo
 * "il run è success".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from './workflow-engine.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import type { Workflow } from '@flowforge/core-schema';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';

function defOf(id: string): { id: string; label: string; kind: 'action'; category: string; inputs: string[]; outputs: string[]; configSchema: never } {
  return { id, label: id, kind: 'action', category: 'test', inputs: [], outputs: [], configSchema: {} as never };
}

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    schemaVersion: '1.0.0', id: 'wf-partial', name: 'Partial', enabled: true,
    nodes: [], edges: [], nodeDefs: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...partial,
  };
}

let executed: string[] = [];

/** Modulo sintetico: registra l'esecuzione e ritorna { ran: defId }. */
function mod(defId: string) {
  return {
    def: defOf(defId),
    executor: async (_c: unknown, input: unknown, _ctx: NodeExecutionContext) => {
      executed.push(defId);
      return { output: { ran: defId, got: input }, chosenBranch: undefined };
    },
  };
}

function makeEngine(...defIds: string[]): WorkflowEngine {
  return new WorkflowEngine(new InMemoryEventBus(), {
    nodeRegistry: defIds.map((d) => mod(d)) as never[],
  });
}

beforeEach(() => { executed = []; });

// Catena lineare a → b → c (node id === def id per leggibilità)
function linearWorkflow(): Workflow {
  return makeWorkflow({
    nodes: [
      { id: 'a', defId: 'a', x: 0, y: 0, config: {} },
      { id: 'b', defId: 'b', x: 1, y: 0, config: {} },
      { id: 'c', defId: 'c', x: 2, y: 0, config: {} },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  });
}

describe('🚨 stopAfterNodeId — il grafo a valle NON gira', () => {
  it('🚨 stop sul nodo centrale: a,b eseguiti, c MAI; status success', async () => {
    const result = await makeEngine('a', 'b', 'c').run({
      workflow: linearWorkflow(), triggerInput: {}, stopAfterNodeId: 'b',
    });
    expect(result.status).toBe('success');
    expect(executed).toEqual(['a', 'b']);
    expect(result.steps.map((s) => s.nodeId)).toEqual(['a', 'b']);
    // l'output del nodo target è presente (la UI lo mostra nel drawer)
    expect(JSON.parse(result.steps[1]!.output)).toMatchObject({ ran: 'b' });
  });

  it('🚨 senza stopAfterNodeId il comportamento resta INVARIATO (tutta la catena)', async () => {
    const result = await makeEngine('a', 'b', 'c').run({
      workflow: linearWorkflow(), triggerInput: {},
    });
    expect(result.status).toBe('success');
    expect(executed).toEqual(['a', 'b', 'c']);
  });

  it('🚨 "Esegui solo questo nodo": antenati PINNATI (non eseguiti) + stop sul target', async () => {
    // replay fromNode=b&toNode=b: a pinnato col suo output storico, b ri-eseguito, c mai
    const pins = new Map<string, unknown>([['a', { ran: 'a', historical: true }]]);
    const result = await makeEngine('a', 'b', 'c').run({
      workflow: linearWorkflow(), triggerInput: {}, pinnedOutputs: pins, stopAfterNodeId: 'b',
    });
    expect(result.status).toBe('success');
    expect(executed).toEqual(['b']); // SOLO il target ha eseguito codice vero
    // b ha ricevuto in input l'output pinnato di a (i dati storici/editati)
    const stepB = result.steps.find((s) => s.nodeId === 'b');
    expect(JSON.parse(stepB!.output)).toMatchObject({ got: { ran: 'a', historical: true } });
  });

  it('🚨 stop su un ramo: il fan-out fratello GIÀ accodato non gira (coda scartata)', async () => {
    // a → b, a → d (fan-out): stopAfter=b deve scartare anche d se non ancora processato
    const wf = makeWorkflow({
      nodes: [
        { id: 'a', defId: 'a', x: 0, y: 0, config: {} },
        { id: 'b', defId: 'b', x: 1, y: 0, config: {} },
        { id: 'd', defId: 'd', x: 1, y: 1, config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'd' }],
    });
    await makeEngine('a', 'b', 'd').run({ workflow: wf, triggerInput: {}, stopAfterNodeId: 'b' });
    expect(executed).toEqual(['a', 'b']); // d era in coda ma è stato scartato
  });

  it('stopAfterNodeId mai raggiunto (altro ramo morto) → run completa normale', async () => {
    // 'z' esiste nel registry ma non è nel grafo raggiungibile → nessuno stop
    const result = await makeEngine('a', 'b', 'c', 'z').run({
      workflow: linearWorkflow(), triggerInput: {}, stopAfterNodeId: 'z',
    });
    expect(result.status).toBe('success');
    expect(executed).toEqual(['a', 'b', 'c']);
  });

  it('🚨 stop su un nodo LOGIC_LOOP: body itera, il ramo done NON gira (check sul ramo loop)', async () => {
    // Registry DEFAULT (stdlib reale): il ramo logic_loop in executeFromQueue fa
    // `continue` e salta il check di fine-body — qui copriamo il check dedicato.
    const engine = new WorkflowEngine(new InMemoryEventBus());
    const workflow = makeWorkflow({
      nodes: [
        { id: 'trig', defId: 'trigger_manual', x: 0, y: 0, config: {} },
        { id: 'loop', defId: 'logic_loop', x: 1, y: 0, config: { itemsExpression: 'input.items', strategy: 'naive' } },
        { id: 'body', defId: 'logic_delay', x: 2, y: 0, config: { durationMs: '1' } },
        { id: 'after', defId: 'logic_delay', x: 3, y: 0, config: { durationMs: '1' } },
      ],
      edges: [
        { from: 'trig', to: 'loop' },
        { from: 'loop', to: 'body', fromPort: 'body' },
        { from: 'loop', to: 'after', fromPort: 'done' },
      ],
    });
    const result = await engine.run({
      workflow, triggerInput: { items: ['a', 'b'] }, stopAfterNodeId: 'loop',
    });
    expect(result.status).toBe('success');
    const nodeIds = result.steps.map((s) => s.nodeId);
    expect(nodeIds.filter((id) => id === 'body')).toHaveLength(2); // il loop ha iterato
    expect(nodeIds).not.toContain('after'); // il ramo done è stato fermato
  });
});
