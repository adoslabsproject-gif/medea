/**
 * IterationCoordinator — strategy-based loop execution.
 *
 * The engine delegates `logic_loop` nodes to this class. Five strategies
 * are supported (see logic_loop NodeDef for the user-facing description):
 *
 *   naive     — one item at a time, body re-runs N times serially
 *   batch     — items grouped into chunks of `batchSize`
 *   bulk      — body runs ONCE with the entire array
 *   queue     — async via BullMQ (currently falls back to naive — see below)
 *   aggregate — body NOT executed; the array is grouped + reduced
 *   auto      — engine picks one of {naive, batch, bulk, queue} based on
 *               array size and downstream node capabilities (NodeDef.bulk)
 *
 * Design constraints:
 *   • Per-iteration `outputsById` is isolated — iter 2 never sees iter 1.
 *   • Body sub-graph is pre-marked as visited in the outer BFS so the
 *     main engine doesn't double-execute body nodes after the loop.
 *   • Convergence with the engine: the coordinator delegates node
 *     execution to `INodeExecutor` (the engine itself implements it),
 *     avoiding circular imports and keeping the engine the source of
 *     truth for retry / branching / event emission.
 *
 * Threading model: single-threaded JS. `concurrency > 1` uses a worker
 * pool of in-process promises (no actual threads).
 */

import { coerceString } from '@/lib/coerce.js';
import type { CanvasNode, Edge, Workflow, RunStep } from '@flowforge/core-schema';
import type { NodeModule } from '@flowforge/nodes-stdlib';
import { evaluateExpression, interpolateConfig, InterpreterError, type LoopContext } from './interpreter.js';
import type { NodeLineageArgs } from './item-model.js';
import { logger } from '@/lib/logger.js';

/** Adjacency view of a workflow — read-only, shared with the engine. */
export interface AdjacencyMap {
  outgoing: Map<string, Edge[]>;
  incoming: Map<string, Edge[]>;
  nodesById: Map<string, CanvasNode>;
}

/**
 * The IterationCoordinator's contract with the engine: "give me a way
 * to execute a single node and to resolve a NodeModule by defId; I do
 * the rest." Keeps the two classes decoupled.
 */
export interface INodeExecutor {
  /** Resolve a node module by its defId. Returns undefined if unknown. */
  resolveNodeModule(defId: string): NodeModule | undefined;
  /** Execute a single node with the given carriedInput and loop context. */
  executeNode(args: {
    node: CanvasNode;
    module: NodeModule | undefined;
    carriedInput: unknown;
    outputsById: Map<string, unknown>;
    pinnedOutputs?: Map<string, unknown>;
    tenantId: string;
    runId: string;
    workflowId: string;
    loop?: LoopContext;
    /** N17 audit: subworkflow recursion depth forwarded to executor context. */
    subworkflowDepth?: number;
    /** GAP #2 (paired items): lineage bits — vedi ExecuteNodeArgs.lineage. */
    lineage?: NodeLineageArgs;
  }): Promise<{ output: unknown; chosenBranch: string | undefined; step: RunStep }>;
}

export interface ExecuteLoopArgs {
  loopNode: CanvasNode;
  loopModule: NodeModule;
  carriedInput: unknown;
  adj: AdjacencyMap;
  pinnedOutputs?: Map<string, unknown>;
  tenantId: string;
  runId: string;
  workflowId: string;
  workflow: Workflow;
  /** Mutable: steps emitted during loop execution are appended here. */
  steps: RunStep[];
  /** Mutable: body node ids are added so the outer BFS skips them. */
  outerVisited: Set<string>;
  /** Mutable: loop summary output is set under loopNode.id. */
  outerOutputs: Map<string, unknown>;
  /** N17 audit: forwarded into nested executeNode calls for subworkflow nodes inside loop bodies. */
  subworkflowDepth?: number;
  /**
   * GAP #2 (paired items): lineage bits del BFS esterno. `sourceNodeId` è la
   * sorgente dell'INPUT del loop. Dentro il body, l'item dell'iterazione i È
   * l'item i di quella sorgente — ma SOLO quando l'array iterato è l'input
   * stesso (`itemsExpression === 'input'`) e per le strategy in cui
   * `loop.index` indicizza un ITEM (naive/bulk): con `batch` l'indice è del
   * CHUNK → ancorarlo sarebbe lineage falso, quindi viene omesso.
   */
  lineage?: NodeLineageArgs;
}

