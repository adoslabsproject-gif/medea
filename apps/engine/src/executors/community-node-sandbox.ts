/**
 * True V8-isolate sandbox for third-party community-node executors.
 *
 * Uses `isolated-vm` to create a SEPARATE V8 instance per run. Vendor code
 * runs in a process-different memory space — there is no `globalThis`
 * shared with the host. The host injects ONLY the references it wants the
 * vendor to see, via explicit copy or callback bridges.
 *
 * Isolation guarantees (real, not "best effort"):
 *   • Memory cap: 128 MB per isolate. Hit it → V8 OOMs the isolate. The
 *     host stays alive.
 *   • CPU timeout: 15s wall clock on every script.run({ timeout }) call.
 *   • Event-loop isolation: l'esecuzione gira in worker_thread Node dedicato
 *     (Cappella Sistina). Un custom node CPU-bound NON blocca il runtime
 *     principale — solo il worker. Override `MEDEA_SANDBOX_DISABLE_WORKER`
 *     o NODE_ENV=test / VITEST=true → fallback inline (per test deterministici).
 *   • Safety hard-kill: 20s post-spawn worker terminate() se isolated-vm
 *     non riesce a fermarsi entro il suo timeout interno.
 *   • Globals: no `process`, no `globalThis` access to host, no `Buffer`
 *     class (only a 2-method shim), no `require`, no `import`, no `fs`,
 *     no `child_process`. NO WebAssembly (`runtime` doesn't expose it),
 *     NO eval / Function constructor (codeGeneration NOT exposed).
 *   • Promise + setTimeout: provided via host bridges so the vendor can
 *     await fetch responses, but the host clears all timers on dispose.
 *
 * The vendor's executor signature is unchanged:
 *   module.exports = async function (config, input, context) { ... }
 *
 * Available APIs inside the sandbox:
 *   • fetch(url, init?)         — proxied to host; returns { status, headers, text(), json() }
 *   • console.{log,warn,error}  — captured to host logger
 *   • setTimeout / clearTimeout — host-managed, auto-cleared on dispose
 *   • JSON, Math, Date, URL, Promise, Object, Array, String, Number, Boolean
 *   • Buffer.from(str, enc).toString(enc)  — base64 / utf8 only
 *
 * Timeout a DUE livelli (entrambi REALI nel codice, non aspirazionali):
 *   1. CPU: `script.run({ timeout: EXEC_TIMEOUT_MS })` — copre il backtracking/loop
 *      sincrono dentro l'isolate.
 *   2. Wall-clock: `Promise.race` host-side (timeout CPU + SANDBOX_ASYNC_GRACE_MS) che dispone
 *      l'isolate — copre gli await che lasciano l'isolate IDLE (es. fetch che non
 *      risolve, `await new Promise(()=>{})`), su cui il timeout CPU NON scatterebbe.
 *      Presente sia nel worker (safetyKill) sia nel path inline (questa Promise.race).
 */

import type { LogCollector } from '@/services/runs/log-collector.js';
import ivm from 'isolated-vm';
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { guardedRandomBytes } from './sandbox-crypto-guard.js';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readBytesCapped } from '@/lib/capped-response.js';
import { STDLIB_BUNDLE, STDLIB_BUNDLE_BYTES, STDLIB_BUNDLE_GLOBAL_NAME } from '@medea/engine-nodes-stdlib-sandbox/bundle-source';

/**
 * Path al worker entry-point. Risolto al boot del modulo.
 *
 * Pattern: il worker file e\` distribuito accanto al main bundle
 * (./community-node-sandbox.worker.js dopo build esbuild/tsc).
 *
 * Override env `MEDEA_SANDBOX_DISABLE_WORKER=true` forza l'esecuzione
 * inline sul main thread (utile per test sync + smoke locale).
 */
const __filename_self = fileURLToPath(import.meta.url);
const __dirname_self = dirname(__filename_self);
// In dev (src/executors/*.ts) il worker e\` accanto.
// In prod bundled (dist/main.js + dist/executors/*.worker.js) il worker e\` in
// subdir executors/. Risolvi entrambi i casi: prima accanto, poi sotto executors/.
import { existsSync } from 'node:fs';
const WORKER_SCRIPT_PATH = (() => {
  const sibling = join(__dirname_self, 'community-node-sandbox.worker.js');
  if (existsSync(sibling)) return sibling;
  const subdir = join(__dirname_self, 'executors', 'community-node-sandbox.worker.js');
  return subdir;
})();

/** Runtime check (NOT top-level const) — permette test override post-boot. */
function workerDisabled(): boolean {
  return process.env.MEDEA_SANDBOX_DISABLE_WORKER === 'true'
    || process.env.NODE_ENV === 'test'
    || process.env.VITEST === 'true';
}

export interface SandboxInput {
  config: Record<string, unknown>;
  input: unknown;
  context: {
    tenantId: string;
    runId: string;
    workflowId: string;
    nodeId: string;
    action?: string;
  };
  /**
   * #226 Cappella Sistina+ logging.
   * LogCollector opzionale — se passato, il sandbox forwarda console.log
   * (parsed con livello) come source='user' e network events come
   * source='network' con fields strutturati (url, status, ms, bytes).
   */
  collector?: LogCollector;
}

