import type { NodeDef, BinaryData, ExecutionItem } from '@medea/engine-core-schema';

// node:stream solo come TIPO (mai valore) → forma `import('node:stream')` inline
// per non emettere un import statico node:* (rompe il bundle Vite editor). Stessa
// ragione della regola no-restricted-imports su node:*.
type Readable = import('node:stream').Readable;

/**
 * NodeExecutionContext is what each node executor receives at runtime.
 * Mirrors apps/runtime/src/ports/tool-executor.ts but is duplicated here
 * to avoid stdlib depending on the runtime app (would break port&adapter).
 */
export interface NodeExecutionContext {
  tenantId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  /**
   * The NodeDef.id of the node being executed. Useful when a single
   * executor function services multiple defIds (community nodes use this
   * to look up the installed package).
   */
  defId?: string;
  secrets: Record<string, string>;
  /**
   * Tenant-scoped LLM provider settings (configured in Settings → AI Providers).
   * AI/agent nodes use this when their per-node `apiKey` config is empty.
   * Keyed by provider id: 'liara' | 'anthropic' | 'openai' | 'gemini' | ...
   */
  llmProviders?: Record<string, { apiKey: string; defaultModel?: string; baseUrl?: string }>;
  /**
   * Outputs of all previously-executed nodes in the same run, keyed by node
   * id AND by node alias. Lets executors that run user JS (db_insert_batch
   * childRowsExpression, etc.) expose `$node.<alias>.json` to the sandbox.
   * Populated by WorkflowEngine before each executor call.
   */
  nodeOutputs?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Binary I/O tenant-scoped (GAP 2). Iniettati dall'engine con un blob-store
   * content-addressed sul disco del tenant. I nodi che producono/consumano file
   * li usano INVECE di base64-in-JSON (memoria):
   *   • readBinary(ref) → byte del blob (per BinaryData encoding='ref').
   *   • writeBinary(data, meta) → BinaryData encoding='ref' (dedup automatico).
   * Opzionali: in contesti senza store (alcuni test) restano undefined → gli
   * helper readBinaryBytes/makeBinaryInline di core-schema gestiscono il fallback
   * base64 inline.
   */
  readBinary?: (ref: string) => Promise<Buffer>;
  writeBinary?: (data: Buffer, meta: { mimeType: string; fileName?: string }) => Promise<BinaryData>;
  /**
   * Policy egress per host INTERNI allowlisted (sicurezza, iniettata dal runtime —
   * stdlib non conosce undici). Dato un host + `allowSelfSigned` del nodo, ritorna:
   *   - `allowlisted`: l'host è nella allowlist interna del tenant → il chiamante
   *     PUÒ scavalcare il SSRF guard per quell'host (trust esplicito dell'operatore);
   *   - `dispatcher`: l'undici dispatcher da passare a fetch (insecure-TLS se
   *     allowlisted+allowSelfSigned, permissivo se solo allowlisted, undefined altrimenti).
   * Host pubblici / IP privati NON dichiarati → `allowlisted:false`, nessun dispatcher
   * → SSRF guard attivo + TLS verificato (invariante #201). DECISIONE PER-HOST → il
   * chiamante la rivaluta su OGNI hop di redirect (un redirect verso pubblico NON eredita).
   */
  resolveOutboundDispatcher?: (host: string, allowSelfSigned: boolean) => { allowlisted: boolean; dispatcher?: unknown };
  /**
   * Variante STREAMING di writeBinary: scrive un Readable content-addressed
   * senza materializzare i byte in memoria (hash in transito). È il path reale
   * per file grandi — webhook upload 50MB, download HTTP di binari grossi: i byte
   * vanno disco→disco, mai tutti in RAM. Usalo quando hai uno stream; usa
   * writeBinary quando hai già un Buffer in mano.
   */
  writeBinaryStream?: (stream: Readable, meta: { mimeType: string; fileName?: string }) => Promise<BinaryData>;
  /**
   * Current depth in the subworkflow call chain. 0 = invoked directly by
   * the user/trigger, N = invoked from N levels of nested `logic_subworkflow`
   * nodes. The `subworkflow` executor uses this to enforce the recursion
   * cap (N17 audit). Engine populates it from the X-Subworkflow-Depth header
   * on the inbound run request.
   */
  subworkflowDepth?: number;
  logger?: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
  };
  /**
   * #226 Cappella Sistina+ logging.
   * Strutturato per-step: ogni call genera una StepLog entry visibile in
   * Dashboard Live + RunInspector + PSR-3 channel 'runs'. Auto-trace context.
   * `logger` rimane per back-compat (mappa a info/warn/error sotto-the-hood).
   * Shape minimale (no dep ciclica su runtime app):
   */
  log?: {
    trace(msg: string, fields?: Record<string, unknown>): void;
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    fatal(msg: string, fields?: Record<string, unknown>): void;
  };
  /**
   * Deadline assoluto del run in ms epoch — quando il workflow DEVE essere
   * completato altrimenti l'engine lo killa. Settato dall'engine in base a:
   *   • Plan limit (max workflow duration per tier — FREE 30min, PRO 24h, …)
   *   • Override config workflow.maxDurationMs (admin-set)
   *
   * Letto da middleware sensibili al lifecycle del run:
   *   • withIdempotency: TTL adattivo = min(maxTTL, runDeadline - now)
   *     cosi\` il lock non decade PRIMA del termine del workflow.
   *   • withTimeout: timeout effettivo = min(opt.timeoutMs, runDeadline - now)
   *
   * Omesso → middleware usano i loro default. Back-compat 100%.
   */
  runDeadline?: number;
}

export interface NodeExecutionResult {
  output: unknown;
  durationMs: number;
  warnings?: string[];
  /**
   * For branching nodes, indicates which named output port to follow.
   * Ignored by non-branching nodes.
   */
  branch?: string;
  /**
   * GAP #2 (paired items) — vista ITEM-NATIVE dell'output, dichiarata
   * dall'executor quando l'engine NON può dedurre il lineage da solo
   * (filter, sort, dedup, merge: qualunque nodo che scarta/riordina/aggrega).
   * Ogni `pairedItem.item` è l'INDICE nella vista item dell'INPUT del nodo
   * (`normalizeToItems(input)` — la stessa vista che l'engine registra per il
   * nodo sorgente). `sourceNodeId` va OMESSO: lo arricchisce l'engine con la
   * sorgente runtime reale. Per i nodi branchable: SOLO gli item del ramo che
   * prosegue (`branch`). Assente → l'engine applica l'euristica conservativa
   * (vedi deriveOutputItems in engine/item-model.ts).
   */
  items?: ExecutionItem[];
}

export type NodeExecutor = (
  config: Record<string, unknown>,
  input: unknown,
  context: NodeExecutionContext,
) => Promise<NodeExecutionResult>;

/**
 * A NodeModule pairs the metadata (NodeDef, rendered by the editor) with
 * the runtime implementation (optional — some nodes like If/Loop/Merge
 * have execution semantics baked into the workflow engine itself).
 */
export interface NodeModule {
  def: NodeDef;
  executor?: NodeExecutor;
}