export interface LoopExecutionResult {
  output: unknown;
  chosenBranch: string;
  errors: number;
}

export class IterationCoordinator {
  // NB (2026-06-15): rimosso il param `eventBus` — il coordinatore non emette
  // più eventi bus (loop.*/iteration.* erano orfani, vedi event-bus.ts). Il
  // progresso per-iterazione è osservabile via run.step emesso dal motore.
  constructor(private readonly executor: INodeExecutor) {}

  /**
   * Main entry — called by the engine when it encounters a logic_loop node.
   * Returns the loop's aggregate output (forwarded on the `done` branch)
   * and the number of iteration errors encountered.
   */
  async executeLoop(args: ExecuteLoopArgs): Promise<LoopExecutionResult> {
    const startedAt = Date.now();
    const scope = {
      input: args.carriedInput,
      ctx: { tenantId: args.tenantId, runId: args.runId, workflowId: args.workflowId, nodeId: args.loopNode.id },
      vars: Object.fromEntries(args.outerOutputs),
    };
    const interpolated = interpolateConfig(args.loopNode.config, scope);

    const itemsExpr = coerceString(interpolated.itemsExpression ?? 'input');
    // GAP #2: il lineage del body vale SOLO se l'array iterato è l'INPUT del
    // loop (gli indici i riferiscono la vista item della sorgente). Con una
    // itemsExpression arbitraria gli indici non riferiscono nessun nodo →
    // nessun ancoraggio (onesto, mai lineage inventato).
    const bodyLineage = itemsExpr === 'input' ? args.lineage : undefined;
    const rawItems = evaluateExpression(itemsExpr, scope);
    const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];
    const maxItems = Math.max(1, Number(interpolated.maxItems ?? 100_000));
    if (items.length > maxItems) {
      throw new InterpreterError(
        `Loop refusing ${items.length.toString()} items (cap: ${maxItems.toString()}). Increase maxItems or filter upstream.`,
        itemsExpr,
      );
    }

    const declaredStrategy = coerceString(interpolated.strategy ?? 'naive');
    const concurrency = Math.max(0, Math.min(50, Number(interpolated.concurrency ?? 1)));
    const errorPolicy = coerceString(interpolated.errorPolicy ?? 'continue');
    const rateLimitPerMin = Math.max(0, Number(interpolated.rateLimitPerMin ?? 0));
    const batchSize = Math.max(1, Number(interpolated.batchSize ?? 100));

    // Identify body sub-graph: nodes reachable from the `body` port.
    const allOutgoing = args.adj.outgoing.get(args.loopNode.id) ?? [];
    const bodyEdges = allOutgoing.filter((e) => e.fromPort === 'body' || e.fromPort === undefined);
    const bodyStartIds = bodyEdges.map((e) => e.to);
    const bodyNodeIds = bodyStartIds.length > 0
      ? collectReachable(args.adj, bodyStartIds)
      : new Set<string>();

    // Pre-mark body nodes as visited in the OUTER BFS so the main engine
    // doesn't try to execute them sequentially after the loop completes.
    for (const id of bodyNodeIds) args.outerVisited.add(id);

    // Resolve 'auto' strategy now that we know body+size.
    const strategy = declaredStrategy === 'auto'
      ? resolveAutoStrategy(items.length, bodyNodeIds, args.adj, (id) => this.executor.resolveNodeModule(id))
      : declaredStrategy;