const MEMORY_LIMIT_MB = 128;
// Wall-clock timeout enforced internamente da isolated-vm (CPU + I/O bridge).
// Ridotto da 30s a 15s per limitare blast-radius su nodi CPU-bound malevoli
// (es. `while(true)` o crypto-mining). I nodi che fanno HTTP fetch lunghi
// devono usare il bridge fetch che ha il SUO timeout di 25s separato.
const EXEC_TIMEOUT_MS = 15_000;
/** Grazia wall-clock OLTRE il timeout CPU, prima del kill host (copre l'hang async). */
const SANDBOX_ASYNC_GRACE_MS = 3_000;
/** Timeout CPU effettivo (override via env, usato anche nei test per non aspettare 15s). */
function execTimeoutMs(): number {
  const raw = Number(process.env.MEDEA_SANDBOX_EXEC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : EXEC_TIMEOUT_MS;
}

// ─── Trace caps (anti-DoS: vendor che chiama console.log/fetch in loop) ──
/** Massimo numero di log catturati. Oltre, vengono droppati silently. */
const TRACE_MAX_LOG_ENTRIES = 500;
/** Massima lunghezza singola riga di log (truncate). */
const TRACE_MAX_LOG_CHARS = 4_000;
/** Massimo numero di network event catturati. */
const TRACE_MAX_NETWORK_EVENTS = 200;
/** Cap del body letto dal proxy fetch del sandbox (20MB). Il body viene marshallato
 *  come text+base64 verso l'isolate (×3 memoria) → oltre questo limite è troppo. */
const SANDBOX_FETCH_MAX_BYTES = 20 * 1024 * 1024;
/** Cap timer host concorrenti (path inline = gemello del worker). Vedi worker MAX_HOST_TIMERS. */
const MAX_HOST_TIMERS = 1_000;

/**
 * The vendor source is appended verbatim. The bootstrap below provides
 * `module.exports` (a host-mirror via the global shim), then resolves
 * the executor function and awaits it with the provided arguments.
 *
 * Why we ALWAYS expect CJS shape: regex-rewriting ESM `export default`
 * is fragile and silently misfires on edge cases (comments, multiline).
 * Vendor publishes CJS; their build tool emits `module.exports = ...`.
 */
function buildBootstrap(source: string): string {
  return `
const module = { exports: undefined };
const exports = {};
${source}
;
const candidate = (typeof module !== 'undefined' && module.exports)
  ? (typeof module.exports === 'function' ? module.exports
      : (module.exports && module.exports.default))
  : (exports && exports.default);
if (typeof candidate !== 'function') {
  throw new Error(
    'executor.js non esporta una funzione async. Usa "module.exports = async function (config, input, context) { ... }"'
  );
}
// Run and stringify the result so it crosses the isolate boundary cleanly.
// Cappella Sistina+ error propagation: estrai TUTTO il context error
// (name, meta, cause.probes, stack head) — niente viene perso al boundary.
// L'host parsa errorCause per loggare le ragioni reali per ogni candidate
// (es. rotator restituisce array di {ok, host, reason} dentro cause.probes).
function __ffSerializeError(err) {
  if (!err || typeof err !== 'object') return { error: String(err) };
  var out = { error: err.message ? String(err.message) : String(err) };
  if (err.name) out.errorName = String(err.name);
  if (err.code) out.errorCode = String(err.code);
  // err.meta (NodeError style: meta può portare { url, cause } come custom)
  if (err.meta) { try { out.errorMeta = JSON.parse(JSON.stringify(err.meta)); } catch (e) {} }
  if (err.context) { try { out.errorContext = JSON.parse(JSON.stringify(err.context)); } catch (e) {} }
  // CAPPELLA SISTINA+: la cause può essere in 3 posti diversi a seconda del
  // pattern (Error{cause} standard, NodeError{meta.cause}, custom{.cause}).
  // Cerco ESPLICITAMENTE tutti — voglio i probes ovunque siano.
  var causeCandidate = err.cause || (err.meta && err.meta.cause) || null;
  if (causeCandidate) {
    var c = causeCandidate;
    out.errorCause = {
      message: c && c.message ? String(c.message) : String(c),
      name: c && c.name ? String(c.name) : undefined
    };
    if (c && c.probes) { try { out.errorCause.probes = JSON.parse(JSON.stringify(c.probes)); } catch (e) {} }
    if (c && c.outcomes) { try { out.errorCause.outcomes = JSON.parse(JSON.stringify(c.outcomes)); } catch (e) {} }
    if (c && c.attempts) { try { out.errorCause.attempts = JSON.parse(JSON.stringify(c.attempts)); } catch (e) {} }
    if (c && c.stack) out.errorCause.stackHead = String(c.stack).slice(0, 400);
  }
  // Inoltre — il bundle del rotator passa probes anche dentro err.probes
  // direttamente. Estrai da TUTTE le shape conosciute.
  if (!out.errorCause || !out.errorCause.probes) {
    if (err.probes) {
      try {
        out.errorCause = out.errorCause || {};
        out.errorCause.probes = JSON.parse(JSON.stringify(err.probes));
      } catch (e) {}
    }
  }
  // stack head (utile per ReferenceError/TypeError debugging)
  if (err.stack) out.errorStackHead = String(err.stack).slice(0, 600);
  return out;
}
candidate(__config, __input, __context)
  .then((value) => JSON.stringify({ ok: true, value: value === undefined ? null : value }))
  .catch((err) => JSON.stringify(Object.assign({ ok: false }, __ffSerializeError(err))));
`;
}

interface FetchProxyResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bodyText: string;
  bodyBase64: string;
  bodyLength: number;
}

/**
 * Build the host-side fetch proxy that the isolate can call via a
 * Reference. We accept (url, init?) and return a JSON-serializable
 * object (no streams — Isolate can't transfer streams).
 */
/**
 * Sandbox fetch proxy — wrapper su `safeOutboundFetch` per crossing the
 * isolated-vm boundary (Response object NON serializzabile → FetchProxyResponse
 * struct flat). Delega TUTTA la safety (SSRF + per-host breaker + OTel span +
 * timeout + error mapping) a `safeOutboundFetch` — single source of truth
 * outbound HTTP cross-runtime (post-audit 2026-06-04).
 *
 * Differenze vs `safeOutboundFetch` direct:
 *   • Forza `redirect: 'manual'` — community code non puo\` bypassare SSRF via
 *     302 chain (vendor compromesso → redirect 302 a 127.0.0.1:6379 → leak).
 *   • Legge body come ArrayBuffer una volta + esporta sia `bodyText` sia
 *     `bodyBase64` — l'isolate puo\` chiamare res.text() o res.bytes() senza
 *     re-fetch (FD economy + idempotency dentro l'isolate).
 *   • 5xx/429 → throw per attivare breaker count (4xx caller-error NON count).
 */
