/**
 * EstimatorService — static analysis of a workflow to predict cost,
 * duration and rate-limit pressure BEFORE the operator hits "Run".
 *
 * Approach:
 *   1. Walk the graph, find every logic_loop node.
 *   2. For each loop, attempt to evaluate `itemsExpression` against the
 *      sample input. If it returns an array, use its length. Otherwise
 *      fall back to a configurable default (100).
 *   3. For each body node, look up NodeDef.cost + NodeDef.bulk metadata.
 *      Compute per-iteration cost & latency, multiply by iteration count.
 *   4. Detect rate-limit pressure: iterations/min vs declared reqPerMin.
 *   5. Suggest a strategy ('bulk' if available, 'batch' if rate-limited,
 *      'queue' if iterations >= 10k, otherwise 'naive').
 *
 * Output is consumed by the editor's pre-run confirmation modal.
 */

import type { Workflow, NodeDef } from '@medea/engine-core-schema';
import { ALL_NODE_MODULES } from '@/engine/workflow-engine.js';
import { evaluateExpression } from '@/engine/interpreter.js';
import { logger } from '@/lib/logger.js';

/**
 * Per-loop forecast — one record for every logic_loop node in the workflow.
 * Aggregates iteration count, body footprint, estimated cost, latency, and
 * a suggested strategy (with the human-readable reason behind the pick).
 */
export interface LoopEstimate {
  loopId: string;
  loopLabel: string;
  /** Iterations the engine will run. */
  iterationCount: number;
  /** How `iterationCount` was determined: from itemsExpression evaluation,
   *  from a fallback default, or hard-coded by the operator. */
  iterationCountSource: 'evaluated' | 'fallback' | 'configured';
  /** Body node count — N iterations × M body nodes = total node executions. */
  bodyNodeCount: number;
  /** Total node executions = iterationCount × bodyNodeCount. */
  totalNodeExecutions: number;
  /** Sum of per-iteration cost over all body nodes, multiplied by N. */
  estimatedCostUsd: number;
  /** Sum of per-iteration latency × N (worst case, serial). */
  estimatedDurationMs: number;
  /** Strategy currently declared on the loop. */
  declaredStrategy: string;
  /** Strategy the engine would auto-pick (may differ from declared). */
  suggestedStrategy: string;
  /** One-sentence explanation of why the suggested strategy was picked. */
  suggestionReason: string;
  /** Per-loop warnings (rate-limit risk, empty array, fallback count, …). */
  warnings: string[];
}

/**
 * Full workflow forecast — one per call to `estimate()`. Returned to the
 * editor and rendered as a pre-run confirmation modal.
 */
export interface WorkflowEstimate {
  workflowId: string;
  loops: LoopEstimate[];
  /** Grand totals across all loops + non-loop nodes. */
  totalEstimatedCostUsd: number;
  totalEstimatedDurationMs: number;
  totalNodeExecutions: number;
  /** Workflow-wide warnings (e.g. cumulative rate-limit pressure). */
  rateLimitWarnings: string[];
}

/**
 * Input to `EstimatorService.estimate()`. The workflow is the only required
 * field; sample input and a default iteration count are optional knobs to
 * sharpen the forecast.
 */
export interface EstimateInput {
  workflow: Workflow;
  /** Sample input passed to itemsExpression — informs iteration count. */
  sampleInput?: unknown;
  /** Fallback iteration count when itemsExpression cannot be evaluated. */
  defaultIterationCount?: number;
}

/**
 * Static analysis service — predicts cost, latency, and rate-limit pressure
 * for a workflow before it runs. Stateless: no DB writes, no side effects.
 * Safe to instantiate per request.
 */
