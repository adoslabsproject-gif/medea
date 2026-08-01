/**
 * NodeExecutorStrategy — the CATCH-ALL strategy. Looks up the registered
 * executor (server-side override > NodeModule.executor) and invokes it
 * with exponential-backoff retry.
 *
 * MUST be last in the strategy chain — it matches every node that no
 * earlier strategy claimed. When a node has neither a server-side override
 * nor a NodeModule executor, the strategy returns a `skipped` placeholder
 * instead of throwing — this happens when a workflow was authored with a
 * node from a package not present in the current runtime.
 *
 * Retry policy:
 *   • `retryCount`   — 0..10 (capped). Number of *additional* attempts.
 *   • `retryDelayMs` — base delay in ms. Exponential: delay × 2^(n-1),
 *                       capped at 30s.
 *   Both knobs are read from the node's own config (consistent with all
 *   other node-local settings).
 */

import type { NodeErrorCode } from '@flowforge/nodes-stdlib';
import { coerceString } from '@/lib/coerce.js';
import { logger } from '@/lib/logger.js';
import { resolveServerExecutor } from '@/executors/registry.js';
import { makeBinaryRef, engineRetriesNode, type BinaryData } from '@flowforge/core-schema';
import { resolveOutboundDispatcher } from '@/lib/egress-policy.js';
import type { Readable } from 'node:stream';
import type { INodeDispatchStrategy, DispatchContext, DispatchResult, NodeExecutionContext } from './types.js';
import {
  type NodeModule,
  wrap,
  withErrorMapping,
  withAbortGuard,
  withTelemetry,
  retryAfterMsOf,
  NodeError,
  categoryOf,
  isTransientCategory,
} from '@flowforge/nodes-stdlib';

const MAX_RETRY_COUNT = 10;
const MAX_BACKOFF_MS = 30_000;

/**
 * Delay del prossimo retry. Production-grade:
 *   • Retry-After del provider (429/503) → rispettato (clamp a max), niente
 *     jitter (il provider ha indicato un valore preciso).
 *   • altrimenti backoff esponenziale con EQUAL JITTER (AWS): delay ∈ [exp/2, exp]
 *     → evita il thundering-herd quando molti nodi falliscono e ritentano insieme.
 * `rand` iniettabile per test deterministici.
 */
export function computeRetryDelay(
  baseDelay: number,
  attempt: number,
  maxBackoff: number,
  retryAfterMs: number | null,
  rand: () => number = Math.random,
): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) return Math.min(maxBackoff, retryAfterMs);
  const exp = Math.min(maxBackoff, baseDelay * (2 ** (attempt - 1)));
  return Math.floor(exp / 2 + rand() * (exp / 2));
}
const DEFAULT_BASE_DELAY_MS = 1000;

function coerceSecrets(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (v !== undefined && v !== null) out[k] = coerceString(v);
  }
  return out;
}

type NodeExecutor = NonNullable<NodeModule['executor']>;

export class NodeExecutorStrategy implements INodeDispatchStrategy {
  readonly name = 'node-executor';

  /** Catch-all. Must be last in the chain. */
  match(): boolean {
    return true;
  }