export async function hostFetch(url: string, initJson?: string): Promise<FetchProxyResponse> {
  const init = initJson ? JSON.parse(initJson) as RequestInit : undefined;
  // #223 fix: rimuove init.signal (è il MIO AbortSignal shim, non nativo
  // node — fetch rigetta con TypeError "signal must be an AbortSignal").
  // Stesso per timeoutMs (campo proprietario, no-op in fetch standard).
  if (init) {
    if ('signal' in init) delete (init as Record<string, unknown>).signal;
    if ('timeoutMs' in init) delete (init as Record<string, unknown>).timeoutMs;
  }
  // SSRF-safe redirect handling. Bloccare TUTTI i redirect (vecchio comportamento)
  // rompeva nodi legittimi: tantissimi siti rispondono 301/302 (http→https,
  // path canonico, www↔apex) — es. streamingcommunityz → 301. Ora SEGUIAMO i
  // redirect MANUALMENTE ri-validando ogni `Location` contro l'SSRF guard
  // (max 5 hop): un 302 verso 127.0.0.1:6379 resta bloccato (validateUrlForFetch),
  // un 301 normale passa. Stesso pattern di web-tools.fetchUrl.
  const MAX_REDIRECTS = 5;
  let currentUrl = url;
  let reqInit: RequestInit = { ...(init ?? {}) };
  let res: Awaited<ReturnType<typeof safeOutboundFetch>>;
  let hops = 0;
  for (;;) {
    try {
      res = await safeOutboundFetch(currentUrl, {
        ...reqInit,
        redirect: 'manual',
        spanName: 'node.community.fetch',
      });
    } catch (e) {
      logger.warn({ url: currentUrl, err: (e as Error).message }, '[community-fetch] safeOutboundFetch threw');
      throw e;
    }
    if (res.status < 300 || res.status >= 400) break; // risposta finale (non redirect)
    const loc = res.headers.get('location');
    if (!loc) break; // 3xx senza Location → trattala come finale
    if (++hops > MAX_REDIRECTS) throw new Error(`SSRF guard: troppi redirect (>${MAX_REDIRECTS})`);
    const next = new URL(loc, currentUrl).toString();
    const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
    const ssrf = validateUrlForFetch(next);
    if (!ssrf.ok) {
      throw new Error(`SSRF blocked: redirect verso host non permesso (${ssrf.reason ?? 'invalid'})`);
    }
    // Semantica HTTP: dopo un redirect un POST/PUT diventa GET senza body.
    if (reqInit.method && reqInit.method !== 'GET' && reqInit.method !== 'HEAD') {
      reqInit = { ...reqInit, method: 'GET' };
      delete (reqInit as Record<string, unknown>).body;
    }
    currentUrl = next;
  }
  logger.debug({ url: currentUrl, status: res.status, ok: res.ok, hops }, '[community-fetch] response');
  // Read once CAPPATO (anti-OOM): prima `res.arrayBuffer()` leggeva l'INTERO body e
  // poi lo marshallava come text+base64 (memoria ×3) verso l'isolate → un endpoint
  // ostile poteva far esplodere la RAM dell'host per OGNI community/openapi node.
  // 20MB è generoso per una risposta API; oltre → errore esplicito al nodo.
  const buf = await readBytesCapped(res, SANDBOX_FETCH_MAX_BYTES);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const response: FetchProxyResponse = {
    status: res.status,
    ok: res.ok,
    headers,
    bodyText: buf.toString('utf8'),
    bodyBase64: buf.toString('base64'),
    bodyLength: buf.length,
  };
  // 5xx + 429 attivano il breaker (safeOutboundFetch ha gia\` HostBreaker —
  // ma il throw qui forza il count fail anche su 5xx body parsato OK).
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`HTTP ${String(res.status)} from ${new URL(url).host} (breaker-tracked)`);
  }
  return response;
}

export interface SandboxNetworkEvent {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  bytesIn: number;
  ok: boolean;
  startedAt: number;
}

export interface SandboxTrace {
  logs: string[];
  network: SandboxNetworkEvent[];
  durationMs: number;
}

/**
 * #226 helper: parse "[level] msg" entries dal sandbox e forwarda
 * strutturato al LogCollector. Network events vengono ingested come
 * source='network' con fields { url, method, status, ms, bytesIn, ok }.
 */
function forwardSandboxLogsToCollector(
  t: { logs: string[]; network: SandboxNetworkEvent[]; durationMs: number },
  collector: LogCollector,
): void {
  // Logs sandbox capturati come "[log] msg" / "[warn] msg" / "[error] msg".
  const levelRe = /^\[(log|warn|error|info|debug|trace)\]\s?(.*)$/su;
  for (const line of t.logs) {
    const m = levelRe.exec(line);
    let level: 'trace' | 'debug' | 'info' | 'warn' | 'error' = 'info';
    let msg = line;
    if (m) {
      const tag = m[1] ?? 'info';
      msg = m[2] ?? '';
      level = tag === 'log' ? 'info'
        : tag === 'trace' ? 'trace'
        : tag === 'debug' ? 'debug'
        : tag === 'info' ? 'info'
        : tag === 'warn' ? 'warn'
        : 'error';
    }
    collector.log(level, msg, undefined, 'user');
  }
  // Network events strutturati — utile per debugging "perché 6 candidate fail".
  for (const ev of t.network) {
    collector.log(
      ev.ok ? 'debug' : 'warn',
      `${ev.method} ${ev.url} → ${String(ev.status)}`,
      {
        url: ev.url,
        method: ev.method,
        status: ev.status,
        durationMs: ev.durationMs,
        bytesIn: ev.bytesIn,
        ok: ev.ok,
      },
      'network',
    );
  }
}

/**
 * Info pubblica del STDLIB_BUNDLE iniettato — utile per dashboard runtime
 * + verifica diagnostica che il bundle e\` montato correttamente.
 */
export const SANDBOX_STDLIB_INFO = {
  bytes: STDLIB_BUNDLE_BYTES,
  globalName: STDLIB_BUNDLE_GLOBAL_NAME,
  helpers: ['csv', 'crypto', 'transform', 'text', 'url', 'jsonpath', 'time'] as const,
} as const;

/**
 * Public entry — esegue il custom node in worker_threads (Cappella Sistina).
 *
 * Spawn di un Worker dedicato per ogni run → l'event-loop principale del
 * runtime container NON viene mai bloccato, anche se il custom node fa
 * `while(true)` o CPU-bound malevolo. isolated-vm CPU timeout 15s kill il
 * worker; il main thread resta responsive su tutte le altre route.
 *
 * Trade-off: ~30-50ms spawn overhead per run vs. zero blast-radius. Per
 * marketplace nodes (eseguiti decine di volte al minuto cross-tenant) il
 * trade-off e\` largamente net-positive.
 *
 * Override `MEDEA_SANDBOX_DISABLE_WORKER=true` → fallback inline (per
 * test deterministici + smoke locale dove worker_threads non disponibili).
 */
