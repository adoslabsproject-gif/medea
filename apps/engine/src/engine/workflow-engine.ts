/**
 * WorkflowEngine — the heart of FlowForge.
 *
 * Responsibilities (intentionally focused — Single Responsibility):
 *   1. BFS traversal of the workflow graph.
 *   2. Single-node execution (with retry, branching, pinned outputs).
 *   3. Delegation: loop nodes → IterationCoordinator,
 *                  wait_signal nodes → injected IPauseHandler,
 *                  periodic snapshots → injected ICheckpointHandler.
 *   4. Lifecycle events on the bus (run.started, run.step, run.completed, …).
 *
 * Explicit NON-responsibilities (delegated):
 *   • Iteration semantics            → IterationCoordinator
 *   • Pause/resume persistence       → IPauseHandler adapter
 *   • Checkpoint snapshot persistence → ICheckpointHandler adapter
 *
 * This split keeps each file under ~500 LOC and makes the engine
 * test-friendly: in unit tests, inject no-op adapters and a small
 * NodeModule registry to exercise the BFS in isolation.
 */

import { coerceString } from '@/lib/coerce.js';
import { nanoid } from 'nanoid';
import type { CanvasNode, Edge, Workflow, RunStep } from '@medea/engine-core-schema';
import {
  classifyNodeVersionCompat,
  nodeVersionDrift,
  isBreakingNodeVersionDrift,
} from '@medea/engine-core-schema';
import {
  stdlibNodes,
  findStdlibNode,
  NodeError,
  categoryOf,
  type NodeErrorCategory,
  type NodeModule,
} from '@medea/engine-nodes-stdlib';
import { getInstalledByDefId } from '@/services/community-nodes.service.js';
import { loadCustomNodeForRun } from '@/services/custom-nodes/runtime-loader.js';
import { loadConfig } from '@/config.js';

const RUNTIME_TENANT_ID = loadConfig().MEDEA_TENANT_ID;

/**
 * Hot-resolvable community node lookup. Returns a NodeModule shaped from
 * the installed package; the executor is a sentinel that the server-side
 * executor registry maps to `communityNodeExecutor`.
 */
/**
 * Hot-resolvable custom node lookup (Custom Node Editor — Cappella Sistina).
 * Risolve un defId con prefisso `custom_*` ai metadati salvati in custom_nodes
 * del tenant. L'executor effettivo viene poi dispatched da resolveServerExecutor
 * → customNodeExecutor → loadCustomNodeForRun (riusa stessa cache).
 *
 * @param defId  es. "custom_streammy_resolve"
 * @returns NodeModule placeholder se il nodo esiste nel tenant, undefined altrimenti
 */
function resolveCustomNodeModule(defId: string): NodeModule | undefined {
  if (!defId.startsWith('custom_')) return undefined;
  if (!RUNTIME_TENANT_ID) return undefined;
  const entry = loadCustomNodeForRun(defId, RUNTIME_TENANT_ID);
  if (!entry) return undefined;
  // Costruiamo NodeDef minimale per soddisfare il contract dell'engine
  // (id usato per logging/UI; il defId stesso identifica il nodo).
  const def = {
    id: defId,
    kind: 'action' as const,
    family: 'custom' as const,
    displayName: defId,
    description: `Custom node ${defId} (v${entry.semver})`,
    inputs: ['in'],
    outputs: ['out'],
    configSchema: { type: 'object', properties: {} },
  } as unknown as NodeModule['def'];
  return {
    def,
    executor: () => {
      return Promise.reject(
        new Error(
          'Custom node executor must be dispatched via resolveServerExecutor — direct module.executor call is a bug.',
        ),
      );
    },
  };
}

function resolveCommunityNodeModule(defId: string): NodeModule | undefined {
  const entry = getInstalledByDefId(defId);
  if (!entry) return undefined;
  // Executor field is unused at this layer — the runtime path goes through
  // resolveServerExecutor which returns `communityNodeExecutor`. We keep
  // the property required by NodeModule populated with a placeholder that
  // throws if ever called directly (defense in depth).
  return {
    def: entry.def,
    executor: () => {
      return Promise.reject(
        new Error(
          'Community node executor must be dispatched via resolveServerExecutor — direct module.executor call is a bug.',
        ),
      );
    },
  };
}
import { dbNodes } from '@medea/engine-nodes-db';
import { coreIntegrationNodes } from '@medea/engine-nodes-integrations-core';
import { italianConnectors } from '@medea/engine-nodes-integrations-italia';
import { aiAgentNodes } from '@medea/engine-nodes-ai-agents';
import { llmNodes } from '@medea/engine-nodes-llm';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import {
  asQuotaPauseError,
  quotaResumeSignal,
  secondsUntilQuotaReset,
  type QuotaPauseError,
} from '@/engine/quota-pause.js';
import {
  evaluateExpression,
  interpolateConfig,
  type LoopContext,
  type InterpreterScope,
} from './interpreter.js';
import {
  type IPauseHandler,
  type ICheckpointHandler,
  type ILlmProviderRegistry,
  type IGlobalVariableRegistry,
  type IBinaryStore,
  noopBinaryStore,
  noopPauseHandler,
  noopCheckpointHandler,
  noopLlmProviderRegistry,
  noopGlobalVariableRegistry,
} from './ports.js';
import {
  IterationCoordinator,
  type AdjacencyMap,
  type INodeExecutor,
} from './iteration-coordinator.js';
import {
  deriveOutputItems,
  deriveFanOutItems,
  type RunItemGraph,
  type NodeLineageArgs,
  type ExecutionItem,
} from './item-model.js';
import {
  DEFAULT_DISPATCH_STRATEGIES,
  type INodeDispatchStrategy,
  type DispatchContext,
  type DispatchResult,
} from './strategies/index.js';

/**
 * Full node catalog — every package that ships node definitions MUST be
 * registered here, otherwise its `defId`s become "Unknown node def" at run
 * time. Tests can override via WorkflowEngineOptions.nodeRegistry.
 */
export const ALL_NODE_MODULES: readonly NodeModule[] = [
  ...stdlibNodes,
  ...dbNodes,
  ...coreIntegrationNodes,
  ...italianConnectors,
  ...aiAgentNodes,
  ...llmNodes,
];

export interface WorkflowRunInput {
  workflow: Workflow;
  triggerInput?: unknown;
  triggeredBy?: string;
  tenantId?: string;
  /**
   * Pinned outputs per node — when present, the engine skips execution and
   * uses the pinned value. Powers n8n-style "pin data" for iterative dev
   * and step-N Replay.
   */
  pinnedOutputs?: Map<string, unknown>;
  /**
   * Run ID pre-assegnato dal caller. Quando il caller (RunService) pre-inserisce
   * il run nella tabella `runs` con status='running' PRIMA di chiamare engine
   * (così GET /runs/:id funziona durante l'esecuzione + crash recovery sweep),
   * passa qui l'ID già generato così engine + DB row condividono lo stesso id.
   * Se omesso, engine genera il proprio (back-compat).
   */
  runId?: string;
  /**
   * Cooperative cancellation: se la signal viene `abort()`-ata, l'engine
   * interrompe il dispatch loop tra un nodo e l'altro (e nei punti di
   * yield "lunghi" come retry/checkpoint) e lancia un AbortError. Il caller
   * lo intercetta e traduce in status='cancelled'. La signal viene anche
   * passata ai node executors via `ExecuteNodeArgs` così — chi ne fa
   * uso (fetch, db query, setTimeout di retry) — onora il cancel nativamente.
   */
  cancelSignal?: AbortSignal;
  /**
   * N17 audit: subworkflow recursion depth at run start. 0 = direct
   * user-triggered run, N = invoked from N levels of nested
   * `logic_subworkflow`. Propagated to NodeExecutionContext so the
   * `logic_subworkflow` executor can enforce the cap.
   */
  subworkflowDepth?: number;
  /**
   * GAP 4 (esecuzione parziale): ferma il run DOPO che questo nodo ha
   * completato — i suoi downstream non vengono accodati e la coda residua
   * viene scartata. Con `pinnedOutputs` sugli antenati abilita
   * "Esegui solo questo nodo" (replay fromNode=X + stopAfter=X) e
   * "Esegui fino a qui" senza eseguire il resto del grafo.
   */
  stopAfterNodeId?: string;
}