    let results: unknown[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const errorList: { index: number; message: string }[] = [];

    if (strategy === 'bulk') {
      const r = await this.runBulk(args, items, bodyStartIds, bodyNodeIds, bodyLineage);
      results = r.results;
      succeeded = r.succeeded;
      failed = r.failed;
      skipped = r.skipped;
      errorList.push(...r.errors);
    } else if (strategy === 'queue') {
      // BullMQ worker is wired separately in bin/flowforge.ts `worker` mode.
      // When called inline (no worker process), we fall back to naive — but
      // log loudly so the operator knows the throughput will be limited.
      logger.warn(
        { loopId: args.loopNode.id, items: items.length },
        'Loop strategy=queue but no BullMQ worker is attached — falling back to naive',
      );
      const r = await this.runIterations(args, items, bodyStartIds, bodyNodeIds, {
        strategy: 'naive',
        concurrency,
        errorPolicy,
        rateLimitPerMin,
        batchSize,
      }, bodyLineage);
      results = r.results;
      succeeded = r.succeeded;
      failed = r.failed;
      skipped = r.skipped;
      errorList.push(...r.errors);
    } else if (strategy === 'aggregate') {
      const r = this.runAggregate(args, interpolated, items, bodyNodeIds);
      results = r.results;
      succeeded = r.succeeded;
    } else {
      const r = await this.runIterations(args, items, bodyStartIds, bodyNodeIds, {
        strategy,
        concurrency,
        errorPolicy,
        rateLimitPerMin,
        batchSize,
      }, bodyLineage);
      results = r.results;
      succeeded = r.succeeded;
      failed = r.failed;
      skipped = r.skipped;
      errorList.push(...r.errors);
    }

    const totalDurationMs = Date.now() - startedAt;
    const loopOutput = {
      iterations: results.length,
      succeeded,
      failed,
      skipped,
      results,
      errors: errorList,
      totalDurationMs,
      strategy,
    };

    args.steps.push({
      nodeId: args.loopNode.id,
      nodeLabel: args.loopModule.def.label,
      ...(args.loopModule.def.icon !== undefined ? { nodeIcon: args.loopModule.def.icon } : {}),
      status: failed > 0 && errorPolicy === 'stop' ? 'error' : 'success',
      output: JSON.stringify(loopOutput),
      startedAt,
      endedAt: Date.now(),
      durationMs: totalDurationMs,
      nodeConfig: args.loopNode.config,
    });
    args.outerOutputs.set(args.loopNode.id, loopOutput);

    return { output: loopOutput, chosenBranch: 'done', errors: failed };
  }

  // ──────────────────────────────────────────────────────────────
  // Strategy implementations
  // ──────────────────────────────────────────────────────────────

  private async runBulk(
    args: ExecuteLoopArgs,
    items: unknown[],
    bodyStartIds: string[],
    bodyNodeIds: ReadonlySet<string>,
    lineage: NodeLineageArgs | undefined,
  ): Promise<StrategyResult> {
    if (bodyStartIds.length === 0) {
      return { results: [], succeeded: 0, failed: 0, skipped: items.length, errors: [] };
    }
    const loopCtx: LoopContext = {
      item: items,
      index: 0,
      total: 1,
      first: true,
      last: true,
      loopId: args.loopNode.id,
      strategy: 'bulk',
    };
    // Bulk: il body vede l'array INTERO in un'unica iterazione (index 0) —
    // stessa ancora deterministica del nodo standard fuori dal loop.
    const iter = await this.runBodyIteration(args, bodyStartIds, bodyNodeIds, loopCtx, items, lineage);
    if (iter.errors > 0) {
      return {
        results: [iter.output],
        succeeded: 0,
        failed: 1,
        skipped: 0,
        errors: [{ index: 0, message: `bulk iteration had ${iter.errors.toString()} node error(s)` }],
      };
    }
    return { results: [iter.output], succeeded: 1, failed: 0, skipped: 0, errors: [] };
  }

  private runAggregate(
    args: ExecuteLoopArgs,
    interpolated: Record<string, unknown>,
    items: unknown[],
    bodyNodeIds: ReadonlySet<string>,
  ): { results: unknown[]; succeeded: number } {
    const groupKey = coerceString(interpolated.aggregateBy ?? '');
    const reducer = coerceString(interpolated.aggregateReducer ?? 'count');
    const field = interpolated.aggregateField !== undefined ? coerceString(interpolated.aggregateField) : undefined;

    const results: unknown[] = groupKey === ''
      ? [reduceGroup(items, reducer, field)]
      : [(() => {
          const groups = groupBy(items, groupKey);
          const aggregated: Record<string, unknown> = {};
          for (const [k, v] of groups.entries()) aggregated[k] = reduceGroup(v, reducer, field);
          return aggregated;
        })()];

    // Body nodes are skipped — push a synthetic step for each so the run
    // inspector clearly shows "aggregate strategy → body not executed".
    for (const id of bodyNodeIds) {
      const n = args.adj.nodesById.get(id);
      if (!n) continue;
      const mod = this.executor.resolveNodeModule(n.defId);
      args.steps.push({
        nodeId: id,
        nodeLabel: mod?.def.label ?? n.defId,
        status: 'skipped',
        output: '',
        startedAt: Date.now(),
        endedAt: Date.now(),
        durationMs: 0,
        loopId: args.loopNode.id,
        skippedReason: 'aggregate strategy — body not executed',
      });
    }
    return { results, succeeded: 1 };
  }