export async function runInSandbox(
  source: string,
  input: SandboxInput,
  trace?: SandboxTrace,
): Promise<unknown> {
  if (workerDisabled()) {
    return runInSandboxInline(source, input, trace);
  }

  return new Promise<unknown>((resolve, reject) => {
    const bootstrapSource = buildBootstrap(source);
    const worker = new Worker(WORKER_SCRIPT_PATH, {
      workerData: {
        bootstrapSource,
        config: input.config,
        input: input.input,
        contextMeta: {
          tenantId: input.context.tenantId,
          runId: input.context.runId,
          workflowId: input.context.workflowId,
          nodeId: input.context.nodeId,
          action: input.context.action ?? '',
        },
        captureTrace: trace !== undefined,
      },
      // Anti-DoS: ulteriore memory cap a livello worker (Node heap), oltre
      // a quello di isolated-vm V8.
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 64,
        codeRangeSizeMb: 32,
      },
    });

    // Hard timeout di safety: 20s (5s oltre il CPU timeout 15s di isolated-vm).
    // Se isolated-vm non riesce a killare il worker entro il suo timeout
    // (es. native code stuck), terminiamo noi.
    const safetyKill = setTimeout(() => {
      logger.warn({ nodeId: input.context.nodeId }, 'Sandbox worker safety-timeout, terminating');
      void worker.terminate();
      reject(new Error('Sandbox execution exceeded safety timeout (20s)'));
    }, 20_000);

    worker.once('message', (msg: {
      ok: boolean;
      value?: unknown;
      error?: string;
      errorName?: string;
      errorCode?: string;
      errorMeta?: Record<string, unknown>;
      errorContext?: Record<string, unknown>;
      errorCause?: { message?: string; name?: string; probes?: unknown[]; outcomes?: unknown[] };
      errorStackHead?: string;
      trace?: { logs: string[]; network: SandboxNetworkEvent[]; durationMs: number };
    }) => {
      clearTimeout(safetyKill);
      if (msg.trace && trace) {
        trace.logs = msg.trace.logs;
        trace.network = msg.trace.network;
        trace.durationMs = msg.trace.durationMs;
      }
      // #226 forward logs + network events al collector (source='user' /
      // source='network'). Logs sandbox arrivano formato "[level] msg" —
      // parse il livello e forwarda strutturato.
      if (msg.trace && input.collector) {
        forwardSandboxLogsToCollector(msg.trace, input.collector);
      }
      // Cappella Sistina+: in caso di error, forwarda al collector i probes
      // (rotator) o le outcomes (per altri nodi che hanno err.cause con array
      // di tentativi). Questo trasforma "NO_LIVE_HOST: tried 6" in 6 entry
      // dettagliate per ogni candidate fallito.
      if (!msg.ok && input.collector && msg.errorCause) {
        const probes = Array.isArray(msg.errorCause.probes) ? msg.errorCause.probes
                     : Array.isArray(msg.errorCause.outcomes) ? msg.errorCause.outcomes
                     : null;
        if (probes && probes.length > 0) {
          input.collector.error(`[sandbox-error] cause.probes (${String(probes.length)} candidates):`, {
            probes,
            ...(msg.errorName ? { errorName: msg.errorName } : {}),
            ...(msg.errorCode ? { errorCode: msg.errorCode } : {}),
            ...(msg.errorMeta ? { errorMeta: msg.errorMeta } : {}),
            ...(msg.errorCause.message ? { causeMessage: msg.errorCause.message } : {}),
          });
        } else if (msg.errorStackHead) {
          input.collector.error(`[sandbox-error] ${msg.error ?? 'unknown'}`, { stackHead: msg.errorStackHead });
        }
      }
      void worker.terminate();
      if (msg.ok) {
        resolve(msg.value);
      } else {
        reject(new Error(msg.error ?? 'Sandbox worker returned ok:false without error message'));
      }
    });

    worker.once('error', (err) => {
      clearTimeout(safetyKill);
      void worker.terminate();
      reject(err);
    });

    worker.once('exit', (code) => {
      clearTimeout(safetyKill);
      if (code !== 0 && code !== null) {
        reject(new Error(`Sandbox worker exited with code ${String(code)}`));
      }
    });
  });
}

/**
 * Implementazione inline (legacy / fallback) — esegue il sandbox sul main
 * thread. Mantenuta per:
 *  - test deterministici (no spawn worker overhead in CI)
 *  - smoke debug locale
 *  - fallback se Worker_threads non disponibili nel runtime target
 *
 * Stessa semantica di runInSandbox: ritorna il valore del vendor o throw.
 */