export interface WorkflowRunResult {
  runId: string;
  status: 'success' | 'error' | 'partial' | 'paused';
  steps: RunStep[];
  totalDurationMs: number;
  errorCount: number;
  /** When status='paused', the id of the paused_workflows row to resume later. */
  pausedId?: string;
  /** When status='paused', the signal that must fire to resume. */
  pausedOnSignal?: string;
}

/**
 * Snapshot of engine state — emitted by checkpoints and by wait_signal
 * pauses. Sufficient to rehydrate the engine and continue from where it
 * left off (across process restarts or signal arrivals).
 */
/**
 * Item della coda BFS. `mapMode` (GAP 1, Visible Auto-Map) viaggia con
 * l'item perché è una proprietà dell'EDGE percorso, non del nodo: lo
 * stesso nodo raggiunto da due edge diversi può essere mappato da uno e
 * non dall'altro. Campo opzionale → snapshot/checkpoint legacy compatibili.
 */
export interface QueueItem {
  nodeId: string;
  carriedInput: unknown;
  mapMode?: Edge['mapMode'];
  /**
   * GAP #2 (paired items): nodo che ha PRODOTTO `carriedInput` (provenienza
   * dell'edge percorso). È l'ancora `(S, i)` della semantica PAIRED di
   * `$('Node').item`/`itemMatching`. Assente sulle root (il trigger input non
   * è un nodo). Persiste negli snapshot via `pendingQueue` — i QueueItem
   * serializzati lo portano con sé.
   */
  sourceNodeId?: string;
}

export interface EngineSnapshot {
  runId: string;
  workflowId: string;
  tenantId: string;
  triggeredBy?: string;
  outputsById: Map<string, unknown>;
  visited: Set<string>;
  pendingQueue: QueueItem[];
  /**
   * GAP #2 (paired items): vista item-native con lineage, ripristinata al
   * resume così `.item`/`itemMatching` risolvono anche i nodi pre-pausa.
   * Opzionale: snapshot pre-4.2 non la hanno → lineage assente (mai sbagliato).
   */
  itemGraph?: RunItemGraph;
  stepsSoFar: RunStep[];
  errorCount: number;
  startedAt: number;
}

/**
 * Engine construction options. All knobs optional — defaults yield a
 * fully functional single-node engine with no persistence side-effects.
 */
export interface WorkflowEngineOptions {
  pauseHandler?: IPauseHandler;
  checkpointHandler?: ICheckpointHandler;
  /** Resolver for tenant-scoped LLM provider settings. */
  llmProviders?: ILlmProviderRegistry;
  /** Resolver for tenant-scoped global variables ($env.KEY). */
  globalVariables?: IGlobalVariableRegistry;
  /** Blob store tenant-scoped per i nodi che producono/consumano binari (GAP 2). */
  binaryStore?: IBinaryStore;
  /** Frequency of checkpoint emission in executed nodes. Default 5. */
  checkpointEveryNodes?: number;
  /** Override node catalog (tests). */
  nodeRegistry?: readonly NodeModule[];
  /**
   * Override the dispatch chain. Defaults to DEFAULT_DISPATCH_STRATEGIES.
   * Tests can inject a custom chain (e.g. recording or no-op) to assert
   * engine behavior in isolation.
   */
  dispatchStrategies?: readonly INodeDispatchStrategy[];
}

/** Arguments for executeNode (public surface used by IterationCoordinator). */
export interface ExecuteNodeArgs {
  node: CanvasNode;
  module: NodeModule | undefined;
  carriedInput: unknown;
  outputsById: Map<string, unknown>;
  pinnedOutputs?: Map<string, unknown>;
  /**
   * Map id → name for nodes that have a user-defined alias. The engine
   * populates `vars` with BOTH the id key AND the alias key so expressions
   * like `$node.<alias>.json` resolve correctly.
   */
  nodeAliases?: Map<string, string>;
  tenantId: string;
  runId: string;
  workflowId: string;
  loop?: LoopContext;
  /**
   * N17 audit: forwarded from WorkflowRunInput so the dispatch chain can
   * surface depth in NodeExecutionContext for the subworkflow executor.
   */
  subworkflowDepth?: number;
  /**
   * GAP #2 (paired items): grafo item-native della run + sorgente dell'input
   * corrente. Quando presente (BFS principale), executeNode setta
   * `scope.lineage` e `.item`/`itemMatching` risolvono. Assente nei contesti
   * senza grafo (loop body via IterationCoordinator) → undefined, onesto.
   */
  lineage?: NodeLineageArgs;
}

// ──────────────────────────────────────────────────────────────
// Pure graph helpers
// ──────────────────────────────────────────────────────────────

/**
 * Build the id→alias map for a workflow. Skips nodes without `name`. Throws
 * on duplicate names (two nodes with same alias would make `vars[alias]`
 * ambiguous — fail-fast is safer than silent overwrite).
 */
function buildAliasMap(nodes: readonly CanvasNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, string>(); // name → id (for duplicate detection)
  for (const n of nodes) {
    if (!n.name) continue;
    const existing = seen.get(n.name);
    if (existing !== undefined && existing !== n.id) {
      throw new Error(
        `Duplicate node alias "${n.name}" — used by nodes ${existing} and ${n.id}. Rename one.`,
      );
    }
    seen.set(n.name, n.id);
    out.set(n.id, n.name);
  }
  return out;
}

function buildAdjacency(workflow: Workflow): AdjacencyMap {
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const nodesById = new Map<string, CanvasNode>();
  for (const node of workflow.nodes) nodesById.set(node.id, node);
  for (const edge of workflow.edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push(edge);
    outgoing.set(edge.from, out);
    const inc = incoming.get(edge.to) ?? [];
    inc.push(edge);
    incoming.set(edge.to, inc);
  }
  return { outgoing, incoming, nodesById };
}

function findRoots(workflow: Workflow, adj: AdjacencyMap): CanvasNode[] {
  // I sticky frame (defId='note') sono UI-only, non sono entry-point del flow.
  // Senza questo filter, un sticky senza edge incoming verrebbe trattato come
  // root dell'engine → tentativo di esecuzione → "Unknown node def: note".
  return workflow.nodes.filter((node) => node.defId !== 'note' && !adj.incoming.has(node.id));
}

/**
 * A node is "branchable" — meaning the engine routes execution to ONE of N
 * downstream ports — only when explicitly flagged via `branching: true`.
 *
 * Previously this returned true for any node with a non-empty `outputs`
 * array, but that conflated two different concepts:
 *   • routing ports (if/switch → engine picks one branch)
 *   • output schema hints (pdf_extract → emits an object with N fields)
 *
 * Schema-hint nodes have outputs declared for documentation only; the
 * engine should forward their full output to ALL downstream edges (single
 * port). The `branching` flag now makes the intent explicit.
 */
function nodeIsBranchable(module: NodeModule): boolean {
  return (
    module.def.branching === true &&
    Array.isArray(module.def.outputs) &&
    module.def.outputs.length > 0
  );
}

/**
 * Risolve il continue-on-fail effettivo combinando il flag dell'ISTANZA del
 * nodo con il default PER-OPERATION (n8n: continueOnFail granulare per
 * specifica operation). Precedenza, dalla più alta:
 *   1. `instanceFlag` esplicito sull'istanza (CanvasNode.continueOnFail)
 *   2. `actionDefault` dichiarato dall'operation selezionata (NodeAction)
 *   3. false (Stop and Error — comportamento storico)
 *
 * Pura + esportata per essere testata in isolamento (no green-smoke: la
 * precedenza è la regola di sicurezza e va provata su ogni combinazione).
 */
export function resolveContinueOnFail(
  instanceFlag: boolean | undefined,
  actionDefault: boolean | undefined,
): boolean {
  return instanceFlag ?? actionDefault ?? false;
}

