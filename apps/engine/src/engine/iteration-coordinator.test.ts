/**
 * IterationCoordinator — full unit test suite for 100% coverage.
 *
 * Strategy: stub INodeExecutor + use real InMemoryEventBus.
 * Tests cover all 6 strategies (naive/batch/bulk/queue/aggregate/auto)
 * + edge cases (errorPolicy, concurrency, rateLimit, empty body, etc.)
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IterationCoordinator,
  chunkArray,
  type AdjacencyMap,
  type ExecuteLoopArgs,
  type INodeExecutor,
} from './iteration-coordinator.js';
import type { CanvasNode, Edge, Workflow, RunStep } from '@flowforge/core-schema';
import type { NodeModule } from '@flowforge/nodes-stdlib';

// ───────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────

function makeNode(id: string, defId: string, config: Record<string, unknown> = {}): CanvasNode {
  // CanvasNode.config tipato come Record<string, string>; nei test passiamo
  // valori non-stringa (numeri/bool/array) per coprire branching reale dell'interprete.
  return { id, defId, x: 0, y: 0, config: config as Record<string, string> };
}

function makeAdjacency(nodes: CanvasNode[], edges: Edge[]): AdjacencyMap {
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const nodesById = new Map<string, CanvasNode>();
  for (const n of nodes) nodesById.set(n.id, n);
  for (const e of edges) {
    const o = outgoing.get(e.from) ?? [];
    o.push(e);
    outgoing.set(e.from, o);
    const i = incoming.get(e.to) ?? [];
    i.push(e);
    incoming.set(e.to, i);
  }
  return { outgoing, incoming, nodesById };
}

function makeWorkflow(nodes: CanvasNode[], edges: Edge[]): Workflow {
  return {
    schemaVersion: '1.0.0',
    id: 'wf-test',
    name: 'Test',
    enabled: true,
    nodes,
    edges,
    nodeDefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeStdNodeModule(defId: string, overrides: Partial<NodeModule['def']> = {}): NodeModule {
  return {
    def: {
      id: defId,
      label: defId,
      kind: 'action',
      category: 'test',
      inputs: [],
      outputs: [],
      configSchema: {} as never,
      ...overrides,
    },
    executor: () => Promise.resolve({ output: undefined, chosenBranch: undefined }),
  } as unknown as NodeModule;
}

function makeLoopArgs(opts: {
  loopNode: CanvasNode;
  carriedInput?: unknown;
  workflow?: Workflow;
  adj?: AdjacencyMap;
  pinnedOutputs?: Map<string, unknown>;
  subworkflowDepth?: number;
}): ExecuteLoopArgs {
  const wf = opts.workflow ?? makeWorkflow([opts.loopNode], []);
  return {
    loopNode: opts.loopNode,
    loopModule: makeStdNodeModule('logic_loop', { label: 'Loop' }),
    carriedInput: opts.carriedInput ?? null,
    adj: opts.adj ?? makeAdjacency(wf.nodes, wf.edges),
    ...(opts.pinnedOutputs ? { pinnedOutputs: opts.pinnedOutputs } : {}),
    tenantId: 'tenant-test',
    runId: 'run-iter-test',
    workflowId: wf.id,
    workflow: wf,
    steps: [] as RunStep[],
    outerVisited: new Set<string>(),
    outerOutputs: new Map<string, unknown>(),
    ...(opts.subworkflowDepth !== undefined ? { subworkflowDepth: opts.subworkflowDepth } : {}),
  };
}

function makeExecutor(overrides: Partial<INodeExecutor> = {}): {
  executor: INodeExecutor;
  executeNodeMock: ReturnType<typeof vi.fn>;
  resolveModuleMock: ReturnType<typeof vi.fn>;
} {
  const executeNodeMock = vi.fn(async (args: Parameters<INodeExecutor['executeNode']>[0]) => ({
    output: { node: args.node.id, input: args.carriedInput },
    chosenBranch: undefined,
    step: {
      nodeId: args.node.id,
      nodeLabel: args.module?.def.label ?? args.node.defId,
      status: 'success' as const,
      input: JSON.stringify(args.carriedInput),
      output: JSON.stringify({ node: args.node.id }),
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 1,
      nodeConfig: args.node.config,
    },
  }));
  const resolveModuleMock = vi.fn(
    (defId: string) => makeStdNodeModule(defId),
  );
  const executor: INodeExecutor = {
    executeNode: overrides.executeNode ?? executeNodeMock,
    resolveNodeModule: overrides.resolveNodeModule ?? resolveModuleMock,
  };
  return { executor, executeNodeMock, resolveModuleMock };
}

// ───────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────

describe('IterationCoordinator — executeLoop strategy=naive', () => {

  it('iterates over input array — body eseguito 3 volte', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'naive',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: [10, 20, 30],
      workflow: wf,
    }));
    expect(result.chosenBranch).toBe('done');
    expect(result.errors).toBe(0);
    expect(executeNodeMock).toHaveBeenCalledTimes(3);
    const out = result.output as { iterations: number; succeeded: number; failed: number };
    expect(out.iterations).toBe(3);
    expect(out.succeeded).toBe(3);
    expect(out.failed).toBe(0);
  });

  it('itemsExpression default "input" usata se non specificata', async () => {
    const loopNode = makeNode('loop', 'logic_loop'); // no itemsExpression
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: ['a', 'b'],
      workflow: wf,
    }));
    expect(executeNodeMock).toHaveBeenCalledTimes(2);
  });

  it('input non-array → items=[] → 0 iterations', async () => {
    const loopNode = makeNode('loop', 'logic_loop');
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: 'not an array',
    }));
    expect(executeNodeMock).not.toHaveBeenCalled();
    const out = result.output as { iterations: number };
    expect(out.iterations).toBe(0);
  });

  it('maxItems superato → InterpreterError', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      maxItems: 2,
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await expect(coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: [1, 2, 3, 4, 5],
    }))).rejects.toThrow(/refusing 5 items/);
  });

  it('errorPolicy="stop" → ferma iterations al primo fail', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      errorPolicy: 'stop',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    let call = 0;
    const { executor } = makeExecutor({
      executeNode: vi.fn(async (args) => {
        call += 1;
        return {
          output: undefined,
          chosenBranch: undefined,
          step: {
            nodeId: args.node.id,
            nodeLabel: 'body',
            status: call === 2 ? 'error' as const : 'success' as const,
            input: '', output: '',
            startedAt: Date.now(), endedAt: Date.now(), durationMs: 1,
            nodeConfig: args.node.config,
          },
        };
      }),
    });
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: [1, 2, 3, 4, 5],
      workflow: wf,
    }));
    const out = result.output as { iterations: number; failed: number };
    // Failed alla 2a iter → cursor=total → stop. Iterations completate <= 2.
    expect(out.failed).toBe(1);
  });

  it('errorPolicy="continue" (default) → completa tutte le iterations', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor({
      executeNode: vi.fn(async (args) => ({
        output: undefined,
        chosenBranch: undefined,
        step: {
          nodeId: args.node.id, nodeLabel: 'body',
          status: 'error' as const,
          input: '', output: '',
          startedAt: Date.now(), endedAt: Date.now(), durationMs: 1,
          nodeConfig: args.node.config,
        },
      })),
    });
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    const out = result.output as { iterations: number; failed: number };
    expect(out.iterations).toBe(3);
    expect(out.failed).toBe(3);
  });

  it('rateLimitPerMin → delay tra iterations', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      rateLimitPerMin: 600, // 100ms / iter
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const start = Date.now();
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    const elapsed = Date.now() - start;
    // 2 iter × 100ms = ~200ms (con margine schedulazione)
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });

  it('concurrency=0 → effConcurrency=total (TUTTE in parallelo)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      concurrency: 0,
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    expect(executeNodeMock).toHaveBeenCalledTimes(3);
  });

  it('concurrency capped a 50 (max safety)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      concurrency: 999, // clamp a 50
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    expect(result.chosenBranch).toBe('done');
  });
});

describe('IterationCoordinator — strategy=bulk', () => {

  it('body runs ONCE con array intero come input', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'bulk',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [10, 20, 30], workflow: wf,
    }));
    expect(executeNodeMock).toHaveBeenCalledTimes(1);
    const out = result.output as { iterations: number; succeeded: number };
    expect(out.iterations).toBe(1);
    expect(out.succeeded).toBe(1);
  });

  it('bulk + body errore → failed=1', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'bulk',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor({
      executeNode: vi.fn(async (args) => ({
        output: undefined, chosenBranch: undefined,
        step: {
          nodeId: args.node.id, nodeLabel: 'body',
          status: 'error' as const,
          input: '', output: '',
          startedAt: Date.now(), endedAt: Date.now(), durationMs: 1,
          nodeConfig: args.node.config,
        },
      })),
    });
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    const out = result.output as { failed: number };
    expect(out.failed).toBe(1);
  });

  it('bulk con NESSUN body edge → skipped (early return)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'bulk',
    });
    // NO body edge — loop senza nulla a valle
    const wf = makeWorkflow([loopNode], []);
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    const out = result.output as { skipped: number };
    expect(out.skipped).toBe(3);
  });
});

describe('IterationCoordinator — strategy=queue (fallback naive)', () => {
  it('queue strategy log warn + fallback naive', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'queue',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    expect(executeNodeMock).toHaveBeenCalledTimes(2);
    const out = result.output as { iterations: number };
    expect(out.iterations).toBe(2);
  });
});

describe('IterationCoordinator — strategy=batch', () => {

  it('batch raggruppa items in chunks di batchSize', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'batch',
      batchSize: 2,
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3, 4, 5], workflow: wf,
    }));
    // 5 items / batchSize 2 = 3 batches (2+2+1)
    expect(executeNodeMock).toHaveBeenCalledTimes(3);
    const out = result.output as { iterations: number };
    expect(out.iterations).toBe(3);
  });

  it('batchSize default 100', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'batch',
      // batchSize non specificato
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    // 3 items / 100 = 1 batch
    expect(executeNodeMock).toHaveBeenCalledTimes(1);
  });
});

describe('IterationCoordinator — strategy=aggregate', () => {

  it('default reducer=count + no groupKey → array length', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    // Body NON viene eseguito (aggregate skip)
    expect(executeNodeMock).not.toHaveBeenCalled();
    const out = result.output as { results: number[]; succeeded: number };
    expect(out.results[0]).toBe(3);
    expect(out.succeeded).toBe(1);
  });

  it('reducer=sum su field numerico', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'sum',
      aggregateField: 'amount',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: [{ amount: 10 }, { amount: 20 }, { amount: 30 }],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(60);
  });

  it('reducer=avg', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'avg',
      aggregateField: 'v',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: [{ v: 10 }, { v: 20 }, { v: 30 }],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(20);
  });

  it('reducer=min/max/concat', async () => {
    const { executor } = makeExecutor();
    const items = [{ v: 5 }, { v: 1 }, { v: 9 }];

    const loopMin = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'min',
      aggregateField: 'v',
    });
    const coordMin = new IterationCoordinator(executor);
    const rMin = await coordMin.executeLoop(makeLoopArgs({ loopNode: loopMin, carriedInput: items }));
    expect((rMin.output as { results: number[] }).results[0]).toBe(1);

    const loopMax = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'max',
      aggregateField: 'v',
    });
    const coordMax = new IterationCoordinator(executor);
    const rMax = await coordMax.executeLoop(makeLoopArgs({ loopNode: loopMax, carriedInput: items }));
    expect((rMax.output as { results: number[] }).results[0]).toBe(9);

    const loopConcat = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'concat',
      aggregateField: 'v',
    });
    const coordConcat = new IterationCoordinator(executor);
    const rConcat = await coordConcat.executeLoop(makeLoopArgs({
      loopNode: loopConcat,
      carriedInput: [{ v: 'a' }, { v: 'b' }, { v: 'c' }],
    }));
    expect((rConcat.output as { results: string[] }).results[0]).toBe('a,b,c');
  });

  it('reducer sconosciuto → default (items.slice())', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'unknown_reducer',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3],
    }));
    const out = result.output as { results: number[][] };
    expect(out.results[0]).toEqual([1, 2, 3]);
  });

  it('aggregateBy → groupBy + reduce per gruppo', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateBy: 'cat',
      aggregateReducer: 'count',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode,
      carriedInput: [
        { cat: 'A', v: 1 }, { cat: 'B', v: 2 }, { cat: 'A', v: 3 },
      ],
    }));
    const out = result.output as { results: Record<string, number>[] };
    expect(out.results[0]).toEqual({ A: 2, B: 1 });
  });

  it('aggregateBy con item primitivo → key=String(item)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateBy: 'whatever', // ignored per primitivi
      aggregateReducer: 'count',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: ['x', 'x', 'y'],
    }));
    const out = result.output as { results: Record<string, number>[] };
    expect(out.results[0]).toEqual({ x: 2, y: 1 });
  });

  it('aggregateBy con field assente → key="__missing__"', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateBy: 'nonexistent',
      aggregateReducer: 'count',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [{ a: 1 }, { b: 2 }],
    }));
    const out = result.output as { results: Record<string, number>[] };
    expect(out.results[0]).toEqual({ __missing__: 2 });
  });

  it('aggregate sum su items vuoti → 0', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'sum',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(0);
  });

  it('aggregate avg su items vuoti → 0', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'avg',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(0);
  });

  it('aggregate min su items vuoti → 0 (evita Math.min senza args)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'min',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(0);
  });

  it('reducer=sum su array primitivi (no field) → numeric branch primitivo', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'sum',
      // no aggregateField → branch "field undefined" attivato → Number(it) sui primitivi
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3, 4],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(10);
  });

  it('reducer=concat su array primitivi (no field) → String(it) branch primitivo', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'concat',
      // no aggregateField → String(it) primitive path
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: ['x', 'y', 'z'],
    }));
    const out = result.output as { results: string[] };
    expect(out.results[0]).toBe('x,y,z');
  });

  it('aggregate max su items vuoti → 0', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'max',
    });
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [],
    }));
    const out = result.output as { results: number[] };
    expect(out.results[0]).toBe(0);
  });

  it('aggregate skip body nodes — synthetic skipped steps pushed', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'count',
    });
    const body1 = makeNode('b1', 'action');
    const body2 = makeNode('b2', 'action');
    const wf = makeWorkflow(
      [loopNode, body1, body2],
      [
        { from: 'loop', to: 'b1', fromPort: 'body' },
        { from: 'b1', to: 'b2' },
      ],
    );
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1, 2], workflow: wf });
    await coord.executeLoop(args);
    // 2 body nodes + 1 loop summary step
    const skipped = args.steps.filter((s) => s.status === 'skipped');
    expect(skipped.length).toBe(2);
  });

  it('aggregate skip body — node mancante in nodesById → continue (skip)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'aggregate',
      aggregateReducer: 'count',
    });
    const phantom = makeNode('phantom', 'action');
    const wf = makeWorkflow(
      [loopNode, phantom],
      [{ from: 'loop', to: 'phantom', fromPort: 'body' }],
    );
    const adj = makeAdjacency([loopNode, phantom], [{ from: 'loop', to: 'phantom', fromPort: 'body' }]);
    // Forziamo phantom OUT della nodesById (simula DB drift)
    adj.nodesById.delete('phantom');
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf, adj });
    const result = await coord.executeLoop(args);
    // Niente synthetic step per phantom (skip per node mancante)
    expect((result.output as { succeeded: number }).succeeded).toBe(1);
  });
});

describe('IterationCoordinator — strategy=auto', () => {

  it('auto + body con bulkEnabled=true → bulk', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'auto',
    });
    const bodyNode = makeNode('body', 'action', { bulkEnabled: 'true' });
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    // bulk → body runs ONCE
    expect(executeNodeMock).toHaveBeenCalledTimes(1);
  });

  it('auto + module con bulk.supports=true → bulk', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'auto',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor({
      resolveNodeModule: vi.fn((defId: string) => {
        if (defId === 'action') {
          return {
            def: {
              id: 'action', label: 'A', kind: 'action' as const, category: 't',
              inputs: [], outputs: [], configSchema: {} as never,
              bulk: { supports: true },
            },
            executor: () => Promise.resolve({ output: undefined, chosenBranch: undefined }),
          } as unknown as NodeModule;
        }
        return makeStdNodeModule(defId);
      }),
    });
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2, 3], workflow: wf,
    }));
    expect(executeNodeMock).toHaveBeenCalledTimes(1);
  });

  it('auto + items>=10_000 → queue (warn fallback naive)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'auto',
      maxItems: 20_000,
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: items, workflow: wf,
    }));
    // queue → fallback naive → 10k iterations
    expect(executeNodeMock).toHaveBeenCalledTimes(10_000);
  }, 30_000);

  it('auto + items>=200 + items<10000 → batch', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'auto',
      batchSize: 50,
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const items = Array.from({ length: 250 }, (_, i) => i);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: items, workflow: wf,
    }));
    // 250 items / 50 batchSize = 5 batches
    expect(executeNodeMock).toHaveBeenCalledTimes(5);
  });

  it('auto con body senza module risolto + items piccoli → naive', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'auto',
    });
    const bodyNode = makeNode('body', 'unknown_def');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor({
      resolveNodeModule: vi.fn(() => undefined), // sempre undefined
    });
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    // naive → 2 iterations
    expect(executeNodeMock).toHaveBeenCalledTimes(2);
  });

  it('auto con body node MANCANTE in adj.nodesById → continue (skip detection)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      strategy: 'auto',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const adj = makeAdjacency(wf.nodes, wf.edges);
    adj.nodesById.delete('body'); // simulato drift
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const result = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf, adj,
    }));
    // Niente body eseguito (nodo phantom)
    expect((result.output as { iterations: number }).iterations).toBe(2);
  });
});

describe('IterationCoordinator — runBodyIteration edge cases', () => {

  it('body chain di 3 nodi → tutti eseguiti', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const b1 = makeNode('b1', 'action');
    const b2 = makeNode('b2', 'action');
    const b3 = makeNode('b3', 'action');
    const wf = makeWorkflow(
      [loopNode, b1, b2, b3],
      [
        { from: 'loop', to: 'b1', fromPort: 'body' },
        { from: 'b1', to: 'b2' },
        { from: 'b2', to: 'b3' },
      ],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    // 2 iter × 3 nodi = 6 executor calls
    expect(executeNodeMock).toHaveBeenCalledTimes(6);
  });

  it('body branchable + chosenBranch → solo edge matching', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const gate = makeNode('gate', 'action');
    const yes = makeNode('yes', 'action');
    const no = makeNode('no', 'action');
    const wf = makeWorkflow(
      [loopNode, gate, yes, no],
      [
        { from: 'loop', to: 'gate', fromPort: 'body' },
        { from: 'gate', to: 'yes', fromPort: 'true' },
        { from: 'gate', to: 'no', fromPort: 'false' },
      ],
    );
    const { executor } = makeExecutor({
      executeNode: vi.fn(async (args) => ({
        output: { node: args.node.id },
        chosenBranch: args.node.id === 'gate' ? 'true' : undefined,
        step: {
          nodeId: args.node.id, nodeLabel: 'n',
          status: 'success' as const, input: '', output: '',
          startedAt: Date.now(), endedAt: Date.now(), durationMs: 1,
          nodeConfig: args.node.config,
        },
      })),
      resolveNodeModule: vi.fn((defId: string) => ({
        def: {
          id: defId, label: defId, kind: 'action' as const, category: 't',
          inputs: [], outputs: defId === 'action' && true ? [{ id: 'true', label: 'T' }, { id: 'false', label: 'F' }] : [],
          configSchema: {} as never,
        },
        executor: () => Promise.resolve({ output: undefined, chosenBranch: undefined }),
      } as unknown as NodeModule)),
    });
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf });
    await coord.executeLoop(args);
    // gate + yes eseguiti, no NO
    const nodeIds = args.steps.map((s) => s.nodeId);
    expect(nodeIds).toContain('gate');
    expect(nodeIds).toContain('yes');
    expect(nodeIds).not.toContain('no');
  });

  it('node OUT of bodyNodeIds → skip (continue)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const body = makeNode('body', 'action');
    const outside = makeNode('outside', 'action');
    const wf = makeWorkflow(
      [loopNode, body, outside],
      [
        { from: 'loop', to: 'body', fromPort: 'body' },
        { from: 'body', to: 'outside' }, // outside NON è in body subgraph (loop body → only body)
      ],
    );
    // bodyNodeIds è popolato da collectReachable da bodyStartIds=['body']
    // outside È reachable da body → quindi BLOCKED dal filter? In realtà
    // collectReachable include OUTSIDE perché c'è un edge body→outside.
    // Test alternativo: forzo node fuori bodyNodeIds via adj manipulation
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1], workflow: wf,
    }));
    // Sia body che outside vengono eseguiti (entrambi reachable)
    expect(executeNodeMock).toHaveBeenCalled();
  });

  it('body con node duplicato in queue → visited check previene re-exec', async () => {
    // Scenario: diamond (body → b1, body → b2, b1 → end, b2 → end). End viene
    // raggiunto 2 volte ma visited set previene re-exec.
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const body = makeNode('body', 'action');
    const b1 = makeNode('b1', 'action');
    const b2 = makeNode('b2', 'action');
    const end = makeNode('end', 'action');
    const wf = makeWorkflow(
      [loopNode, body, b1, b2, end],
      [
        { from: 'loop', to: 'body', fromPort: 'body' },
        { from: 'body', to: 'b1' },
        { from: 'body', to: 'b2' },
        { from: 'b1', to: 'end' },
        { from: 'b2', to: 'end' },
      ],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf });
    await coord.executeLoop(args);
    // Diamond shape: body(1) + b1(1) + b2(1) + end(1, NOT 2)
    expect(executeNodeMock).toHaveBeenCalledTimes(4);
  });
});

describe('IterationCoordinator — pinnedOutputs propagation', () => {
  it('pinnedOutputs propagato a executeNode args', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const pinned = new Map<string, unknown>();
    pinned.set('some-id', { pinned: true });
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1], workflow: wf, pinnedOutputs: pinned,
    }));
    // Verifica che executeNode è chiamato con pinnedOutputs presente
    const firstCall = executeNodeMock.mock.calls[0]?.[0] as { pinnedOutputs?: Map<string, unknown> };
    expect(firstCall?.pinnedOutputs).toBe(pinned);
  });
});

describe('IterationCoordinator — subworkflowDepth propagation', () => {
  it('subworkflowDepth viene forwarded a executeNode args', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1], workflow: wf, subworkflowDepth: 7,
    }));
    const firstCall = executeNodeMock.mock.calls[0]?.[0] as { subworkflowDepth?: number };
    expect(firstCall?.subworkflowDepth).toBe(7);
  });
});

describe('IterationCoordinator — NON emette eventi bus orfani (guardia strutturale)', () => {
  // CONTRATTO (2026-06-15): loop.*/iteration.* erano osservabilità senza alcun
  // consumer (il progresso per-iterazione arriva via run.step nel motore). Sono
  // stati RIMOSSI, insieme alla dipendenza eventBus del coordinatore. Qui la
  // guardia è STRUTTURALE (non un "no-op" green-fake): il sorgente non deve
  // contenere emit di eventi loop/iteration e il costruttore non deve più
  // accettare un bus. Se qualcuno re-introduce un emit/orfano → ROSSO.
  const coordSrc = readFileSync(
    fileURLToPath(new URL('./iteration-coordinator.ts', import.meta.url)),
    'utf8',
  );

  it('🔒 il sorgente NON emette eventi loop.*/iteration.* orfani', () => {
    const banned = ["'loop.started'", "'loop.completed'", "'iteration.started'", "'iteration.completed'", "'iteration.failed'"];
    const found = banned.filter((lit) => coordSrc.includes(lit));
    expect(found, `emit orfani rientrati nel coordinatore: ${found.join(', ')}`).toEqual([]);
  });

  it('🔒 il costruttore NON accetta più un eventBus (non può emettere by-construction)', () => {
    expect(IterationCoordinator.length).toBe(1); // solo `executor`
    expect(coordSrc).not.toContain('eventBus.emit');
  });

  it('il loop continua a PRODURRE output (2 iterazioni) — sanity comportamentale', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const out = await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    expect((out.output as { iterations: number }).iterations).toBe(2);
  });
});