  async execute(ctx: DispatchContext): Promise<DispatchResult> {
    const exec = resolveServerExecutor(ctx.module.def.id) ?? ctx.module.executor;
    if (!exec) {
      // The defId exists in the catalog but no implementation is wired in
      // this runtime version. Return a structured marker so downstream
      // nodes/operators can detect it without throwing.
      return {
        output: { skipped: `Node ${ctx.module.def.id} has no executor in this runtime version` },
        chosenBranch: undefined,
        retries: 0,
      };
    }

    // Expose prior node outputs to the executor so sandboxed user JS
    // (db_insert_batch.childRowsExpression, etc.) can read `$node.<alias>.json`.
    // scope.vars already holds the same map used by interpolateConfig, keyed
    // by both nodeId and alias. We pass it through verbatim.
    const nodeOutputs = (ctx.scope?.vars ?? {});
    const execCtx: NodeExecutionContext = {
      tenantId: ctx.tenantId,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      nodeId: ctx.node.id,
      // defId lets a multi-defId executor (community-node executor) look up
      // which installed package it should dispatch to.
      defId: ctx.module.def.id,
      // Scope L (2026-06-04 enterprise): vault tenant-level decrypted secrets
      // arrivano via scope. Pre-fix era `{}` → community/custom node che leggono
      // `ctx.secrets.X` direttamente vedevano vuoto (i nodi standard usano
      // `{{secrets.X}}` interpolato in config → no impatto, ma rompe il
      // contratto pubblico API verso community nodes). NodeExecutionContext.secrets
      // type e\` Record<string, string> → cast safe perche\` tenant variables type
      // 'secret' sono sempre stringhe (vedi `variables.value_encrypted` schema).
      secrets: coerceSecrets(ctx.scope?.secrets),
      llmProviders: ctx.llmProviders.getAll(ctx.tenantId),
      nodeOutputs,
      // GAP 2: binary I/O tenant-scoped. readBinary delega allo store; writeBinary
      // scrive content-addressed e ritorna un BinaryData encoding='ref' pronto da
      // mettere nell'output del nodo (i byte NON entrano in outputsById).
      // Egress policy per host interni allowlisted (sicurezza, Build #3): action_http
      // la interroga per-hop. Default (allowlist vuota) → allowlisted:false ovunque.
      resolveOutboundDispatcher,
      readBinary: (ref: string): Promise<Buffer> => ctx.binaryStore.read(ref),
      writeBinary: async (data: Buffer, meta: { mimeType: string; fileName?: string }): Promise<BinaryData> => {
        const r = await ctx.binaryStore.writeBuffer(data);
        return makeBinaryRef({
          mimeType: meta.mimeType,
          ref: r.ref,
          size: r.size,
          sha256: r.sha256,
          ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}),
        });
      },
      // Streaming reale: i byte non passano mai tutti in RAM (writeStream del
      // BinaryStore, hash in transito). Per webhook upload 50MB / download grandi.
      writeBinaryStream: async (stream: Readable, meta: { mimeType: string; fileName?: string }): Promise<BinaryData> => {
        const r = await ctx.binaryStore.writeStream(stream);
        return makeBinaryRef({
          mimeType: meta.mimeType,
          ref: r.ref,
          size: r.size,
          sha256: r.sha256,
          ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}),
        });
      },
    };
    // N17 audit: surface subworkflow depth so the `logic_subworkflow`
    // executor can enforce the recursion cap.
    if (ctx.subworkflowDepth !== undefined) execCtx.subworkflowDepth = ctx.subworkflowDepth;
    // #226: propaga il LogCollector verso il customNodeExecutor + altri executor
    // che lo supportano. L'helper `log` su NodeExecutionContext espone l'API
    // pubblica per i nodi stdlib senza accoppiarli al runtime concreto.
    if (ctx.logCollector) {
      (execCtx as NodeExecutionContext & { __logCollector?: typeof ctx.logCollector }).__logCollector = ctx.logCollector;
      execCtx.log = {
        trace: (m, f) => ctx.logCollector!.trace(m, f),
        debug: (m, f) => ctx.logCollector!.debug(m, f),
        info: (m, f) => ctx.logCollector!.info(m, f),
        warn: (m, f) => ctx.logCollector!.warn(m, f),
        error: (m, f) => ctx.logCollector!.error(m, f),
        fatal: (m, f) => ctx.logCollector!.fatal(m, f),
      };
    }
    // TTL run-aware: se l'env FLOWFORGE_RUN_MAX_DURATION_MS e\` settato dal
    // plan settings, calcola la deadline assoluta e passala al ctx — i
    // middleware sensibili (withIdempotency, withTimeout) la usano per
    // computare TTL adattivi che non scadono PRIMA della fine del run.
    const runMaxMs = Number(process.env.FLOWFORGE_RUN_MAX_DURATION_MS);
    if (Number.isFinite(runMaxMs) && runMaxMs > 0) {
      execCtx.runDeadline = Date.now() + runMaxMs;
    }

    // AUDIT FIX WE-11 (2026-06-09 HIGH): Idempotency-Key derived per node-run.
    //
    // Pre-fix: retry replicava side-effect non-idempotent (es. payment provider
    // riceve POST, returna 5xx dopo aver committed → retry double-charge).
    // No Idempotency-Key auto-mintato → ogni retry "first time" lato provider.
    //
    // Post-fix: key deterministica = `${runId}:${nodeId}` (stessa attraverso
    // tutti i retry, diversa per altri run/nodi). Node executor che parla con
    // provider supporting idempotency (Stripe, PayPal, Slack, Linear, ecc.)
    // forwarda come header `Idempotency-Key`. Engine non lo impone — è opt-in
    // per executor che lo supporta. Documentato in NodeExecutionContext.
    const idempotencyKey = `${ctx.runId}:${ctx.node.id}`;
    (execCtx as NodeExecutionContext & { idempotencyKey?: string }).idempotencyKey = idempotencyKey;

    // Wrappa OGNI executor (qualunque sia il defId) con la baseline enterprise:
    //   • withErrorMapping → ogni throw legacy diventa NodeError tipizzato
    //   • withAbortGuard   → short-circuit con AbortedError se l'utente cancella
    //   • withTelemetry    → span OTel con attrs flowforge.{tenant,run,node,def}
    // Cosi\` TUTTI i 97+ nodi (stdlib + db + integrations + ai + community)
    // ereditano la baseline 2026-grade senza che ogni autore debba ricordarsene.
    // I middleware specifici per dominio (httpHostBreaker per i nodi HTTP)
    // restano applicati nei singoli node module.
    const wrappedExec = wrap(exec, [
      withErrorMapping(),
      withAbortGuard(),
      withTelemetry({
        spanName: `node.${ctx.module.def.id}`,
        attrs: { 'flowforge.node.label': ctx.module.def.label },
      }),
    ]);
    return runWithRetry(ctx, wrappedExec, execCtx);
  }
}