/**
 * Decide se un errore è un "soft-fail" (il run prosegue) con granularità per
 * CATEGORIA. Regole, in ordine:
 *   1. continueOnFail non attivo → MAI soft (fatal).
 *   2. attivo + nessun filtro categorie → soft su QUALSIASI errore (booleano storico).
 *   3. attivo + filtro categorie + errore classificato → soft solo se la categoria
 *      è nel filtro.
 *   4. attivo + filtro categorie + errore NON classificabile → FATAL (fail-safe:
 *      l'utente ha ristretto esplicitamente, non possiamo garantire sia sicuro).
 * Pura + esportata: la precedenza è una regola di sicurezza, va testata su ogni combo.
 */
export function shouldSoftFail(
  effectiveContinueOnFail: boolean,
  continueOnFailOn: readonly NodeErrorCategory[] | undefined,
  errorCategory: NodeErrorCategory | null,
): boolean {
  if (!effectiveContinueOnFail) return false;
  if (!continueOnFailOn || continueOnFailOn.length === 0) return true;
  if (!errorCategory) return false;
  return continueOnFailOn.includes(errorCategory);
}

function safeStringify(value: unknown): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > 32_000
      ? `${s.slice(0, 32_000)}…[truncated ${(s.length - 32_000).toString()} bytes]`
      : s;
  } catch {
    return '<unserializable>';
  }
}

// ──────────────────────────────────────────────────────────────
// WorkflowEngine
// ──────────────────────────────────────────────────────────────

export class WorkflowEngine implements INodeExecutor {
  private readonly nodeRegistry: readonly NodeModule[];
  private readonly pauseHandler: IPauseHandler;
  private readonly checkpointHandler: ICheckpointHandler;
  private readonly llmProviders: ILlmProviderRegistry;
  private readonly globalVariables: IGlobalVariableRegistry;
  private readonly binaryStore: IBinaryStore;
  private readonly checkpointEveryNodes: number;
  private readonly iteration: IterationCoordinator;
  private readonly dispatchStrategies: readonly INodeDispatchStrategy[];

  constructor(
    private readonly eventBus: IEventBus,
    options: WorkflowEngineOptions = {},
  ) {
    this.nodeRegistry = options.nodeRegistry ?? ALL_NODE_MODULES;
    this.pauseHandler = options.pauseHandler ?? noopPauseHandler;
    this.checkpointHandler = options.checkpointHandler ?? noopCheckpointHandler;
    this.llmProviders = options.llmProviders ?? noopLlmProviderRegistry;
    this.globalVariables = options.globalVariables ?? noopGlobalVariableRegistry;
    this.binaryStore = options.binaryStore ?? noopBinaryStore;
    this.checkpointEveryNodes =
      options.checkpointEveryNodes ?? Number(process.env.MEDEA_CHECKPOINT_EVERY_NODES ?? 5);
    this.dispatchStrategies = options.dispatchStrategies ?? DEFAULT_DISPATCH_STRATEGIES;
    // IterationCoordinator delegates node execution back to this engine
    // via the INodeExecutor interface — we are both client and provider
    // of that contract, no circular import.
    this.iteration = new IterationCoordinator(this);
  }

  /** Resolve a NodeModule by defId. Public — used by IterationCoordinator. */
  resolveNodeModule(defId: string): NodeModule | undefined {
    return (
      this.nodeRegistry.find((n) => n.def.id === defId) ??
      findStdlibNode(defId) ??
      resolveCustomNodeModule(defId) ??
      resolveCommunityNodeModule(defId)
    );
  }

  /**
   * Start a fresh run of the workflow. Triggers `run.started`, executes
   * the BFS, and returns when the workflow completes, fails, or pauses.
   */
  async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    const runId = input.runId ?? nanoid();
    const startedAt = Date.now();
    const tenantId = input.tenantId ?? input.workflow.tenantId ?? 'default';

    this.eventBus.emit({
      name: 'run.started',
      tenantId,
      data: { runId, workflowId: input.workflow.id, triggeredBy: input.triggeredBy },
      ts: new Date().toISOString(),
    });

    const adj = buildAdjacency(input.workflow);
    const queue = findRoots(input.workflow, adj).map((root) => ({
      nodeId: root.id,
      carriedInput: input.triggerInput,
    }));