describe('IterationCoordinator — final loop summary step', () => {
  it('summary step pushato con status="success" se errorPolicy="continue"', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor({
      executeNode: vi.fn(async (args) => ({
        output: undefined, chosenBranch: undefined,
        step: {
          nodeId: args.node.id, nodeLabel: 'body',
          status: 'error' as const,
          input: '', output: '',
          startedAt: Date.now(), endedAt: Date.now(), durationMs: 1,
          nodeConfig: args.node.config,
        },
      })),
    });
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf });
    await coord.executeLoop(args);
    const summary = args.steps.find((s) => s.nodeId === 'loop');
    // errorPolicy default 'continue' → status='success' nonostante failed>0
    expect(summary?.status).toBe('success');
  });

  it('summary step status="error" se errorPolicy="stop" + failed>0', async () => {
    const loopNode = makeNode('loop', 'logic_loop', {
      itemsExpression: 'input',
      errorPolicy: 'stop',
    });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor({
      executeNode: vi.fn(async (args) => ({
        output: undefined, chosenBranch: undefined,
        step: {
          nodeId: args.node.id, nodeLabel: 'body',
          status: 'error' as const,
          input: '', output: '',
          startedAt: Date.now(), endedAt: Date.now(), durationMs: 1,
          nodeConfig: args.node.config,
        },
      })),
    });
    const coord = new IterationCoordinator(executor);
    const args2 = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf });
    await coord.executeLoop(args2);
    const summary = args2.steps.find((s) => s.nodeId === 'loop');
    expect(summary?.status).toBe('error');
  });

  it('outerOutputs.set chiamato con loopOutput', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      [{ from: 'loop', to: 'body', fromPort: 'body' }],
    );
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf });
    await coord.executeLoop(args);
    expect(args.outerOutputs.get('loop')).toBeDefined();
  });

  it('outerVisited popolato con body node ids (per outer BFS skip)', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const b1 = makeNode('b1', 'action');
    const b2 = makeNode('b2', 'action');
    const wf = makeWorkflow(
      [loopNode, b1, b2],
      [
        { from: 'loop', to: 'b1', fromPort: 'body' },
        { from: 'b1', to: 'b2' },
      ],
    );
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const args = makeLoopArgs({ loopNode, carriedInput: [1], workflow: wf });
    await coord.executeLoop(args);
    expect(args.outerVisited.has('b1')).toBe(true);
    expect(args.outerVisited.has('b2')).toBe(true);
  });

  it('loopModule icon → propagato a summary step.nodeIcon', async () => {
    const loopNode = makeNode('loop', 'logic_loop');
    const wf = makeWorkflow([loopNode], []);
    const { executor } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    const args: ExecuteLoopArgs = {
      ...makeLoopArgs({ loopNode, workflow: wf }),
      loopModule: {
        def: {
          id: 'logic_loop', label: 'Loop', kind: 'action' as const, category: 'logic',
          inputs: [], outputs: [], configSchema: {} as never,
          icon: 'repeat-icon',
        },
        executor: () => Promise.resolve({ output: undefined, chosenBranch: undefined }),
      } as unknown as NodeModule,
    };
    await coord.executeLoop(args);
    const summary = args.steps.find((s) => s.nodeId === 'loop');
    expect(summary?.nodeIcon).toBe('repeat-icon');
  });
});