/**
 * Exponential-backoff retry helper. Lives next to NodeExecutorStrategy
 * (its only caller).
 *
 * AUDIT FIX WE-2 (2026-06-09): exported come `__forTestRunWithRetry` per
 * il test di regressione anti-retry-non-retryable. Convention underscore
 * + JSDoc internal scoraggia uso esterno; il test importa l'export typed.
 */
export const __forTestRunWithRetry = runWithRetry;

async function runWithRetry(
  ctx: DispatchContext,
  exec: NodeExecutor,
  execCtx: NodeExecutionContext,
): Promise<DispatchResult> {
  // UN SOLO livello di retry (review nodi): se il nodo è self-managed (es. action_http
  // ritenta internamente con retryOnStatus + Retry-After) l'engine NON ri-ritenta →
  // niente doppione annidato engine×nodo. L'utente può forzare via retryStrategy.
  const engineOwnsRetry = engineRetriesNode(ctx.node.config.retryStrategy, ctx.module.def.selfManagedRetry === true);
  const maxRetries = engineOwnsRetry
    ? Math.max(0, Math.min(MAX_RETRY_COUNT, Number(ctx.node.config.retryCount ?? 0)))
    : 0;
  const baseDelay = Math.max(0, Math.min(MAX_BACKOFF_MS, Number(ctx.node.config.retryDelayMs ?? DEFAULT_BASE_DELAY_MS)));

  let attempt = 0;
  let lastError: unknown = null;
  while (attempt <= maxRetries) {
    try {
      const result = await exec(ctx.interpolatedConfig, ctx.carriedInput, execCtx);
      return {
        output: result.output,
        chosenBranch: result.branch,
        retries: attempt,
        // GAP #2: il lineage dichiarato dall'executor viaggia col result —
        // dropparlo qui renderebbe .item/itemMatching irrisolvibili a valle.
        ...(result.items !== undefined ? { items: result.items } : {}),
      };
    } catch (err) {
      lastError = err;

      // AUDIT FIX WE-2 (2026-06-09 CRITICAL): rispetta retryable=false.
      //
      // Pre-fix: il loop incrementava `attempt` indipendentemente dal tipo
      // di errore. Conseguenze concrete:
      //   • ValidationError/ConfigError retried 10x → CPU waste, log noise
      //   • AuthError retried 10x → account-lockout dal provider (Stripe ban
      //     dopo 5 401 in 1 min, Gmail blocca dopo 10, etc.) → outage tenant
      //   • QuotaExceededError retried in cooldown → mai recuperabile
      //   • IdempotencyConflictError retried → race amplification
      //   • CircuitOpenError retried → breaker mai si chiude
      //   • AbortedError retried → user clicca STOP, engine continua
      //
      // Fix: se NodeError con retryable=false → throw immediato. Per errori
      // non-NodeError, fallback su categoryOf (es. HttpError 4xx → 'business'
      // non-transient → no retry). Solo errori transient (network/rate_limit)
      // o con retryable=true esplicito procedono al backoff loop.
      if (err instanceof NodeError) {
        if (err.retryable === false) {
          throw err; // non-retryable: surrender immediato
        }
      } else if (err instanceof Error) {
        // Errori NON-NodeError (es. SyntaxError, TypeError, executor bug)
        // sono SEMPRE non-retryable: retry di un bug deterministico non aiuta.
        // Eccezione: errori con shape `{ code, retryable }` riconoscibili da
        // categoryOf (es. errori serializzati cross-boundary).
        const looksLikeNodeErrorShape =
          typeof (err as { code?: unknown }).code === 'string' &&
          typeof (err as { retryable?: unknown }).retryable === 'boolean';
        if (!looksLikeNodeErrorShape) {
          throw err;
        }
        // Reuse categoryOf per decidere
        const shape = err as unknown as { code: NodeErrorCode; retryable?: boolean };
        const cat = categoryOf(shape);
        if (!isTransientCategory(cat) && shape.retryable !== true) {
          throw err;
        }
      }

      attempt += 1;
      if (attempt > maxRetries) break;
      const delay = computeRetryDelay(baseDelay, attempt, MAX_BACKOFF_MS, retryAfterMsOf(err));
      logger.warn(
        { nodeId: ctx.node.id, defId: ctx.node.defId, attempt, delay, retryAfter: retryAfterMsOf(err), err },
        'Node failed, retrying',
      );
      await new Promise<void>((r) => { setTimeout(r, delay); });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