  private async runIterations(
    args: ExecuteLoopArgs,
    items: unknown[],
    bodyStartIds: string[],
    bodyNodeIds: ReadonlySet<string>,
    opts: { strategy: string; concurrency: number; errorPolicy: string; rateLimitPerMin: number; batchSize: number },
    lineage?: NodeLineageArgs,
  ): Promise<StrategyResult> {
    const iterUnits: { item: unknown; chunkIndices?: number[] }[] = opts.strategy === 'batch'
      ? chunkArray(items, opts.batchSize).map((chunk, i) => ({
          item: chunk,
          chunkIndices: chunk.map((_, j) => i * opts.batchSize + j),
        }))
      : items.map((it) => ({ item: it }));

    const total = iterUnits.length;
    const results: unknown[] = new Array<unknown>(total);
    let succeeded = 0;
    let failed = 0;
    const errors: { index: number; message: string }[] = [];

    const rateDelay = opts.rateLimitPerMin > 0 ? Math.ceil(60_000 / opts.rateLimitPerMin) : 0;
    const effConcurrency = opts.concurrency === 0 ? total : Math.max(1, opts.concurrency);

    let cursor = 0;
    const runOne = async (i: number): Promise<void> => {
      const unit = iterUnits[i];
      if (!unit) return;
      const loopCtx: LoopContext = {
        item: unit.item,
        index: i,
        total,
        first: i === 0,
        last: i === total - 1,
        ...(unit.chunkIndices ? { chunkIndices: unit.chunkIndices } : {}),
        loopId: args.loopNode.id,
        strategy: opts.strategy,
      };
      // GAP #2: con strategy 'batch' loop.index indicizza il CHUNK, non un
      // item della sorgente → ancorare il lineage lì sarebbe pairing FALSO.
      // Solo le strategy item-indexed (naive, e il fallback queue→naive)
      // portano l'ancora (S, i) nel body.
      const iterLineage = opts.strategy === 'batch' ? undefined : lineage;
      const iter = await this.runBodyIteration(args, bodyStartIds, bodyNodeIds, loopCtx, unit.item, iterLineage);
      results[i] = iter.output;
      if (iter.errors > 0) {
        failed += 1;
        errors.push({ index: i, message: `iteration ${i.toString()} had ${iter.errors.toString()} node error(s)` });
        if (opts.errorPolicy === 'stop') cursor = total;
      } else {
        succeeded += 1;
      }
      if (rateDelay > 0) await new Promise<void>((r) => { setTimeout(r, rateDelay); });
    };

    const workers: Promise<void>[] = [];
    const pool = Math.min(effConcurrency, total);
    for (let w = 0; w < pool; w += 1) {
      workers.push((async (): Promise<void> => {
        while (cursor < total) {
          const i = cursor;
          cursor += 1;
          await runOne(i);
        }
      })());
    }
    await Promise.all(workers);

    return { results, succeeded, failed, skipped: total - succeeded - failed, errors };
  }

  /**
   * Execute the body sub-graph once for a single iteration. Per-iteration
   * `outputsById` is fresh, so iterations don't see each other's outputs.
   */
  private async runBodyIteration(
    args: ExecuteLoopArgs,
    bodyStartIds: string[],
    bodyNodeIds: ReadonlySet<string>,
    loop: LoopContext,
    seedInput: unknown,
    lineage?: NodeLineageArgs,
  ): Promise<{ output: unknown; errors: number }> {
    const iterOutputs = new Map<string, unknown>();
    const queue: { nodeId: string; carriedInput: unknown }[] = bodyStartIds.map((id) => ({
      nodeId: id,
      carriedInput: seedInput,
    }));
    const visited = new Set<string>();
    let lastOutput: unknown = seedInput;
    let errors = 0;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { nodeId, carriedInput } = item;
      if (visited.has(nodeId)) continue;
      if (!bodyNodeIds.has(nodeId)) continue;
      visited.add(nodeId);

      const node = args.adj.nodesById.get(nodeId);
      if (!node) continue;
      const module = this.executor.resolveNodeModule(node.defId);

      const res = await this.executor.executeNode({
        node,
        module,
        carriedInput,
        outputsById: iterOutputs,
        ...(args.pinnedOutputs ? { pinnedOutputs: args.pinnedOutputs } : {}),
        tenantId: args.tenantId,
        runId: args.runId,
        workflowId: args.workflowId,
        loop,
        ...(args.subworkflowDepth !== undefined ? { subworkflowDepth: args.subworkflowDepth } : {}),
        // GAP #2: ogni nodo del body risolve $('Sorgente').item come l'item
        // dell'iterazione corrente — l'ancora (S, loop.index) la compone
        // executeNode dallo stesso loop context.
        ...(lineage !== undefined ? { lineage } : {}),
      });
      args.steps.push(res.step);
      if (res.step.status === 'error') errors += 1;
      iterOutputs.set(nodeId, res.output);
      lastOutput = res.output;

      const downstream = args.adj.outgoing.get(nodeId) ?? [];
      const branchable = module?.def.outputs !== undefined && module.def.outputs.length > 0;
      const toFollow = branchable && res.chosenBranch !== undefined
        ? downstream.filter((e) => e.fromPort === res.chosenBranch)
        : downstream;
      for (const edge of toFollow) {
        if (bodyNodeIds.has(edge.to) && !visited.has(edge.to)) {
          queue.push({ nodeId: edge.to, carriedInput: res.output });
        }
      }
    }