    return this.executeFromQueue({
      runId,
      startedAt,
      workflow: input.workflow,
      tenantId,
      adj,
      queue,
      visited: new Set<string>(),
      outputsById: new Map<string, unknown>(),
      stepsSoFar: [],
      errorCountSoFar: 0,
      ...(input.pinnedOutputs ? { pinnedOutputs: input.pinnedOutputs } : {}),
      ...(input.cancelSignal ? { cancelSignal: input.cancelSignal } : {}),
      ...(input.subworkflowDepth !== undefined ? { subworkflowDepth: input.subworkflowDepth } : {}),
      ...(input.stopAfterNodeId !== undefined ? { stopAfterNodeId: input.stopAfterNodeId } : {}),
    });
  }

  /**
   * Resume execution from a persisted snapshot. Used by signal-driven
   * resume (async frames) and by checkpoint recovery (crash recovery).
   *
   * The caller is responsible for seeding pendingQueue with the correct
   * post-pause edges (for wait_signal: the edges leaving the wait node
   * with the signal payload as carriedInput).
   */
  async resume(snapshot: EngineSnapshot, workflow: Workflow): Promise<WorkflowRunResult> {
    const adj = buildAdjacency(workflow);
    this.eventBus.emit({
      name: 'run.resumed',
      tenantId: snapshot.tenantId,
      data: { runId: snapshot.runId, workflowId: workflow.id },
      ts: new Date().toISOString(),
    });
    return this.executeFromQueue({
      runId: snapshot.runId,
      startedAt: snapshot.startedAt,
      workflow,
      tenantId: snapshot.tenantId,
      adj,
      queue: snapshot.pendingQueue.slice(),
      visited: new Set(snapshot.visited),
      outputsById: new Map(snapshot.outputsById),
      // GAP #2: ripristina il lineage dei nodi pre-pausa (i ref nel grafo
      // sono già arricchiti di sourceNodeId → autosufficienti al resume).
      ...(snapshot.itemGraph !== undefined ? { itemGraph: new Map(snapshot.itemGraph) } : {}),
      stepsSoFar: snapshot.stepsSoFar.slice(),
      errorCountSoFar: snapshot.errorCount,
    });
  }

  /**
   * INodeExecutor.executeNode — public so IterationCoordinator can reuse it.
   * Encapsulates: pinned-output bypass, special-case nodes (if/delay),
   * trigger pass-through, executor lookup, retry policy, step assembly,
   * and event emission.
   */
  async executeNode(args: ExecuteNodeArgs): Promise<{
    output: unknown;
    chosenBranch: string | undefined;
    step: RunStep;
    items?: ExecutionItem[];
    quotaError?: QuotaPauseError;
  }> {
    const {
      node,
      module,
      carriedInput,
      outputsById,
      pinnedOutputs,
      tenantId,
      runId,
      workflowId,
      loop,
    } = args;
    const stepStartedAt = Date.now();

    const step: RunStep = {
      nodeId: node.id,
      // defId esposto sul singolo step così la Dashboard live può fare
      // lookup in nodeMeta (icona + label italiana) senza dover ripescare
      // l'intera struttura del workflow dal payload del run.
      defId: node.defId,
      nodeLabel: module?.def.label ?? node.defId,
      ...(module?.def.icon !== undefined ? { nodeIcon: module.def.icon } : {}),
      status: 'running',
      input: safeStringify(carriedInput),
      output: '',
      startedAt: stepStartedAt,
      nodeConfig: node.config,
    };
    if (loop) {
      step.iterationIndex = loop.index;
      step.iterationTotal = loop.total;
      step.loopId = loop.loopId;
    }

    // Sticky frames / note sono UI-only — non hanno executor, non sono parte
    // del flow di esecuzione. Skip silenzioso (status='skipped') invece di error.
    // Pattern n8n: i sticky non sono eseguiti, sono solo annotazioni visuali.
    if (node.defId === 'note') {
      step.status = 'skipped';
      step.endedAt = Date.now();
      step.durationMs = step.endedAt - stepStartedAt;
      this.eventBus.emit({
        name: 'run.step',
        tenantId,
        data: { runId, step },
        ts: new Date().toISOString(),
      });
      return { output: undefined, chosenBranch: undefined, step };
    }

    if (!module) {
      step.status = 'error';
      step.error = `Unknown node def: ${node.defId}`;
      step.endedAt = Date.now();
      step.durationMs = step.endedAt - stepStartedAt;
      this.eventBus.emit({
        name: 'run.step',
        tenantId,
        data: { runId, step },
        ts: new Date().toISOString(),
      });
      return { output: undefined, chosenBranch: undefined, step };
    }

    // #226 Cappella Sistina+ logging — collector PRIMA del try outer così
    // anche nel catch path possiamo persistere step.logs (un nodo che fallisce
    // ha SEMPRE bisogno di mostrare i suoi logs all'utente, sennò non capisce
    // perché è fallito).
    const { LogCollector } = await import('@/services/runs/log-collector.js');
    const collector = new LogCollector({
      runId,
      stepNodeId: node.id,
      workspaceId: tenantId,
      minLevel:
        (process.env.MEDEA_LOG_MIN_LEVEL as
          | 'trace'
          | 'debug'
          | 'info'
          | 'warn'
          | 'error'
          | 'fatal'
          | undefined) ?? 'debug',
    });
    step.spanId = collector.spanId;
    step.traceId = collector.traceId;
    // SSE live: ogni entry pushata al run.step.log channel mentre si esegue.
    const liveDispose = collector.on((entry) => {
      this.eventBus.emit({
        name: 'run.step.log',
        tenantId,
        data: { runId, nodeId: node.id, entry },
        ts: new Date().toISOString(),
      });
    });
    const finalizeLogs = (): void => {
      const collected = collector.collect();
      if (collected.logs.length > 0) {
        step.logs = collected.logs;
        step.logsTotal = collected.total;
        if (collected.truncated) step.logsTruncated = true;
      }
    };

    try {
      const vars: Record<string, unknown> = Object.fromEntries(outputsById);
      // Alias projection: for every node that has a user-defined `name`,
      // also expose the output under that alias so `$node.<alias>.json`
      // resolves. Aliases NEVER shadow the canonical id-keyed entry — both
      // coexist, so old expressions keep working after a rename.
      if (args.nodeAliases) {
        for (const [id, alias] of args.nodeAliases.entries()) {
          if (outputsById.has(id)) vars[alias] = outputsById.get(id);
        }
      }
      // Inject __env so `$env.KEY` shortcuts resolve at evaluation time.
      // Per-tenant lookup, computed once per node execution.
      const tenantVars = this.globalVariables.getEnv(tenantId);
      vars.__env = tenantVars;
      // `secrets` scope key: alias semantico delle tenant_variables, accessibile
      // come `{{secrets.NAME}}` nei template (convenzione documentata nei prompt
      // LLM, nei nodi action_send_email, action_http, ecc). Stesso dataset di
      // `$env.NAME` ma con naming corretto per il caso d'uso "API key / SMTP
      // password / DKIM private key" — separazione semantica vs `vars`
      // (workflow-scope, mutabile durante il run).
      const scope: InterpreterScope = {
        input: carriedInput,
        ctx: { tenantId, runId, workflowId, nodeId: node.id },
        vars,
        secrets: tenantVars,
        workflow: { id: workflowId },
        execution: { id: runId },
      };
      if (loop !== undefined) {
        scope.item = loop.item;
        scope.index = loop.index;
        scope.loop = loop;
      }
      // GAP #2 (paired items): ancora il lineage all'item di INPUT corrente
      // (S, i) — S = nodo che ha prodotto l'input, i = indice nel fan-out
      // (0 fuori). NON all'output del nodo corrente: non è ancora nel grafo.
      // Senza sorgente (root/trigger) la semantica paired non è definita →
      // scope.lineage assente, gli accessor ritornano undefined (onesto).
      if (args.lineage?.sourceNodeId !== undefined) {
        scope.lineage = {
          graph: args.lineage.graph,
          nodeId: args.lineage.sourceNodeId,
          itemIndex: loop?.index ?? 0,
          predecessorOf: args.lineage.predecessorOf,
        };
      }
      const interpolatedConfig = interpolateConfig(node.config, scope);

      const dispatchCtx: DispatchContext = {
        node,
        module,
        interpolatedConfig,
        carriedInput,
        scope,
        tenantId,
        runId,
        workflowId,
        llmProviders: this.llmProviders,
        binaryStore: this.binaryStore,
        logCollector: collector,
      };
      if (pinnedOutputs !== undefined) dispatchCtx.pinnedOutputs = pinnedOutputs;
      if (args.subworkflowDepth !== undefined) dispatchCtx.subworkflowDepth = args.subworkflowDepth;

      const { output, chosenBranch, retries, items } = await this.runDispatchChain(dispatchCtx);
      if (retries > 0) step.retry = retries;

      step.status = 'success';
      step.output = typeof output === 'string' ? output : JSON.stringify(output);
      step.endedAt = Date.now();
      step.durationMs = step.endedAt - stepStartedAt;
      finalizeLogs();
      liveDispose();
      this.eventBus.emit({
        name: 'run.step',
        tenantId,
        data: { runId, step },
        ts: new Date().toISOString(),
      });
      return { output, chosenBranch, step, ...(items !== undefined ? { items } : {}) };
    } catch (error) {
      step.status = 'error';
      step.error = error instanceof Error ? error.message : String(error);
      // Propaga il code tipizzato + la CATEGORIA (calcolata con l'istanza
      // completa → retryable corretto per HTTP). La UI mappa su azione; il
      // continue-on-fail per-categoria usa la categoria già risolta qui.
      if (error instanceof NodeError) {
        step.errorCode = error.code;
        step.errorCategory = categoryOf(error);
      }
      step.endedAt = Date.now();
      step.durationMs = step.endedAt - stepStartedAt;
      // #226 anche nel catch path: salva i logs catturati FINO al throw.
      // Questo include il `collector.debug([custom-node] dispatching)` E i
      // logs del sandbox forwarded prima del fail.
      collector.error(
        `Node execution failed: ${step.error}`,
        error instanceof NodeError ? { code: error.code } : undefined,
      );
      finalizeLogs();
      liveDispose();
      logger.warn({ nodeId: node.id, err: error }, 'Node execution failed');
      this.eventBus.emit({
        name: 'run.step',
        tenantId,
        data: { runId, step },
        ts: new Date().toISOString(),
      });
      // Quota LLM esaurita (no BYOK): l'errore (anche se wrappato in NodeError dal
      // middleware, originale in .cause) segnala al BFS di SOSPENDERE il run e
      // riprenderlo al rinnovo, invece di fallire. Vedi engine/quota-pause.ts.
      const quotaError = asQuotaPauseError(error);
      return {
        output: undefined,
        chosenBranch: undefined,
        step,
        ...(quotaError ? { quotaError } : {}),
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────

  /**
   * Walk the dispatch chain — first strategy whose match() returns true
   * runs the node. The chain is configurable via WorkflowEngineOptions
   * so tests can inject a custom set. See engine/strategies/ for the
   * five default strategies and their ordering rationale.
   *
   * Replaces the old monolithic dispatchNode/runWithRetry pair —
   * Pinned/If/Delay/Trigger/Executor each live in their own file now.
   */
  /**
   * GAP 1 — Visible Auto-Map: esegue il nodo UNA VOLTA PER ELEMENTO dell'array
   * in ingresso (fan-out dichiarato sull'edge, MAI implicito).
   *
   * GARANZIE (il lineage anti-footgun che n8n non dà):
   *  - `results` è ALLINEATO PER INDICE all'input: item i → results[i]. Anche
   *    un item soft-failed (continue-on-fail) occupa la SUA posizione con un
   *    error-item `{error:{...,index:i}}` — il pairing a valle è deterministico
   *    by-construction, niente `$itemMatching`.
   *  - Ogni item produce il SUO RunStep con iterationIndex/iterationTotal e
   *    loopId `map:<nodeId>` → fan-out osservabile in UI (badge ×N) e nei log.
   *  - Item error FATALE (no continue-on-fail) → fan-out troncato, semantica
   *    Stop-and-Error standard (il chiamante segue solo gli error-edge).
   *  - Cap anti-runaway dedicato (MEDEA_ENGINE_MAX_MAP_ITEMS, default 1000)
   *    → violazione = errore ESPLICITO, mai esecuzione parziale silenziosa.
   */
  private async executeFanOut(fanArgs: {
    node: CanvasNode;
    module: NodeModule;
    items: readonly unknown[];
    outputsById: Map<string, unknown>;
    nodeAliases: Map<string, string>;
    tenantId: string;
    runId: string;
    workflowId: string;
    steps: RunStep[];
    pinnedOutputs?: Map<string, unknown>;
    cancelSignal?: AbortSignal;
    subworkflowDepth?: number;
    /**
     * GAP #2: lineage bits del BFS. `lineage.sourceNodeId` = il nodo che ha
     * prodotto l'ARRAY su cui stiamo fanning-out — l'item corrente della
     * iterazione i è (S, i), così `$('S').item` (e a ritroso) risolve
     * DENTRO ogni esecuzione per-item.
     */
    lineage?: NodeLineageArgs;
  }): Promise<{ results: unknown[]; fatal: boolean; fatalErrors: number }> {
    const { node, module, items, steps, tenantId, runId } = fanArgs;
    const maxItems = Number(process.env.MEDEA_ENGINE_MAX_MAP_ITEMS ?? '1000');
    const emitStep = (step: RunStep): void => {
      this.eventBus.emit({
        name: 'run.step',
        tenantId,
        data: { runId, step },
        ts: new Date().toISOString(),
      });
    };
    if (items.length > maxItems) {
      const message = `Edge map: ${String(items.length)} item superano il cap ${String(maxItems)} (MEDEA_ENGINE_MAX_MAP_ITEMS). Filtra a monte o usa logic_loop con strategy batch.`;
      const errStep: RunStep = {
        nodeId: node.id,
        nodeLabel: module.def.label,
        status: 'error',
        output: '',
        startedAt: Date.now(),
        endedAt: Date.now(),
        durationMs: 0,
        error: message,
        nodeConfig: node.config,
      };
      if (module.def.icon !== undefined) errStep.nodeIcon = module.def.icon;
      steps.push(errStep);
      emitStep(errStep);
      return { results: [], fatal: true, fatalErrors: 1 };
    }

    const results: unknown[] = [];
    const actionDefault = module.def.actions?.find(
      (a) => a.id === node.config.__action,
    )?.continueOnFailDefault;
    const effectiveContinueOnFail = resolveContinueOnFail(node.continueOnFail, actionDefault);
    for (let i = 0; i < items.length; i += 1) {
      if (fanArgs.cancelSignal?.aborted) {
        throw new DOMException(`Run ${runId} cancelled by user`, 'AbortError');
      }
      const res = await this.executeNode({
        node,
        module,
        carriedInput: items[i],
        outputsById: fanArgs.outputsById,
        nodeAliases: fanArgs.nodeAliases,
        tenantId,
        runId,
        workflowId: fanArgs.workflowId,
        loop: {
          item: items[i],
          index: i,
          total: items.length,
          first: i === 0,
          last: i === items.length - 1,
          loopId: `map:${node.id}`,
          strategy: 'naive',
        },
        ...(fanArgs.pinnedOutputs ? { pinnedOutputs: fanArgs.pinnedOutputs } : {}),
        ...(fanArgs.subworkflowDepth !== undefined
          ? { subworkflowDepth: fanArgs.subworkflowDepth }
          : {}),
        ...(fanArgs.lineage !== undefined ? { lineage: fanArgs.lineage } : {}),
      });
      steps.push(res.step);
      if (res.step.status === 'error') {
        const softened = shouldSoftFail(
          effectiveContinueOnFail,
          node.continueOnFailOn,
          res.step.errorCategory ?? null,
        );
        if (softened) {
          res.step.continued = true;
          // L'error-item OCCUPA la posizione i → allineamento per indice intatto.
          results.push({
            error: {
              message: res.step.error ?? 'item failed',
              nodeId: node.id,
              defId: module.def.id,
              index: i,
            },
          });
          continue;
        }
        // FATALE: tronca. I risultati processati restano allineati (0..i-1).
        return { results, fatal: true, fatalErrors: 1 };
      }
      results.push(res.output);
    }
    return { results, fatal: false, fatalErrors: 0 };
  }

  private async runDispatchChain(ctx: DispatchContext): Promise<DispatchResult> {
    for (const strategy of this.dispatchStrategies) {
      if (strategy.match(ctx)) return strategy.execute(ctx);
    }
    // Defensive: this should never happen because NodeExecutorStrategy
    // is a catch-all. If we get here, someone removed it from the chain.
    throw new Error(
      `No dispatch strategy matched node ${ctx.node.id} (defId=${ctx.module.def.id}). ` +
        'Did you remove NodeExecutorStrategy from the chain?',
    );
  }

  /**
   * Core BFS loop. Walks the graph, delegates loop/wait_signal handling,
   * emits checkpoints. Used by both `run()` (fresh) and `resume()` (after
   * pause or crash).
   */
  private async executeFromQueue(args: {
    runId: string;
    startedAt: number;
    workflow: Workflow;
    tenantId: string;
    adj: AdjacencyMap;
    queue: QueueItem[];
    visited: Set<string>;
    outputsById: Map<string, unknown>;
    stepsSoFar: RunStep[];
    errorCountSoFar: number;
    pinnedOutputs?: Map<string, unknown>;
    cancelSignal?: AbortSignal;
    /** N17 audit: subworkflow depth carried into every executeNode call. */
    subworkflowDepth?: number;
    /** GAP 4: dopo questo nodo il run si ferma (coda residua scartata). */
    stopAfterNodeId?: string;
    /** GAP #2: grafo lineage ripristinato da uno snapshot (resume). */
    itemGraph?: RunItemGraph;
  }): Promise<WorkflowRunResult> {
    const { runId, startedAt, workflow, tenantId, adj, queue, visited, outputsById } = args;
    const steps = args.stepsSoFar;
    let errorCount = args.errorCountSoFar;
    // Compute name aliases ONCE per run. Cheap (workflow.nodes typically < 50).
    const nodeAliases = buildAliasMap(workflow.nodes);
    let pausedId: string | undefined;
    let pausedOnSignal: string | undefined;
    let stepCountSinceCheckpoint = 0;

    // GAP #2 (paired items, fase 4.2): companion di outputsById. outputsById
    // porta il DATO che viaggia sugli edge (blob); itemGraph la vista
    // ExecutionItem[] con lineage, che resolvePairedItem cammina a ritroso per
    // `$('Node').item`/`itemMatching`. predecessorByNode = fallback per i ref
    // dichiarati dagli executor senza sourceNodeId. Il grafo PERSISTE negli
    // snapshot (pause/checkpoint, item_graph_json) e viene ripristinato al
    // resume via args.itemGraph: i ref sono già arricchiti di sourceNodeId
    // alla registrazione → autosufficienti, nessuna predecessor-map da salvare.
    const itemGraph: RunItemGraph = args.itemGraph ?? new Map<string, ExecutionItem[]>();
    const predecessorByNode = new Map<string, string>();
    const lineagePredecessorOf = (n: string): string | undefined => predecessorByNode.get(n);

    // AUDIT FIX WE-6 (2026-06-09 HIGH): hard caps anti-runaway.
    //
    // Pre-fix: BFS girava finché queue vuota. Workflow malformati (cycle che
    // visited NON cattura, fan-out N edges deep), loop_logic re-entrant, e
    // outputsById che accumula OGNI nodo output per la run intera (1000-node
    // ETL con 100KB payload = 100MB tenuti vivi fino a fine) → OOM container
    // sotto carico.
    //
    // Fix: 3 hard cap:
    //   - MAX_STEP_COUNT: 10_000 step assoluti (workflow business raro >2000)
    //   - MAX_RUN_DURATION_MS: 30min (configurabile per plan tier futuro)
    //   - MAX_QUEUE_SIZE: 5000 entries (fan-out 5000 edges = bug, NON business)
    // Su threshold → throw RunQuotaExceededError, run marcato 'error' con
    // motivazione esplicita. Audit log include il cap hit per ops visibility.
    const MAX_STEP_COUNT = Number(process.env.MEDEA_ENGINE_MAX_STEPS ?? '10000');
    const MAX_RUN_DURATION_MS = Number(
      process.env.MEDEA_ENGINE_MAX_RUN_DURATION_MS ?? String(30 * 60_000),
    );
    const MAX_QUEUE_SIZE = Number(process.env.MEDEA_ENGINE_MAX_QUEUE_SIZE ?? '5000');
    let totalStepsExecuted = 0;

    while (queue.length > 0) {
      // WE-6 cap checks PRIMA del dispatch.
      if (totalStepsExecuted >= MAX_STEP_COUNT) {
        throw new Error(
          `Engine cap hit: max-step-count=${String(MAX_STEP_COUNT)} (workflow=${workflow.id})`,
        );
      }
      if (Date.now() - startedAt > MAX_RUN_DURATION_MS) {
        throw new Error(
          `Engine cap hit: max-run-duration=${String(MAX_RUN_DURATION_MS)}ms (workflow=${workflow.id})`,
        );
      }
      if (queue.length > MAX_QUEUE_SIZE) {
        throw new Error(
          `Engine cap hit: max-queue-size=${String(MAX_QUEUE_SIZE)} (workflow=${workflow.id})`,
        );
      }
      totalStepsExecuted += 1;
      // Cooperative cancel check: prima di dispatchare il prossimo nodo,
      // controlla se l'utente ha premuto Stop. Throwiamo DOMException
      // 'AbortError' così il `await` chain risale fino a RunService.run()
      // che lo intercetta come `isAbort` e marca il run 'cancelled'.
      // Mid-node abort (es. dentro a un fetch lungo) lo gestisce il fetch
      // stesso perché passiamo la signal anche ai node executors.
      if (args.cancelSignal?.aborted) {
        throw new DOMException(`Run ${runId} cancelled by user`, 'AbortError');
      }
      const item = queue.shift();
      if (!item) break;
      const { nodeId, carriedInput } = item;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = adj.nodesById.get(nodeId);
      if (!node) continue;
      const module = this.resolveNodeModule(node.defId);

      // GAP #2: ancoraggio lineage del nodo corrente. La sorgente runtime
      // dell'input (item.sourceNodeId) diventa il predecessore registrato e
      // l'ancora (S, i) dello scope paired passato a executeNode.
      if (item.sourceNodeId !== undefined) predecessorByNode.set(nodeId, item.sourceNodeId);
      const lineageArgs: NodeLineageArgs = {
        graph: itemGraph,
        predecessorOf: lineagePredecessorOf,
        ...(item.sourceNodeId !== undefined ? { sourceNodeId: item.sourceNodeId } : {}),
      };

      // ── GAP 1: Visible Auto-Map (edge.mapMode) ────────────────
      // Il fan-out per-item è dichiarato sull'EDGE percorso (item.mapMode).
      // Precedenze: pin globale > fan-out; def sconosciuto → errore standard;
      // nodi branchable/wait/loop → NON mappabili, errore ESPLICITO (mai
      // ambiguità silenziosa); 'auto' su non-array → pass-through standard;
      // 'each' su non-array → violazione di contratto, errore esplicito.
      const mapMode = item.mapMode ?? 'off';
      if (
        mapMode !== 'off' &&
        module !== undefined &&
        args.pinnedOutputs?.get(nodeId) === undefined
      ) {
        const unmappable =
          module.def.id === 'logic_wait_signal' ||
          module.def.id === 'logic_loop' ||
          nodeIsBranchable(module);
        const isArray = Array.isArray(carriedInput);
        if (unmappable || (mapMode === 'each' && !isArray)) {
          const message = unmappable
            ? `Edge mapMode="${mapMode}" su nodo non mappabile (${module.def.id}): branch/wait/loop per-item sarebbe ambiguo. Rimuovi il map dall'edge.`
            : `Edge mapMode="each" richiede un input ARRAY, ricevuto ${carriedInput === null ? 'null' : typeof carriedInput}. Usa "auto" se l'input può non essere una lista.`;
          errorCount += 1;
          const errStep: RunStep = {
            nodeId,
            nodeLabel: module.def.label,
            status: 'error',
            output: '',
            startedAt: Date.now(),
            endedAt: Date.now(),
            durationMs: 0,
            error: message,
            nodeConfig: node.config,
          };
          if (module.def.icon !== undefined) errStep.nodeIcon = module.def.icon;
          steps.push(errStep);
          this.eventBus.emit({
            name: 'run.step',
            tenantId,
            data: { runId, step: errStep },
            ts: new Date().toISOString(),
          });
          // Semantica fatale standard: prosegue SOLO sugli error-edge.
          for (const edge of (adj.outgoing.get(nodeId) ?? []).filter(
            (e) => e.fromPort === 'error',
          )) {
            queue.push({
              nodeId: edge.to,
              carriedInput: { error: { message, nodeId } },
              mapMode: edge.mapMode,
              sourceNodeId: nodeId,
            });
          }
          if (args.stopAfterNodeId === nodeId) break;
          continue;
        }
        if (isArray) {
          const items = carriedInput as unknown[];
          // Anti-runaway WE-6: ogni item conta come step + cap dedicato.
          totalStepsExecuted += items.length;
          const fan = await this.executeFanOut({
            node,
            module,
            items,
            outputsById,
            nodeAliases,
            tenantId,
            runId,
            workflowId: workflow.id,
            steps,
            lineage: lineageArgs,
            ...(args.pinnedOutputs ? { pinnedOutputs: args.pinnedOutputs } : {}),
            ...(args.cancelSignal ? { cancelSignal: args.cancelSignal } : {}),
            ...(args.subworkflowDepth !== undefined
              ? { subworkflowDepth: args.subworkflowDepth }
              : {}),
          });
          errorCount += fan.fatalErrors;
          outputsById.set(nodeId, fan.results);
          // GAP #2: il mapping del fan-out è noto by-construction (results[i]
          // deriva dall'item i della sorgente) — lineage esatto, anche per gli
          // error-item soft-failed che OCCUPANO la loro posizione i.
          itemGraph.set(nodeId, deriveFanOutItems(fan.results, item.sourceNodeId));
          const downstream = adj.outgoing.get(nodeId) ?? [];
          const toFollow = fan.fatal
            ? downstream.filter((e) => e.fromPort === 'error')
            : downstream.filter((e) => e.fromPort !== 'error');
          for (const edge of toFollow) {
            queue.push({
              nodeId: edge.to,
              carriedInput: fan.results,
              mapMode: edge.mapMode,
              sourceNodeId: nodeId,
            });
          }
          stepCountSinceCheckpoint += items.length;
          if (args.stopAfterNodeId === nodeId) break;
          continue;
        }
        // mapMode==='auto' su input non-array → pass-through standard sotto.
      }

      // ── Async frame: wait_signal ──────────────────────────────
      if (module?.def.id === 'logic_wait_signal') {
        const pauseInfo = this.suspendOnSignal({
          node,
          module,
          carriedInput,
          queue,
          outputsById,
          visited,
          itemGraph,
          runId,
          tenantId,
          workflowId: workflow.id,
          steps,
        });
        pausedId = pauseInfo.pausedId;
        pausedOnSignal = pauseInfo.signalName;
        break;
      }

      // ── Loop node: delegate to the IterationCoordinator ───────
      if (module?.def.id === 'logic_loop') {
        try {
          const loopResult = await this.iteration.executeLoop({
            loopNode: node,
            loopModule: module,
            carriedInput,
            adj,
            // GAP #2: il body risolve $('Sorgente').item per l'iterazione
            // corrente (ancora (S, loop.index) — vedi ExecuteLoopArgs.lineage).
            lineage: lineageArgs,
            ...(args.pinnedOutputs ? { pinnedOutputs: args.pinnedOutputs } : {}),
            tenantId,
            runId,
            workflowId: workflow.id,
            workflow,
            steps,
            outerVisited: visited,
            outerOutputs: outputsById,
            ...(args.subworkflowDepth !== undefined
              ? { subworkflowDepth: args.subworkflowDepth }
              : {}),
          });
          errorCount += loopResult.errors;
          // GAP #2: registra la vista item del loop output. L'euristica
          // conservativa copre il collect 1:1 (N iterazioni → N risultati);
          // cardinalità diverse → niente pairing (onesto). I body node non
          // entrano nel grafo (N esecuzioni non indicizzabili per nodeId) ma
          // il loro scope.lineage risolve la sorgente e tutta la catena a monte.
          itemGraph.set(
            nodeId,
            deriveOutputItems({
              output: loopResult.output,
              ...(item.sourceNodeId !== undefined
                ? {
                    sourceNodeId: item.sourceNodeId,
                    sourceItemCount: itemGraph.get(item.sourceNodeId)?.length ?? 0,
                  }
                : {}),
            }),
          );
          const downstream = adj.outgoing.get(nodeId) ?? [];
          const toFollow = downstream.filter((e) => e.fromPort === loopResult.chosenBranch);
          for (const edge of toFollow) {
            queue.push({
              nodeId: edge.to,
              carriedInput: loopResult.output,
              mapMode: edge.mapMode,
              sourceNodeId: nodeId,
            });
          }
        } catch (err) {
          errorCount += 1;
          const message = err instanceof Error ? err.message : String(err);
          const errStep: RunStep = {
            nodeId,
            nodeLabel: module.def.label,
            status: 'error',
            output: '',
            startedAt: Date.now(),
            endedAt: Date.now(),
            durationMs: 0,
            error: message,
            nodeConfig: node.config,
          };
          if (module.def.icon !== undefined) errStep.nodeIcon = module.def.icon;
          steps.push(errStep);
          this.eventBus.emit({
            name: 'run.step',
            tenantId,
            data: { runId, step: errStep },
            ts: new Date().toISOString(),
          });
        }
        // GAP 4: stop-after anche sul ramo loop (il `continue` sotto salta
        // il check di fine-body del nodo standard).
        if (args.stopAfterNodeId === nodeId) break;
        continue;
      }

      // ── Standard node ────────────────────────────────────────
      const res = await this.executeNode({
        node,
        module,
        carriedInput,
        outputsById,
        nodeAliases,
        lineage: lineageArgs,
        ...(args.pinnedOutputs ? { pinnedOutputs: args.pinnedOutputs } : {}),
        tenantId,
        runId,
        workflowId: workflow.id,
        ...(args.subworkflowDepth !== undefined ? { subworkflowDepth: args.subworkflowDepth } : {}),
      });
      // ── Pausa-su-quota ──────────────────────────────────────────────
      // Quota LLM esaurita (no BYOK): SOSPENDI il run e riprendilo al rinnovo
      // (giorno di abbonamento), invece di fallire. Il nodo viene de-visitato +
      // ri-accodato così al resume si RI-ESEGUE (quota ora rinnovata). Riusa
      // l'infra pause/resume (paused_workflows + timeout janitor). NB: il
      // fan-out map (executeNodeFanOut) non è coperto — lì la quota resta un
      // errore chiaro (pausa mid-fan-out richiederebbe stato parziale).
      if (res.quotaError && module) {
        visited.delete(nodeId);
        queue.unshift(item);
        const pauseInfo = this.suspendOnQuota({
          node,
          module,
          carriedInput,
          queue,
          outputsById,
          visited,
          itemGraph,
          runId,
          tenantId,
          workflowId: workflow.id,
          steps,
          quotaError: res.quotaError,
        });
        pausedId = pauseInfo.pausedId;
        pausedOnSignal = pauseInfo.signalName;
        break;
      }
      steps.push(res.step);

      // ── Versioned Node API: drift di versione del def (n8n typeVersion) ──
      // Confronta la versione PINNATA sull'istanza (node.defVersion, fissata
      // dall'editor al drop) con quella CORRENTE del def caricato dal runtime.
      // Il drift è PURA osservabilità (step.versionDrift) — NON blocca mai il
      // run (backward-compat: i workflow legacy 'unversioned' girano intatti).
      // I drift potenzialmente breaking (major/ahead) vanno a warning per la
      // telemetria, così l'operatore sa che un nodo va rivisto/migrato.
      if (module) {
        const compat = classifyNodeVersionCompat(node.defVersion, module.def.version);
        const drift = nodeVersionDrift(compat);
        if (drift) {
          res.step.versionDrift = drift;
          if (isBreakingNodeVersionDrift(compat)) {
            logger.warn(
              {
                nodeId: node.id,
                defId: module.def.id,
                pinned: node.defVersion,
                current: module.def.version,
                drift,
              },
              'Node version drift (potentially breaking) — workflow node may need migration',
            );
          }
        }
      }

      // ── Continue-on-fail per-nodo (n8n "Continue using error output") ──
      // Se il nodo ha `continueOnFail` e fallisce, NON è un errore fatale:
      // l'errore diventa un error-item passato ai rami NORMALI, il flusso
      // prosegue, e il run NON viene marcato failed (solo i fatal contano in
      // errorCount). `step.continued` rende il soft-fail osservabile nel
      // RunInspector (giallo, non rosso) e nel contatore Dashboard Live.
      //
      // Granularità PER-OPERATION (n8n: continueOnFail per specifica operation):
      // l'operation selezionata (config.__action) può dichiarare un
      // `continueOnFailDefault`. L'istanza lo EREDITA, salvo override esplicito
      // via node.continueOnFail. Precedenza: istanza > default operation > false.
      const actionDefault = module?.def.actions?.find(
        (a) => a.id === node.config.__action,
      )?.continueOnFailDefault;
      const effectiveContinueOnFail = resolveContinueOnFail(node.continueOnFail, actionDefault);
      // Granularità per categoria: usa la categoria già risolta nel catch (con
      // retryable corretto) e prosegui solo se rientra nel filtro dell'istanza.
      // Vuoto = continua su tutto (booleano storico).
      const softFailed =
        res.step.status === 'error' &&
        shouldSoftFail(
          effectiveContinueOnFail,
          node.continueOnFailOn,
          res.step.errorCategory ?? null,
        );
      if (res.step.status === 'error' && !softFailed) errorCount += 1;
      let effectiveOutput = res.output;
      if (softFailed) {
        res.step.continued = true;
        effectiveOutput = {
          error: {
            message: res.step.error ?? 'node failed',
            nodeId,
            ...(module ? { defId: module.def.id } : {}),
          },
        };
      }
      outputsById.set(nodeId, effectiveOutput);

      // GAP #2: vista item-native nel grafo. Fatal → nessun item emesso
      // (lista vuota, onesto: il ramo muore e nulla deriva dal nodo).
      // Soft-fail → l'output effettivo è l'error-item, NON ciò che
      // l'executor aveva dichiarato: si riparte dall'euristica.
      if (res.step.status === 'error' && !softFailed) {
        itemGraph.set(nodeId, []);
      } else {
        itemGraph.set(
          nodeId,
          deriveOutputItems({
            output: effectiveOutput,
            ...(softFailed || res.items === undefined ? {} : { declared: res.items }),
            ...(item.sourceNodeId !== undefined
              ? {
                  sourceNodeId: item.sourceNodeId,
                  sourceItemCount: itemGraph.get(item.sourceNodeId)?.length ?? 0,
                }
              : {}),
          }),
        );
      }

      // GAP 4 (esecuzione parziale): il nodo target ha completato → stop.
      // I downstream NON vengono accodati e la coda residua viene scartata
      // dal break. L'output del nodo resta in outputsById/steps per la UI.
      if (args.stopAfterNodeId === nodeId) break;

      const downstream = adj.outgoing.get(nodeId) ?? [];
      let toFollow: Edge[];
      if (res.step.status === 'error' && !softFailed) {
        // Error path: only follow edges explicitly labelled as error handlers
        // (fromPort === 'error'). Without an error edge, the branch DIES
        // here — downstream nodes don't run with undefined input. This
        // matches n8n's "Stop and Error" semantics and prevents the cascade
        // we saw in the WF1 dry-run (save_order fails → 4 nodes ran on
        // undefined → bogus emails sent, FK constraint violations).
        toFollow = downstream.filter((edge) => edge.fromPort === 'error');
      } else if (module && nodeIsBranchable(module) && res.chosenBranch !== undefined) {
        toFollow = downstream.filter((edge) => edge.fromPort === res.chosenBranch);
      } else {
        // Healthy node OR soft-failed (continue-on-fail): segue i rami NORMALI
        // (esclusi gli error-only port). Nel caso soft-fail i downstream
        // ricevono l'error-item come input e proseguono.
        toFollow = downstream.filter((edge) => edge.fromPort !== 'error');
      }
      for (const edge of toFollow) {
        queue.push({
          nodeId: edge.to,
          carriedInput: effectiveOutput,
          mapMode: edge.mapMode,
          sourceNodeId: nodeId,
        });
      }

      // ── Periodic checkpoint ──────────────────────────────────
      stepCountSinceCheckpoint += 1;
      if (stepCountSinceCheckpoint >= this.checkpointEveryNodes) {
        try {
          this.checkpointHandler.save({
            runId,
            workflowId: workflow.id,
            tenantId,
            atNodeId: nodeId,
            outputsById,
            visited,
            pendingQueue: queue.slice(),
            itemGraph,
            stepCount: steps.length,
          });
        } catch (cpErr) {
          logger.warn({ err: cpErr, runId }, 'Checkpoint save failed (non-fatal)');
        }
        stepCountSinceCheckpoint = 0;
      }
    }

    const totalDurationMs = Date.now() - startedAt;
    const status: WorkflowRunResult['status'] =
      pausedId !== undefined
        ? 'paused'
        : errorCount === 0
          ? 'success'
          : errorCount === steps.length
            ? 'error'
            : 'partial';

    this.eventBus.emit({
      name:
        status === 'error' ? 'run.errored' : status === 'paused' ? 'run.paused' : 'run.completed',
      tenantId,
      data: {
        runId,
        status,
        totalDurationMs,
        errorCount,
        stepsCount: steps.length,
        pausedId,
        pausedOnSignal,
      },
      ts: new Date().toISOString(),
    });

    const result: WorkflowRunResult = { runId, status, steps, totalDurationMs, errorCount };
    if (pausedId !== undefined) result.pausedId = pausedId;
    if (pausedOnSignal !== undefined) result.pausedOnSignal = pausedOnSignal;
    return result;
  }

  /**
   * Suspend the workflow on a wait_signal node. Evaluates the match-value
   * expression at pause time so the future signal can be dispatched only
   * to the right paused row. State is persisted via the injected handler.
   */
  private suspendOnSignal(args: {
    node: CanvasNode;
    module: NodeModule;
    carriedInput: unknown;
    queue: QueueItem[];
    outputsById: Map<string, unknown>;
    visited: Set<string>;
    /** GAP #2: lineage della run, persiste con la pausa per il resume. */
    itemGraph: RunItemGraph;
    runId: string;
    tenantId: string;
    workflowId: string;
    steps: RunStep[];
  }): { pausedId: string; signalName: string } {
    const {
      node,
      module,
      carriedInput,
      queue,
      outputsById,
      visited,
      itemGraph,
      runId,
      tenantId,
      workflowId,
      steps,
    } = args;
    const signalName = String(node.config.signalName ?? '');
    const timeoutSeconds = Math.max(0, Number(node.config.timeoutSeconds ?? 2_592_000));
    let defaultPayload: unknown = {};
    try {
      defaultPayload = JSON.parse(String(node.config.defaultPayload ?? '{}'));
    } catch {
      /* keep {} */
    }

    // Evaluate the optional match-value expression so the SignalService
    // can route a single signal to the right paused workflow.
    const matchKey = String(node.config.matchKey ?? '');
    const matchValueExpr = String(node.config.matchValue ?? '');
    let matchValue: string | undefined;
    if (matchValueExpr) {
      try {
        const scope: InterpreterScope = {
          input: carriedInput,
          ctx: { tenantId, runId, workflowId, nodeId: node.id },
          vars: Object.fromEntries(outputsById),
          secrets: this.globalVariables.getEnv(tenantId),
          workflow: { id: workflowId },
          execution: { id: runId },
        };
        const evaluated = evaluateExpression(matchValueExpr, scope);
        matchValue =
          evaluated === null || evaluated === undefined ? undefined : coerceString(evaluated);
      } catch (err) {
        logger.warn(
          { err, nodeId: node.id },
          'wait_signal: matchValue expression failed — proceeding without match',
        );
      }
    }

    const pauseStep: RunStep = {
      nodeId: node.id,
      nodeLabel: module.def.label,
      status: 'paused',
      input: safeStringify(carriedInput),
      output: JSON.stringify({ pausedOnSignal: signalName, timeoutSeconds, matchKey, matchValue }),
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 0,
      nodeConfig: node.config,
    };
    if (module.def.icon !== undefined) pauseStep.nodeIcon = module.def.icon;
    steps.push(pauseStep);

    this.eventBus.emit({
      name: 'run.paused',
      tenantId,
      data: { runId, signalName, atNodeId: node.id },
      ts: new Date().toISOString(),
    });

    const pausedId = this.pauseHandler.pause({
      runId,
      workflowId,
      tenantId,
      signalName,
      atNodeId: node.id,
      outputsById,
      visited,
      pendingQueue: queue.slice(),
      itemGraph,
      timeoutSeconds,
      defaultPayload,
      ...(matchKey !== '' ? { matchKey } : {}),
      ...(matchValue !== undefined ? { matchValue } : {}),
    });

    return { pausedId, signalName };
  }

  /**
   * Sospende il run su QUOTA esaurita (no BYOK): persiste lo stato via
   * pauseHandler con `signalName=quota:renewed:<tenant>` e `timeout=al rinnovo`
   * (periodEnd). Il chiamante ha già de-visitato + ri-accodato il nodo LLM, così
   * la `pendingQueue` persistita lo contiene → al resume si RI-ESEGUE. Riusa
   * `paused_workflows` + il timeout janitor; `resumeFromPause` NON semina il
   * downstream per le pause-quota (vedi run.service). Niente migration.
   */
  private suspendOnQuota(args: {
    node: CanvasNode;
    module: NodeModule;
    carriedInput: unknown;
    queue: QueueItem[];
    outputsById: Map<string, unknown>;
    visited: Set<string>;
    itemGraph: RunItemGraph;
    runId: string;
    tenantId: string;
    workflowId: string;
    steps: RunStep[];
    quotaError: QuotaPauseError;
  }): { pausedId: string; signalName: string } {
    const {
      node,
      module,
      carriedInput,
      queue,
      outputsById,
      visited,
      itemGraph,
      runId,
      tenantId,
      workflowId,
      steps,
      quotaError,
    } = args;
    const signalName = quotaResumeSignal(tenantId);
    const timeoutSeconds = secondsUntilQuotaReset(quotaError.periodEndIso);

    const pauseStep: RunStep = {
      nodeId: node.id,
      nodeLabel: module.def.label,
      status: 'paused',
      input: safeStringify(carriedInput),
      output: JSON.stringify({
        pausedOnQuota: true,
        signalName,
        timeoutSeconds,
        periodEndIso: quotaError.periodEndIso,
      }),
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 0,
      nodeConfig: node.config,
    };
    if (module.def.icon !== undefined) pauseStep.nodeIcon = module.def.icon;
    steps.push(pauseStep);

    this.eventBus.emit({
      name: 'run.paused',
      tenantId,
      data: { runId, signalName, atNodeId: node.id },
      ts: new Date().toISOString(),
    });

    const pausedId = this.pauseHandler.pause({
      runId,
      workflowId,
      tenantId,
      signalName,
      atNodeId: node.id,
      outputsById,
      visited,
      pendingQueue: queue.slice(),
      itemGraph,
      timeoutSeconds,
      defaultPayload: {},
    });

    return { pausedId, signalName };
  }
}