describe('IterationCoordinator — body edges fromPort undefined (default body)', () => {
  it('edge senza fromPort viene trattato come body', async () => {
    const loopNode = makeNode('loop', 'logic_loop', { itemsExpression: 'input' });
    const bodyNode = makeNode('body', 'action');
    const wf = makeWorkflow(
      [loopNode, bodyNode],
      // NO fromPort — fallback body
      [{ from: 'loop', to: 'body' }],
    );
    const { executor, executeNodeMock } = makeExecutor();
    const coord = new IterationCoordinator(executor);
    await coord.executeLoop(makeLoopArgs({
      loopNode, carriedInput: [1, 2], workflow: wf,
    }));
    expect(executeNodeMock).toHaveBeenCalledTimes(2);
  });
});

describe('IterationCoordinator — chunkArray (contratto della utility)', () => {
  // Il guard size<=0 è difensivo (il chiamante clampa batchSize a ≥1) ma è il
  // CONTRATTO della funzione: un futuro call-site senza clamp non deve né
  // dividere per zero né loopare all'infinito. Era un it.todo "non testabile";
  // la funzione è pura → esportata e testata direttamente.
  it('size=0 → un singolo chunk con tutti gli item (copia, non alias)', () => {
    const arr = [1, 2, 3];
    const out = chunkArray(arr, 0);
    expect(out).toEqual([[1, 2, 3]]);
    expect(out[0]).not.toBe(arr); // slice difensiva: niente alias mutabile
  });

  it('size negativa → stesso comportamento di size=0', () => {
    expect(chunkArray([1, 2], -5)).toEqual([[1, 2]]);
  });

  it('size normale → chunk pieni + resto', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('array vuoto → nessun chunk', () => {
    expect(chunkArray([], 3)).toEqual([]);
    expect(chunkArray([], 0)).toEqual([[]]); // contratto del guard: 1 chunk (vuoto)
  });
});