export class EstimatorService {
  /**
   * Produce a forecast for the given workflow.
   *
   * Algorithm:
   *   1. Walk the graph, find every logic_loop node.
   *   2. For each loop, attempt to evaluate itemsExpression against
   *      sampleInput. Fall back to defaultIterationCount on failure.
   *   3. Inspect body nodes for NodeDef.cost / NodeDef.bulk hints.
   *   4. Compute totals and rate-limit warnings.
   *   5. Recommend a strategy (bulk > queue > batch > naive).
   */
  estimate(input: EstimateInput): WorkflowEstimate {
    const fallbackCount = input.defaultIterationCount ?? 100;
    const allDefs = new Map<string, NodeDef>();
    for (const m of ALL_NODE_MODULES) allDefs.set(m.def.id, m.def);

    const loops: LoopEstimate[] = [];
    const rateLimitWarnings: string[] = [];
    let totalCost = 0;
    let totalDuration = 0;
    let totalExecutions = 0;

    // Index outgoing edges so we can resolve body sub-graphs cheaply.
    const outgoing = new Map<string, typeof input.workflow.edges>();
    for (const e of input.workflow.edges) {
      const arr = outgoing.get(e.from) ?? [];
      arr.push(e);
      outgoing.set(e.from, arr);
    }
    const nodesById = new Map(input.workflow.nodes.map((n) => [n.id, n]));

    const reachableFrom = (startIds: string[]): Set<string> => {
      const seen = new Set<string>();
      const stack = [...startIds];
      while (stack.length > 0) {
        const id = stack.pop();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        for (const e of outgoing.get(id) ?? []) stack.push(e.to);
      }
      return seen;
    };

    // ── Loop analysis ───────────────────────────────────────────────
    for (const node of input.workflow.nodes) {
      if (node.defId !== 'logic_loop') continue;

      const itemsExpr = String(node.config.itemsExpression ?? 'input');
      let iterationCount = fallbackCount;
      let countSource: LoopEstimate['iterationCountSource'] = 'fallback';
      try {
        const result = evaluateExpression(itemsExpr, { input: input.sampleInput, vars: {} });
        if (Array.isArray(result)) {
          iterationCount = result.length;
          countSource = 'evaluated';
        }
      } catch (err) {
        logger.debug({ err, loopId: node.id }, 'Estimator could not evaluate itemsExpression');
      }

      const declaredStrategy = String(node.config.strategy ?? 'naive');
      const bodyEdges = (outgoing.get(node.id) ?? []).filter(
        (e) => e.fromPort === 'body' || e.fromPort === undefined,
      );
      const bodyNodeIds = reachableFrom(bodyEdges.map((e) => e.to));

      // Per-iteration cost + latency from body NodeDefs
      let perIterationCost = 0;
      let perIterationLatency = 0;
      let hasBulkCapable = false;
      let mostRestrictiveRate: number | undefined;

      for (const id of bodyNodeIds) {
        const n = nodesById.get(id);
        if (!n) continue;
        const def = allDefs.get(n.defId);
        if (!def) continue;
        if (def.bulk?.supports === true) hasBulkCapable = true;
        if (def.cost?.costPerCall !== undefined) perIterationCost += def.cost.costPerCall;
        if (def.cost?.typicalLatencyMs !== undefined)
          perIterationLatency += def.cost.typicalLatencyMs;
        const rl = def.cost?.rateLimit;
        if (rl?.reqPerMin !== undefined) {
          mostRestrictiveRate =
            mostRestrictiveRate === undefined
              ? rl.reqPerMin
              : Math.min(mostRestrictiveRate, rl.reqPerMin);
        }
      }

      const warnings: string[] = [];
      let suggestedStrategy = declaredStrategy;
      let suggestionReason = 'keeping declared strategy';

      if (hasBulkCapable && declaredStrategy !== 'bulk') {
        suggestedStrategy = 'bulk';
        suggestionReason = 'a body node has a bulk endpoint — switch to bulk for 100x speedup';
      } else if (iterationCount >= 10_000 && declaredStrategy === 'naive') {
        suggestedStrategy = 'queue';
        suggestionReason = '10k+ iterations — use queue to avoid blocking the request';
      } else if (iterationCount >= 200 && declaredStrategy === 'naive') {
        suggestedStrategy = 'batch';
        suggestionReason = 'over 200 items — batch reduces rate-limit pressure';
      } else if (declaredStrategy === 'auto') {
        if (hasBulkCapable) {
          suggestedStrategy = 'bulk';
          suggestionReason = 'auto → bulk (body has bulk endpoint)';
        } else if (iterationCount >= 10_000) {
          suggestedStrategy = 'queue';
          suggestionReason = 'auto → queue (10k+ items)';
        } else if (iterationCount >= 200) {
          suggestedStrategy = 'batch';
          suggestionReason = 'auto → batch (200+ items)';
        } else {
          suggestedStrategy = 'naive';
          suggestionReason = 'auto → naive (small dataset)';
        }
      }

      // Rate limit pressure check
      if (mostRestrictiveRate !== undefined && declaredStrategy === 'naive') {
        const expectedRunMinutes =
          perIterationLatency > 0
            ? (iterationCount * perIterationLatency) / 60_000
            : Math.max(1, iterationCount / 60); // assume 1 req/sec
        const expectedReqPerMin = iterationCount / Math.max(1, expectedRunMinutes);
        if (expectedReqPerMin > mostRestrictiveRate) {
          warnings.push(
            `Rate limit risk: estimated ${expectedReqPerMin.toFixed(0)} req/min vs limit ${mostRestrictiveRate.toString()}/min. Consider strategy='batch' with rateLimitPerMin=${mostRestrictiveRate.toString()}.`,
          );
        }
      }

      if (iterationCount === 0) {
        warnings.push('itemsExpression evaluates to an empty array — loop will not run');
      }
      if (countSource === 'fallback') {
        warnings.push(
          `Iteration count is an estimate (${String(fallbackCount)}) — provide sample input for accurate forecasting`,
        );
      }

      const totalLoopCost = perIterationCost * iterationCount;
      const totalLoopDuration = perIterationLatency * iterationCount;
      const totalLoopExecutions = iterationCount * bodyNodeIds.size;

      totalCost += totalLoopCost;
      totalDuration += totalLoopDuration;
      totalExecutions += totalLoopExecutions;

      loops.push({
        loopId: node.id,
        loopLabel: 'Loop',
        iterationCount,
        iterationCountSource: countSource,
        bodyNodeCount: bodyNodeIds.size,
        totalNodeExecutions: totalLoopExecutions,
        estimatedCostUsd: totalLoopCost,
        estimatedDurationMs: totalLoopDuration,
        declaredStrategy,
        suggestedStrategy,
        suggestionReason,
        warnings,
      });
    }

    // ── Non-loop nodes (each runs exactly once) ─────────────────────
    const inLoopBody = new Set<string>();
    for (const loop of loops) {
      const startIds = (outgoing.get(loop.loopId) ?? [])
        .filter((e) => e.fromPort === 'body' || e.fromPort === undefined)
        .map((e) => e.to);
      const reachable = reachableFrom(startIds);
      for (const id of reachable) inLoopBody.add(id);
    }

    for (const node of input.workflow.nodes) {
      if (inLoopBody.has(node.id)) continue; // already counted via loop
      if (node.defId === 'logic_loop') continue;
      const def = allDefs.get(node.defId);
      if (!def) continue;
      if (def.cost?.costPerCall !== undefined) totalCost += def.cost.costPerCall;
      if (def.cost?.typicalLatencyMs !== undefined) totalDuration += def.cost.typicalLatencyMs;
      totalExecutions += 1;
    }

    return {
      workflowId: input.workflow.id,
      loops,
      totalEstimatedCostUsd: Math.round(totalCost * 10_000) / 10_000,
      totalEstimatedDurationMs: totalDuration,
      totalNodeExecutions: totalExecutions,
      rateLimitWarnings,
    };
  }
}