    return { output: lastOutput, errors };
  }
}

interface StrategyResult {
  results: unknown[];
  succeeded: number;
  failed: number;
  skipped: number;
  errors: { index: number; message: string }[];
}

// ──────────────────────────────────────────────────────────────
// Pure helpers (no class state) — kept here so they stay close
// to the only code that uses them.
// ──────────────────────────────────────────────────────────────

/**
 * Collect node ids reachable from a set of start ids via outgoing edges.
 * Used to identify the body sub-graph of a loop.
 */
function collectReachable(adj: AdjacencyMap, startIds: string[]): Set<string> {
  const reachable = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    for (const e of adj.outgoing.get(id) ?? []) {
      if (!reachable.has(e.to)) queue.push(e.to);
    }
  }
  return reachable;
}

/**
 * Resolve the `auto` strategy at run time. Order of preference:
 *   1. body declares bulk capability → bulk (best case)
 *   2. items >= 10_000 → queue (don't block the request)
 *   3. items >= 200   → batch (less rate-limit pressure)
 *   4. otherwise      → naive
 */
function resolveAutoStrategy(
  itemsCount: number,
  bodyNodeIds: ReadonlySet<string>,
  adj: AdjacencyMap,
  moduleResolver: (defId: string) => NodeModule | undefined,
): 'naive' | 'batch' | 'bulk' | 'queue' {
  for (const id of bodyNodeIds) {
    const node = adj.nodesById.get(id);
    if (!node) continue;
    if (String(node.config.bulkEnabled) === 'true') return 'bulk';
    const module = moduleResolver(node.defId);
    if (module?.def.bulk?.supports === true) return 'bulk';
  }
  if (itemsCount >= 10_000) return 'queue';
  if (itemsCount >= 200) return 'batch';
  return 'naive';
}

/**
 * Esportata per i test: il guard `size <= 0` è difensivo (l'unico chiamante
 * clampa batchSize a ≥1) ma resta il contratto della funzione, non dead-code.
 */
export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function groupBy<T>(arr: readonly T[], key: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of arr) {
    const k = item !== null && typeof item === 'object'
      ? coerceString((item as Record<string, unknown>)[key] ?? '__missing__')
      : String(item);
    const bucket = out.get(k) ?? [];
    bucket.push(item);
    out.set(k, bucket);
  }
  return out;
}

function reduceGroup(items: readonly unknown[], reducer: string, field: string | undefined): unknown {
  const numeric = (): number[] => items.map((it) => {
    if (it !== null && typeof it === 'object' && field) {
      return Number((it as Record<string, unknown>)[field] ?? 0);
    }
    return Number(it);
  }).filter((n) => Number.isFinite(n));

  switch (reducer) {
    case 'count': return items.length;
    case 'sum': {
      const v = numeric();
      return v.reduce((a, b) => a + b, 0);
    }
    case 'avg': {
      const v = numeric();
      return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
    }
    case 'min': {
      const v = numeric();
      // reduce, NON Math.min(...v): v = risultati di una loop su molti item → spread crasha.
      return v.length === 0 ? 0 : v.reduce((m, b) => (b < m ? b : m), Infinity);
    }
    case 'max': {
      const v = numeric();
      return v.length === 0 ? 0 : v.reduce((m, b) => (b > m ? b : m), -Infinity);
    }
    case 'concat': return items.map((it) => {
      if (it !== null && typeof it === 'object' && field) {
        return coerceString((it as Record<string, unknown>)[field] ?? '');
      }
      return String(it);
    }).join(',');
    default: return items.slice();
  }
}