async function runInSandboxInline(
  source: string,
  input: SandboxInput,
  trace?: SandboxTrace,
): Promise<unknown> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  const logCapture: string[] = [];
  const startMs = Date.now();
  // #223 host-bridged timer registry — out-of-try per accesso nel finally
  const inlineHostTimers = new Map<number, NodeJS.Timeout>();
  let inlineNextTimerId = 1;

  try {
    const ctx = await isolate.createContext();
    const jail = ctx.global;
    // Expose the isolate's own global as `global` so the vendor can stash
    // top-level `const`/`var` declarations safely.
    await jail.set('global', jail.derefInto());

    // ───── Inject vendor inputs (deep-copied across the boundary) ─────
    await jail.set('__config', new ivm.ExternalCopy(input.config).copyInto());
    await jail.set('__input', new ivm.ExternalCopy(input.input).copyInto());
    await jail.set('__context', new ivm.ExternalCopy({
      tenantId: input.context.tenantId,
      runId: input.context.runId,
      workflowId: input.context.workflowId,
      nodeId: input.context.nodeId,
      action: input.context.action,
    }).copyInto());

    // ───── Console capture (capped) ─────
    let logsDropped = 0;
    await jail.set('__log', new ivm.Callback((level: string, msg: string) => {
      if (logCapture.length >= TRACE_MAX_LOG_ENTRIES) {
        logsDropped++;
        return;
      }
      const truncated = msg.length > TRACE_MAX_LOG_CHARS
        ? `${msg.slice(0, TRACE_MAX_LOG_CHARS)}… [${String(msg.length - TRACE_MAX_LOG_CHARS)} chars truncated]`
        : msg;
      logCapture.push(`[${level}] ${truncated}`);
    }));
    // ROOT CAUSE #3 (2026-06-09): `const` ha block-scope nello script eval —
    // NON è visibile al successivo `script.run(ctx)` del vendor bundle.
    // Assegnare a globalThis perché diventi proprietà del global object
    // accessibile dagli altri script che girano nello stesso isolate.
    await ctx.eval(`
      globalThis.console = {
        log:   (...a) => __log('log',   a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
        warn:  (...a) => __log('warn',  a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
        error: (...a) => __log('error', a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
      };
    `);

    // ───── Fetch proxy ─────
    // We can't pass async host functions to the isolate directly — but we can
    // pass an `ivm.Reference` to an async callback. The vendor calls
    // `__fetch(url, JSON.stringify(init))` and gets back a JSON string that
    // we parse into a Response-like object.
    // Trace network capped: oltre TRACE_MAX_NETWORK_EVENTS i nuovi eventi
    // vengono droppati (il fetch reale continua, solo il record viene perso).
    let netEventsDropped = 0;
    const pushNetworkEvent = (ev: SandboxNetworkEvent): void => {
      if (!trace) return;
      if (trace.network.length >= TRACE_MAX_NETWORK_EVENTS) {
        netEventsDropped++;
        return;
      }
      trace.network.push(ev);
    };
    await jail.set('__fetch', new ivm.Reference(async (url: string, initJson?: string) => {
      const t0 = Date.now();
      const init = initJson ? (JSON.parse(initJson) as { method?: string }) : undefined;
      let res: FetchProxyResponse;
      try {
        res = await hostFetch(url, initJson);
      } catch (err) {
        pushNetworkEvent({
          url,
          method: init?.method ?? 'GET',
          status: 0,
          durationMs: Date.now() - t0,
          bytesIn: 0,
          ok: false,
          startedAt: t0,
        });
        throw err;
      }
      pushNetworkEvent({
        url,
        method: init?.method ?? 'GET',
        status: res.status,
        durationMs: Date.now() - t0,
        bytesIn: res.bodyLength,
        ok: res.ok,
        startedAt: t0,
      });
      return new ivm.ExternalCopy(res).copyInto();
    }));
    await ctx.eval(`
      globalThis.fetch = async (url, init) => {
        const res = await __fetch.apply(undefined, [String(url), init ? JSON.stringify(init) : undefined], { arguments: { copy: true }, result: { promise: true, copy: true } });
        return {
          status: res.status,
          ok: res.ok,
          headers: {
            get: (k) => res.headers[String(k).toLowerCase()] || null,
            entries: () => Object.entries(res.headers),
          },
          text: async () => res.bodyText,
          json: async () => JSON.parse(res.bodyText),
          // Binary access for vendors that download files. Returns
          // { base64, length } — the isolate can't transfer ArrayBuffers
          // across the V8 boundary so we hand back base64 + length.
          // Vendors use Buffer.from(base64, 'base64').toString(...) to decode.
          bytes: async () => ({ base64: res.bodyBase64, length: res.bodyLength }),
          // ArrayBuffer shim: alcuni nodi (es. domain_rotator probe) chiamano
          // res.arrayBuffer() per consumare body senza decodifica. Ritorna
          // ArrayBuffer reale decodificando bodyBase64 via atob isolate-side.
          arrayBuffer: async () => {
            const bin = atob(res.bodyBase64);
            const len = bin.length;
            const ab = new ArrayBuffer(len);
            const view = new Uint8Array(ab);
            for (let i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
            return ab;
          },
        };
      };
    `);

    // ───── ROOT CAUSE #5 fix: URL bridge host-side (vedi worker.ts) ─────
    // isolated-vm V8 context vuoto → URL non esiste → rotator normaliseHost
    // catcha + ritorna "invalid URL" → tutti i probes falliscono pre-fetch.
    await jail.set('__urlParse', new ivm.Reference((raw: string, base?: string) => {
      try {
        const u = base ? new URL(raw, base) : new URL(raw);
        return new ivm.ExternalCopy({
          ok: true, protocol: u.protocol, host: u.host, hostname: u.hostname,
          port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
          origin: u.origin, href: u.href, username: u.username, password: u.password,
        }).copyInto();
      } catch (err) {
        return new ivm.ExternalCopy({ ok: false, error: err instanceof Error ? err.message : String(err) }).copyInto();
      }
    }));

    // ───── Buffer shim (2-method only — full Buffer would expose
    // ArrayBuffer with backing-store views the vendor could abuse). ─────
    await jail.set('__bufferFrom', new ivm.Reference((data: string, encoding: string) => {
      const buf = Buffer.from(data, encoding as BufferEncoding);
      return new ivm.ExternalCopy({ bytes: buf.toString('base64'), length: buf.length }).copyInto();
    }));
    await jail.set('__bufferToString', new ivm.Reference((base64: string, encoding: string) => {
      return Buffer.from(base64, 'base64').toString(encoding as BufferEncoding);
    }));
    // ROOT CAUSE #8: Buffer.byteLength (catalog_page calcola Content-Length).
    await jail.set('__bufferByteLength', new ivm.Reference((data: string, encoding: string) => {
      return Buffer.byteLength(data, encoding as BufferEncoding);
    }));

    // ROOT CAUSE #10: node:crypto bridge (createHmac/createHash/randomBytes/
    // randomUUID/timingSafeEqual). Sistemico per ogni custom node che firma
    // HMAC/hash payload (rotator, stream_proxy, OAuth state, JWT, ecc).
    await jail.set('__cryptoHmac', new ivm.Reference((algo: string, secret: string, data: string, outEncoding: string) => {
      return createHmac(algo, secret).update(data, 'utf8').digest(outEncoding as 'hex' | 'base64' | 'binary');
    }));
    await jail.set('__cryptoHash', new ivm.Reference((algo: string, data: string, outEncoding: string) => {
      return createHash(algo).update(data, 'utf8').digest(outEncoding as 'hex' | 'base64' | 'binary');
    }));
    await jail.set('__cryptoRandomBytes', new ivm.Reference((size: number, outEncoding: string) => {
      // Guardia anti-OOM host: `size` è controllato dal vendor e l'allocazione
      // avviene sull'host, fuori dal memoryLimit dell'isolate (vedi sandbox-crypto-guard).
      const buf = guardedRandomBytes(size);
      return outEncoding === 'buffer' ? buf.toString('base64') : buf.toString(outEncoding as 'hex' | 'base64' | 'binary');
    }));
    await jail.set('__cryptoRandomUUID', new ivm.Reference(() => randomUUID()));
    await jail.set('__cryptoTimingSafeEqual', new ivm.Reference((a: string, b: string, encoding: string) => {
      const ba = Buffer.from(a, encoding as BufferEncoding);
      const bb = Buffer.from(b, encoding as BufferEncoding);
      if (ba.length !== bb.length) return false;
      return timingSafeEqual(ba, bb);
    }));
    await ctx.eval(`
      // ROOT CAUSE #11: Buffer.from(ArrayBuffer/Uint8Array/Array) — stream_proxy
      // fa Buffer.from(await res.arrayBuffer()). Pre-fix: String(ab)=
      // "[object ArrayBuffer]" → URL firmati con quello → playback rotto.
      function __ffBufferFromHex(hex, encoding) {
        var internal = __bufferFrom.applySync(undefined, [String(hex), 'hex'], { arguments: { copy: true }, result: { copy: true } });
        return {
          toString(enc) {
            enc = enc || encoding || 'utf8';
            return __bufferToString.applySync(undefined, [internal.bytes, String(enc)], { arguments: { copy: true }, result: { copy: true } });
          },
          get length() { return internal.length; },
        };
      }
      function __ffBufferFromString(str, encoding) {
        var internal = __bufferFrom.applySync(undefined, [String(str), String(encoding)], { arguments: { copy: true }, result: { copy: true } });
        return {
          toString(enc) {
            enc = enc || 'utf8';
            return __bufferToString.applySync(undefined, [internal.bytes, String(enc)], { arguments: { copy: true }, result: { copy: true } });
          },
          get length() { return internal.length; },
        };
      }
      globalThis.Buffer = {
        from(data, encoding) {
          encoding = encoding || 'utf8';
          if (typeof data === 'string') return __ffBufferFromString(data, encoding);
          if (data && (data instanceof ArrayBuffer || (typeof data.byteLength === 'number' && (data.buffer instanceof ArrayBuffer || data instanceof Uint8Array)))) {
            var u8;
            if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
            else if (data instanceof Uint8Array) u8 = data;
            else u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
            var hex = '';
            for (var i = 0; i < u8.length; i++) {
              var b = u8[i].toString(16);
              hex += b.length === 1 ? '0' + b : b;
            }
            return __ffBufferFromHex(hex, 'utf8');
          }
          if (Array.isArray(data)) {
            var hex2 = '';
            for (var j = 0; j < data.length; j++) {
              var n = (Number(data[j]) | 0) & 0xff;
              var b2 = n.toString(16);
              hex2 += b2.length === 1 ? '0' + b2 : b2;
            }
            return __ffBufferFromHex(hex2, 'utf8');
          }
          return __ffBufferFromString(String(data), encoding);
        },
        byteLength(data, encoding) {
          encoding = encoding || 'utf8';
          if (typeof data === 'string') {
            return __bufferByteLength.applySync(undefined, [data, String(encoding)], { arguments: { copy: true }, result: { copy: true } });
          }
          if (data && typeof data.byteLength === 'number') return data.byteLength;
          if (Array.isArray(data)) return data.length;
          return __bufferByteLength.applySync(undefined, [String(data), String(encoding)], { arguments: { copy: true }, result: { copy: true } });
        },
        isBuffer(v) { return v !== null && typeof v === 'object' && typeof v.toString === 'function' && typeof v.length === 'number'; },
      };
    `);

    // ───── #223 + ROOT CAUSE #2 fix: Timer shim via cb registry ─────
    // `arguments: { reference: true }` wrappa i primitive Number come
    // ivm.Reference non dereferenziati → host vede `undefined` → setTimeout
    // scatta a 0ms. Fix: cb registry isolate-side + ID numerico passato
    // come copy al host.
    await jail.set('__hostSetTimeout', new ivm.Reference((delayMs: number, cbId: number) => {
      if (inlineHostTimers.size >= MAX_HOST_TIMERS) {
        throw new Error(`Limite timer sandbox superato (${String(MAX_HOST_TIMERS)}): troppi setTimeout/setInterval attivi.`);
      }
      const id = inlineNextTimerId++;
      const handle = setTimeout(() => {
        inlineHostTimers.delete(id);
        try {
          ctx.evalSync(`globalThis.__cbRegistry && globalThis.__cbRegistry[${String(cbId)}] && globalThis.__cbRegistry[${String(cbId)}](); delete globalThis.__cbRegistry[${String(cbId)}];`, { timeout: 1_000 });
        } catch { /* swallow */ }
      }, Math.max(0, Math.floor(delayMs)));
      inlineHostTimers.set(id, handle);
      return id;
    }));
    await jail.set('__hostClearTimeout', new ivm.Reference((id: number) => {
      const h = inlineHostTimers.get(id);
      if (h) { clearTimeout(h); inlineHostTimers.delete(id); }
    }));
    await jail.set('__hostSetInterval', new ivm.Reference((delayMs: number, cbId: number) => {
      if (inlineHostTimers.size >= MAX_HOST_TIMERS) {
        throw new Error(`Limite timer sandbox superato (${String(MAX_HOST_TIMERS)}): troppi setTimeout/setInterval attivi.`);
      }
      const id = inlineNextTimerId++;
      const handle = setInterval(() => {
        try {
          ctx.evalSync(`globalThis.__cbRegistry && globalThis.__cbRegistry[${String(cbId)}] && globalThis.__cbRegistry[${String(cbId)}]();`, { timeout: 1_000 });
        } catch { /* swallow */ }
      }, Math.max(1, Math.floor(delayMs)));
      inlineHostTimers.set(id, handle);
      return id;
    }));
    await jail.set('__hostClearInterval', new ivm.Reference((id: number) => {
      const h = inlineHostTimers.get(id);
      if (h) { clearInterval(h); inlineHostTimers.delete(id); }
    }));
    await ctx.eval(`
      globalThis.__cbRegistry = Object.create(null);
      globalThis.__cbNext = 1;
      function __registerCb(cb) {
        var id = globalThis.__cbNext++;
        globalThis.__cbRegistry[id] = cb;
        return id;
      }
      globalThis.setTimeout = function(cb, ms) {
        if (typeof cb !== 'function') return 0;
        var cbId = __registerCb(cb);
        var d = Number(ms);
        if (!isFinite(d) || d < 0) d = 0;
        return __hostSetTimeout.applySync(undefined, [d, cbId], { arguments: { copy: true } });
      };
      globalThis.clearTimeout = function(id) {
        try { __hostClearTimeout.applySync(undefined, [Number(id) || 0], { arguments: { copy: true } }); } catch (e) {}
      };
      globalThis.setInterval = function(cb, ms) {
        if (typeof cb !== 'function') return 0;
        var cbId = __registerCb(cb);
        var d = Number(ms);
        if (!isFinite(d) || d < 1) d = 1;
        return __hostSetInterval.applySync(undefined, [d, cbId], { arguments: { copy: true } });
      };
      globalThis.clearInterval = function(id) {
        try { __hostClearInterval.applySync(undefined, [Number(id) || 0], { arguments: { copy: true } }); } catch (e) {}
      };
    `, { timeout: 1_000 });

    // ───── Web globals shim (AbortController + AbortSignal) ─────
    // isolated-vm V8 puro non espone le web API moderne. Vendor che usano
    // AbortController per timeout/cancellation fail con "is not defined".
    await ctx.eval(`
      if (typeof AbortController === 'undefined') {
        function ASig() { this.aborted = false; this.reason = undefined; this._l = []; }
        ASig.prototype.addEventListener = function(t, cb) { if (t === 'abort') this._l.push(cb); };
        ASig.prototype.removeEventListener = function(t, cb) { if (t === 'abort') this._l = this._l.filter(function(x){return x!==cb;}); };
        ASig.prototype.throwIfAborted = function() { if (this.aborted) throw new Error(this.reason || 'AbortError'); };
        ASig.timeout = function(ms) {
          var s = new ASig();
          setTimeout(function(){ s.aborted = true; s.reason = 'TimeoutError'; s._l.forEach(function(cb){try{cb();}catch(e){}});}, ms);
          return s;
        };
        function ACtrl() { this.signal = new ASig(); }
        ACtrl.prototype.abort = function(reason) {
          this.signal.aborted = true;
          this.signal.reason = reason;
          this.signal._l.forEach(function(cb){try{cb();}catch(e){}});
        };
        globalThis.AbortController = ACtrl;
        globalThis.AbortSignal = ASig;
      }
      // Altri web globals minimi che vendor potrebbero usare
      if (typeof structuredClone === 'undefined') {
        globalThis.structuredClone = function(x) { return JSON.parse(JSON.stringify(x)); };
      }
      if (typeof queueMicrotask === 'undefined') {
        globalThis.queueMicrotask = function(cb) { Promise.resolve().then(cb); };
      }
      // URL shim via host bridge (vedi __urlParse): WHATWG fidelity completa.
      if (typeof URL === 'undefined') {
        function FFURL(input, base) {
          var raw = String(input);
          var parsed = __urlParse.applySync(undefined, base ? [raw, String(base)] : [raw], { arguments: { copy: true }, result: { copy: true } });
          if (!parsed || !parsed.ok) throw new TypeError('Invalid URL: ' + raw + (parsed && parsed.error ? ' (' + parsed.error + ')' : ''));
          this.protocol = parsed.protocol; this.host = parsed.host; this.hostname = parsed.hostname;
          this.port = parsed.port; this.pathname = parsed.pathname; this.search = parsed.search;
          this.hash = parsed.hash; this.origin = parsed.origin; this.href = parsed.href;
          this.username = parsed.username || ''; this.password = parsed.password || '';
          this._searchParams = null;
        }
        FFURL.prototype.toString = function() { return this.href; };
        FFURL.prototype.toJSON = function() { return this.href; };
        FFURL.canParse = function(input, base) {
          var parsed = __urlParse.applySync(undefined, base ? [String(input), String(base)] : [String(input)], { arguments: { copy: true }, result: { copy: true } });
          return !!(parsed && parsed.ok);
        };
        // ROOT CAUSE #7: searchParams getter LIVE (WHATWG URL behavior).
        Object.defineProperty(FFURL.prototype, 'searchParams', {
          configurable: true, enumerable: true,
          get: function() {
            if (this._searchParams !== null) return this._searchParams;
            var self = this;
            var sp = new URLSearchParams(self.search || '');
            var sync = function() {
              var s = sp.toString();
              self.search = s ? '?' + s : '';
              var auth = self.username ? (self.username + (self.password ? ':' + self.password : '') + '@') : '';
              self.href = self.protocol + '//' + auth + self.host + self.pathname + self.search + self.hash;
            };
            var origSet = sp.set; var origAppend = sp.append; var origDelete = sp['delete'];
            sp.set = function(k, v) { origSet.call(sp, k, v); sync(); };
            sp.append = function(k, v) { origAppend.call(sp, k, v); sync(); };
            sp['delete'] = function(k) { origDelete.call(sp, k); sync(); };
            self._searchParams = sp;
            return sp;
          }
        });
        globalThis.URL = FFURL;
      }
      if (typeof URLSearchParams === 'undefined') {
        function FFURLSearchParams(init) {
          this._p = [];
          if (typeof init === 'string') {
            var s = init.replace(/^\\?/, '');
            if (s.length > 0) {
              var parts = s.split('&');
              for (var i = 0; i < parts.length; i++) {
                var kv = parts[i].split('=');
                this._p.push([decodeURIComponent(kv[0].replace(/\\+/g, ' ')), kv.length > 1 ? decodeURIComponent(kv.slice(1).join('=').replace(/\\+/g, ' ')) : '']);
              }
            }
          } else if (init && typeof init === 'object') {
            if (Array.isArray(init)) { for (var j = 0; j < init.length; j++) this._p.push([String(init[j][0]), String(init[j][1])]); }
            else { for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) this._p.push([k, String(init[k])]); }
          }
        }
        FFURLSearchParams.prototype.get = function(k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) return this._p[i][1]; return null; };
        FFURLSearchParams.prototype.getAll = function(k) { var r = []; for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) r.push(this._p[i][1]); return r; };
        FFURLSearchParams.prototype.has = function(k) { return this.get(k) !== null; };
        FFURLSearchParams.prototype.set = function(k, v) { var f = false; for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) { if (!f) { this._p[i][1] = String(v); f = true; } else { this._p.splice(i, 1); i--; } } if (!f) this._p.push([k, String(v)]); };
        FFURLSearchParams.prototype.append = function(k, v) { this._p.push([String(k), String(v)]); };
        FFURLSearchParams.prototype['delete'] = function(k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) { this._p.splice(i, 1); i--; } };
        FFURLSearchParams.prototype.toString = function() { var out = []; for (var i = 0; i < this._p.length; i++) out.push(encodeURIComponent(this._p[i][0]) + '=' + encodeURIComponent(this._p[i][1])); return out.join('&'); };
        FFURLSearchParams.prototype.forEach = function(cb, thisArg) { for (var i = 0; i < this._p.length; i++) cb.call(thisArg, this._p[i][1], this._p[i][0], this); };
        FFURLSearchParams.prototype[Symbol.iterator] = function() { var arr = this._p.slice(); var idx = 0; return { next: function() { return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined, done: true }; } }; };
        globalThis.URLSearchParams = FFURLSearchParams;
      }
      // ROOT CAUSE #10 — node:crypto shim isolate-side, identico al worker path.
      globalThis.__nodeCrypto = {
        createHmac(algo, secret) {
          var _algo = String(algo); var _secret = String(secret); var chunks = '';
          return {
            update(data, enc) {
              if (typeof data === 'string') chunks += data;
              else if (data && typeof data.toString === 'function') chunks += data.toString(enc || 'utf8');
              return this;
            },
            digest(outEnc) {
              return __cryptoHmac.applySync(undefined, [_algo, _secret, chunks, String(outEnc || 'hex')], { arguments: { copy: true }, result: { copy: true } });
            },
          };
        },
        createHash(algo) {
          var _algo = String(algo); var chunks = '';
          return {
            update(data, enc) {
              if (typeof data === 'string') chunks += data;
              else if (data && typeof data.toString === 'function') chunks += data.toString(enc || 'utf8');
              return this;
            },
            digest(outEnc) {
              return __cryptoHash.applySync(undefined, [_algo, chunks, String(outEnc || 'hex')], { arguments: { copy: true }, result: { copy: true } });
            },
          };
        },
        randomBytes(size, cb) {
          var hex = __cryptoRandomBytes.applySync(undefined, [Number(size), 'hex'], { arguments: { copy: true }, result: { copy: true } });
          var pseudoBuf = {
            _hex: hex, length: Number(size),
            toString(enc) {
              if (!enc || enc === 'hex') return hex;
              if (enc === 'base64') return __cryptoRandomBytes.applySync(undefined, [Number(size), 'base64'], { arguments: { copy: true }, result: { copy: true } });
              return hex;
            },
          };
          if (typeof cb === 'function') { cb(null, pseudoBuf); return; }
          return pseudoBuf;
        },
        randomUUID() { return __cryptoRandomUUID.applySync(undefined, [], { arguments: { copy: true }, result: { copy: true } }); },
        timingSafeEqual(a, b) {
          var aHex = typeof a === 'string' ? a : (a && typeof a.toString === 'function' ? a.toString('hex') : '');
          var bHex = typeof b === 'string' ? b : (b && typeof b.toString === 'function' ? b.toString('hex') : '');
          return __cryptoTimingSafeEqual.applySync(undefined, [aHex, bHex, 'hex'], { arguments: { copy: true }, result: { copy: true } });
        },
      };
      if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {};
      if (typeof globalThis.crypto.randomUUID === 'undefined') {
        globalThis.crypto.randomUUID = function() { return globalThis.__nodeCrypto.randomUUID(); };
      }

      // atob/btoa shim — necessari per fetch().arrayBuffer() che decodifica
      // bodyBase64 inviato dall'host fetch proxy.
      if (typeof atob === 'undefined') {
        globalThis.atob = function(b64) {
          var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          b64 = String(b64).replace(/=+$/, '');
          var out = '';
          for (var i = 0, bc = 0, bs = 0, c; (c = b64.charAt(i)); i++) {
            var idx = chars.indexOf(c); if (idx < 0) continue;
            bs = bc % 4 ? bs * 64 + idx : idx;
            if (bc++ % 4) { out += String.fromCharCode(0xff & (bs >> ((-2 * bc) & 6))); }
          }
          return out;
        };
      }
      if (typeof btoa === 'undefined') {
        globalThis.btoa = function(str) {
          var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          var out = '', i = 0, len = str.length;
          while (i < len) {
            var c1 = str.charCodeAt(i++) & 0xff;
            var c2 = str.charCodeAt(i++) & 0xff;
            var c3 = str.charCodeAt(i++) & 0xff;
            var e1 = c1 >> 2;
            var e2 = ((c1 & 3) << 4) | (c2 >> 4);
            var e3 = ((c2 & 15) << 2) | (c3 >> 6);
            var e4 = c3 & 63;
            if (isNaN(c2)) e3 = e4 = 64;
            else if (isNaN(c3)) e4 = 64;
            out += chars.charAt(e1) + chars.charAt(e2) + (e3 === 64 ? '=' : chars.charAt(e3)) + (e4 === 64 ? '=' : chars.charAt(e4));
          }
          return out;
        };
      }
    `, { timeout: 1_000 });

    // ───── STDLIB INJECTION (Pipedream pattern dollar) ─────
    // Bundle ESM browser-safe (~12KB) iniettato prima del vendor source.
    // Espone globalThis.ff dentro l'isolate con tutti gli helper:
    // ff.csv, ff.crypto, ff.transform, ff.text, ff.url, ff.jsonpath, ff.time.
    // Vendor scrive: const rows = ff.csv.parseCsv(input); come Pipedream dollar.
    await ctx.eval(STDLIB_BUNDLE, { timeout: 2_000 });

    // ───── Compile + run vendor ─────
    const script = await isolate.compileScript(buildBootstrap(source));
    // Il `timeout` di isolated-vm è basato sul TEMPO-CPU: con `promise: true` NON
    // limita un await che lascia l'isolate IDLE (es. `await new Promise(()=>{})` o un
    // fetch host che non risolve) → il main thread resta appeso. Wall-clock race +
    // dispose dell'isolate per sbloccare l'await pendente (gemello del safetyKill del
    // worker). Margine oltre il CPU timeout per non rubargli i casi legittimi-lenti.
    const cpuTimeoutMs = execTimeoutMs();
    const HOST_WALL_TIMEOUT_MS = cpuTimeoutMs + SANDBOX_ASYNC_GRACE_MS;
    let hostKill: NodeJS.Timeout | undefined;
    const resultJson = await Promise.race([
      script.run(ctx, { timeout: cpuTimeoutMs, promise: true }) as Promise<string>,
      new Promise<never>((_, reject) => {
        hostKill = setTimeout(() => {
          if (!isolate.isDisposed) { try { isolate.dispose(); } catch { /* race con finally */ } }
          reject(new Error(`Community node: timeout host ${String(HOST_WALL_TIMEOUT_MS)}ms — await non risolto o hang async (l'isolate non consumava CPU).`));
        }, HOST_WALL_TIMEOUT_MS);
        if (typeof hostKill.unref === 'function') hostKill.unref();
      }),
    ]).finally(() => { if (hostKill) clearTimeout(hostKill); });

    if (logCapture.length > 0) {
      logger.info({
        logs: logCapture.slice(0, 20),
        truncated: logCapture.length > 20,
        nodeId: input.context.nodeId,
      }, 'Community node sandbox logs');
    }
    if (trace) {
      trace.logs = logCapture.slice();
      trace.durationMs = Date.now() - startMs;
      if (logsDropped > 0) {
        trace.logs.push(`[meta] ${String(logsDropped)} log entries droppati (cap ${String(TRACE_MAX_LOG_ENTRIES)})`);
      }
      if (netEventsDropped > 0) {
        trace.logs.push(`[meta] ${String(netEventsDropped)} network event droppati (cap ${String(TRACE_MAX_NETWORK_EVENTS)})`);
      }
    }
    // #226 forward al collector — anche per inline path
    if (input.collector) {
      forwardSandboxLogsToCollector(
        { logs: logCapture.slice(), network: trace?.network ? trace.network.slice() : [], durationMs: Date.now() - startMs },
        input.collector,
      );
    }

    // The bootstrap stringifies the vendor's return value into
    // { ok, value | error }. Parse it on the host side.
    let parsed: { ok: true; value: unknown } | { ok: false; error: string };
    try {
      parsed = JSON.parse(resultJson) as typeof parsed;
    } catch {
      throw new Error('Community node returned non-serializable value');
    }
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  } finally {
    // #223: clear pending host-bridged timers BEFORE isolate dispose
    // (altrimenti il setTimeout host callback chiama un Reference morto)
    for (const h of inlineHostTimers.values()) {
      try { clearTimeout(h); clearInterval(h); } catch { /* swallow */ }
    }
    inlineHostTimers.clear();
    // Dispose synchronously to release native memory immediately. Idempotente: il
    // wall-clock kill della Promise.race può averlo già disposto per sbloccare un hang.
    if (!isolate.isDisposed) isolate.dispose();
  }
}
