/**
 * Node dispatch strategies — the Strategy + Chain-of-Responsibility pattern
 * applied to per-node execution.
 *
 * Why this exists:
 *   The WorkflowEngine used to have a single `dispatchNode()` method with
 *   an if/else ladder for special-case nodes (pinned outputs, logic_if,
 *   logic_delay, triggers) and a catch-all that called the registered
 *   executor. Every new special case grew that ladder. Strategy Pattern
 *   inverts the relationship: each special case is a self-contained file,
 *   registered in an array, and the engine simply iterates "first that
 *   matches wins".
 *
 * Benefits:
 *   • Single Responsibility — one file = one execution mode.
 *   • Test-friendly — instantiate a Strategy alone and assert.
 *   • Open/Closed — add a new special case by creating a file + appending
 *     to the array, without touching the engine.
 *
 * Ordering rule:
 *   The DEFAULT_DISPATCH_STRATEGIES array is the authoritative ordering.
 *   Strategies that act as global overrides (PinnedOutput) MUST come first;
 *   the catch-all (NodeExecutor) MUST come last.
 */

import type { LogCollector } from '@/services/runs/log-collector.js';
import type { CanvasNode, ExecutionItem } from '@flowforge/core-schema';
import type { NodeModule, NodeExecutionContext } from '@flowforge/nodes-stdlib';
import type { InterpreterScope } from '@/engine/interpreter.js';
import type { ILlmProviderRegistry, IBinaryStore } from '@/engine/ports.js';

/**
 * The context passed to every strategy. Carries everything a strategy
 * might need to decide AND to execute — no hidden state, no class fields.
 */
export interface DispatchContext {
  node: CanvasNode;
  module: NodeModule;
  /** Already-interpolated config (`{{expr}}` resolved against scope). */
  interpolatedConfig: Record<string, unknown>;
  /** The carried input from the upstream node (or trigger payload). */
  carriedInput: unknown;
  /** Interpreter scope — used by strategies that evaluate expressions. */
  scope: InterpreterScope;
  /** Pinned outputs from a Replay or "pin data" — used by PinnedOutputStrategy. */
  pinnedOutputs?: Map<string, unknown>;
  tenantId: string;
  runId: string;
  workflowId: string;
  /** Resolver for tenant-scoped LLM provider settings (passed through to executors). */
  llmProviders: ILlmProviderRegistry;
  /** Blob store tenant-scoped (GAP 2) — forwardato a execCtx.readBinary/writeBinary. */
  binaryStore: IBinaryStore;
  /**
   * N17 audit: forwarded to NodeExecutionContext so the `logic_subworkflow`
   * executor can enforce the recursion cap (X-Subworkflow-Depth chain).
   */
  subworkflowDepth?: number;
  /**
   * #226 Cappella Sistina+ logging — collector per-step opzionale.
   * Quando il workflow-engine.ts crea uno step, istanzia un LogCollector e
   * lo inietta qui; le strategy lo forwardano nel `execCtx.__logCollector`
   * affinché executors (customNode + sandbox) ci scrivano structured logs.
   * Post-execution `executeNode` chiama `collector.collect()` e setta
   * `step.logs / logsTotal / logsTruncated` sulla RunStep.
   */
  logCollector?: LogCollector;
}

/**
 * Result of one strategy's execution. Mirrors what the engine needs to
 * advance the BFS: the node's output, which branch port to follow next
 * (if branchable), and how many retry attempts were spent.
 */
export interface DispatchResult {
  output: unknown;
  chosenBranch: string | undefined;
  /** Zero for non-retryable strategies; > 0 only for the executor strategy. */
  retries: number;
  /**
   * GAP #2 (paired items) — vista item-native dell'output dichiarata
   * dall'executor (NodeExecutionResult.items), propagata verbatim fino al
   * BFS che la registra nel RunItemGraph. Assente → euristica engine-side.
   */
  items?: ExecutionItem[];
}

/**
 * Contract every dispatch strategy honors.
 *
 *   match() — is this strategy competent for the given context? Must be
 *             pure & fast (called once per node per run). No side effects.
 *
 *   execute() — perform the dispatch and return the result. May be async
 *               (LLM calls, HTTP requests, file I/O). Must NOT throw on
 *               retryable errors — retry logic lives inside the strategy
 *               (or in a helper it owns).
 */
export interface INodeDispatchStrategy {
  readonly name: string;
  match(ctx: DispatchContext): boolean;
  execute(ctx: DispatchContext): Promise<DispatchResult>;
}

/**
 * Re-export NodeExecutionContext so concrete strategies that build it
 * (NodeExecutorStrategy) have a single import path.
 */
export type { NodeExecutionContext };
