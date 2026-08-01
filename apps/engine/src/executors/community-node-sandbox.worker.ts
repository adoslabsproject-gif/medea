/**
 * Worker thread entry-point per community-node-sandbox.
 *
 * Gira in un `worker_threads.Worker` separato dal main event-loop del runtime.
 * Riceve via `workerData`:
 *   - source       (string)   : codice vendor (gia\` bootstrap-wrapped)
 *   - input        (SandboxInput)
 *   - captureTrace (boolean)  : se true, popola trace.logs + trace.network
 *
 * Esegue l'isolated-vm sandbox e ritorna via `parentPort.postMessage`:
 *   { ok: true; value: unknown; trace?: { logs, network, durationMs } }
 *   { ok: false; error: string }
 *
 * VANTAGGIO Cappella Sistina vs. main-thread:
 *   - Un custom node con `while(true)` blocca solo IL worker, NON il runtime
 *     principale. Il container tenant resta responsive su tutte le altre
 *     route (auth, health, websocket, dashboard).
 *   - isolated-vm gia\` enforced CPU timeout 15s tramite V8 isolate ma il
 *     processo Node host era comunque bloccato finche\` V8 non rilascia.
 *
 * LIMITI DI RISORSA EFFETTIVI (non aspirazionali):
 *   - CPU: timeout 15s del V8 isolate.
 *   - Timer host: max {@link MAX_HOST_TIMERS} concorrenti (oltre → throw); tutti i
 *     timer residui sono cancellati nel `finally` (no interval che sopravvive al run).
 *   - Body fetch: cappato (vedi cap proxy fetch). Log trace: cappati.
 *
 * @module executors/community-node-sandbox.worker
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { guardedRandomBytes } from './sandbox-crypto-guard.js';
import ivm from 'isolated-vm';
import { STDLIB_BUNDLE } from '@flowforge/nodes-stdlib-sandbox/bundle-source';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { validateUrlForFetch } from '@flowforge/safe-fetch';
import { readBytesCapped } from '@/lib/capped-response.js';

/** Cap del body letto dal proxy fetch del sandbox (20MB) — marshallato text+base64. */
const SANDBOX_FETCH_MAX_BYTES = 20 * 1024 * 1024;

const MEMORY_LIMIT_MB = 128;
const EXEC_TIMEOUT_MS = 15_000;

/** Cap del trace logging (defensive — coerente col main thread). */
const TRACE_MAX_LOG_ENTRIES = 256;
/**
 * Cap sul numero di timer host CONCORRENTI per esecuzione. Un custom node ostile può
 * fare `for(;;) setInterval(...)` e creare milioni di timer host (handle reali + entry
 * in hostTimers) PRIMA che scatti il timeout CPU 15s → esaurimento memoria/handle nel
 * processo host (non solo nell'isolate). Oltre il cap, la creazione lancia.
 */
const MAX_HOST_TIMERS = 1_000;
const TRACE_MAX_LOG_CHARS = 4_096;
const TRACE_MAX_NETWORK_EVENTS = 128;

if (!parentPort) {
  throw new Error('community-node-sandbox.worker must run as Worker thread');
}

interface FetchProxyResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  bodyText: string;
  bodyBase64: string;
  bodyLength: number;
}

interface SandboxNetworkEvent {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  bytesIn: number;
  ok: boolean;
  startedAt: number;
}

interface WorkerInput {
  bootstrapSource: string;
  config: unknown;
  input: unknown;
  contextMeta: {
    tenantId: string;
    runId: string;
    workflowId: string;
    nodeId: string;
    action: string;
  };
  captureTrace: boolean;
}

/**
 * Host-side fetch — il worker fa la fetch (ha accesso al network), poi
 * restituisce body come base64 attraverso il boundary V8.
 *
 * 2026-06-09 AUDIT FIX C1 (SSRF):
 *   Pre-fix: il worker usava `fetch(url, init)` raw, BYPASSANDO il SSRF guard
 *   (safeOutboundFetch + validateUrlForFetch). Un community/marketplace node
 *   malevolo poteva colpire cloud metadata (169.254.169.254), Docker socket,
 *   Postgres/Redis/vLLM interni — entry-point worker thread.
 *
 *   Fix: stesso pattern di `community-node-sandbox.ts:226` (main-thread path).
 *   safeOutboundFetch applica SSRF guard + per-host breaker + OTel span +
 *   timeout. `redirect: 'manual'` blocca redirect-chain bypass (vendor → 302
 *   → http://127.0.0.1:6379). 3xx → throw esplicito. 5xx/429 → throw per
 *   attivare breaker count.
 */
async function hostFetch(url: string, initJson?: string): Promise<FetchProxyResponse> {
  const init = initJson ? (JSON.parse(initJson) as RequestInit) : undefined;
  // #223 ROOT CAUSE: l'isolate passa init.signal serializzato come oggetto JS
  // plain (è il MIO AbortSignal shim, non l'AbortSignal nativo Node). Node
  // fetch rigetta con TypeError "options.signal must be an AbortSignal".
  // Rimuovo il signal: il timeout lo gestisce il bundle stesso via Promise.race
  // con il suo "aborter" Promise. Lo stesso per altri campi non-fetch-API
  // come timeoutMs.
  if (init) {
    if ('signal' in init) delete (init as Record<string, unknown>).signal;
    if ('timeoutMs' in init) delete (init as Record<string, unknown>).timeoutMs;
  }
  process.stderr.write(`[community-fetch.worker] BEFORE url=${url} method=${(init?.method ?? 'GET')}\n`);
  // Redirect-following SICURO (parità con il path inline community-node-sandbox.ts):
  // `redirect: 'manual'` + RI-VALIDAZIONE SSRF di OGNI Location (no redirect-chain
  // bypass verso IP interni) + cap hop + downgrade POST→GET. PRIMA il worker faceva
  // un hard-reject di OGNI 3xx → rompeva ogni sito che fa un redirect legittimo
  // (http→https, mirror, apex→www): un fix SSRF propagato a metà (l'inline seguiva i
  // redirect in sicurezza dal 14/6, il worker era rimasto indietro = bug Streammy).
  const MAX_REDIRECTS = 10;
  let currentUrl = url;
  let reqInit: RequestInit = { ...(init ?? {}) };
  let hops = 0;
  let res: Awaited<ReturnType<typeof safeOutboundFetch>>;
  for (;;) {
    try {
      res = await safeOutboundFetch(currentUrl, {
        ...reqInit,
        redirect: 'manual',
        spanName: 'node.community.fetch.worker',
      });
    } catch (e) {
      process.stderr.write(`[community-fetch.worker] ERR url=${currentUrl} msg=${(e as Error).message}\n`);
      throw e;
    }
    if (res.status < 300 || res.status >= 400) break; // risposta finale (non redirect)
    const loc = res.headers.get('location');
    if (!loc) break; // 3xx senza Location → trattala come finale
    if (++hops > MAX_REDIRECTS) throw new Error(`SSRF guard: troppi redirect (>${String(MAX_REDIRECTS)})`);
    const next = new URL(loc, currentUrl).toString();
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
  const buf = await readBytesCapped(res, SANDBOX_FETCH_MAX_BYTES); // anti-OOM (era arrayBuffer integrale ×3 marshalling)
  process.stderr.write(`[community-fetch.worker] AFTER url=${currentUrl} status=${String(res.status)} ok=${String(res.ok)} bytes=${String(buf.length)}\n`);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const response: FetchProxyResponse = {
    status: res.status,
    ok: res.ok,
    headers,
    bodyText: buf.toString('utf8'),
    bodyBase64: buf.toString('base64'),
    bodyLength: buf.length,
  };
  // 5xx + 429 attivano il breaker count anche su body parsato OK (same pattern main thread)
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`HTTP ${String(res.status)} from ${new URL(currentUrl).host} (breaker-tracked)`);
  }
  return response;
}

async function run(d: WorkerInput): Promise<void> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  const logCapture: string[] = [];
  const network: SandboxNetworkEvent[] = [];
  const startMs = Date.now();
  // #223 host-bridged timer registry — out-of-try per accesso nel finally
  const hostTimers = new Map<number, NodeJS.Timeout>();
  let nextTimerId = 1;

  try {
    const ctx = await isolate.createContext();
    const jail = ctx.global;
    await jail.set('global', jail.derefInto());

    // Inputs
    await jail.set('__config', new ivm.ExternalCopy(d.config).copyInto());
    await jail.set('__input', new ivm.ExternalCopy(d.input).copyInto());
    await jail.set('__context', new ivm.ExternalCopy(d.contextMeta).copyInto());

    // Log capture
    await jail.set('__log', new ivm.Callback((level: string, msg: string) => {
      if (logCapture.length >= TRACE_MAX_LOG_ENTRIES) return;
      const truncated = msg.length > TRACE_MAX_LOG_CHARS
        ? `${msg.slice(0, TRACE_MAX_LOG_CHARS)}… [${String(msg.length - TRACE_MAX_LOG_CHARS)} chars truncated]`
        : msg;
      logCapture.push(`[${level}] ${truncated}`);
    }));
    // ROOT CAUSE #3 (2026-06-09): `const console = ...` ha block-scope nello
    // script eval — NON è visibile al successivo `script.run(ctx)` del vendor
    // bundle. Devo assegnarlo a globalThis perché diventi proprietà del global
    // object accessibile dagli altri script che girano nello stesso isolate.
    // Stesso applicato a fetch + Buffer + AbortController shim sotto.
    await ctx.eval(`
      globalThis.console = {
        log:   (...a) => __log('log',   a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
        warn:  (...a) => __log('warn',  a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
        error: (...a) => __log('error', a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
      };
    `);

    // Fetch proxy
    await jail.set('__fetch', new ivm.Reference(async (url: string, initJson?: string) => {
      const t0 = Date.now();
      const init = initJson ? (JSON.parse(initJson) as { method?: string }) : undefined;
      let res: FetchProxyResponse;
      try {
        res = await hostFetch(url, initJson);
      } catch (err) {
        const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // Cappella Sistina+: log host fetch failure nel buffer logs del sandbox
        // così il LogCollector lo forwarda allo step + dashboard senza
        // dover decompilare il bundle vendor.
        if (logCapture.length < TRACE_MAX_LOG_ENTRIES) {
          logCapture.push(`[error] [ff/host-fetch] ${url} → ${errMsg}`);
        }
        if (d.captureTrace && network.length < TRACE_MAX_NETWORK_EVENTS) {
          network.push({ url, method: init?.method ?? 'GET', status: 0, durationMs: Date.now() - t0, bytesIn: 0, ok: false, startedAt: t0 });
        }
        throw err;
      }
      if (d.captureTrace && network.length < TRACE_MAX_NETWORK_EVENTS) {
        network.push({ url, method: init?.method ?? 'GET', status: res.status, durationMs: Date.now() - t0, bytesIn: res.bodyLength, ok: res.ok, startedAt: t0 });
      }
      return new ivm.ExternalCopy(res).copyInto();
    }));
    await ctx.eval(`
      globalThis.fetch = async (url, init) => {
        try {
          var __initStr = undefined;
          if (init) {
            // Sanitize init prima del JSON.stringify: rimuovi signal (Abort
            // shim non serializzabile), redirect e altre proprietà non-JSON.
            var safe = {};
            if (init.method) safe.method = String(init.method);
            if (init.headers && typeof init.headers === 'object') safe.headers = init.headers;
            if (init.body !== undefined) safe.body = init.body;
            if (init.redirect) safe.redirect = String(init.redirect);
            __initStr = JSON.stringify(safe);
          }
        } catch (e) {
          console.error('[ff/fetch-shim] init serialize fail: ' + (e && e.message ? e.message : String(e)));
          throw e;
        }
        let res;
        try {
          res = await __fetch.apply(undefined, [String(url), __initStr], { arguments: { copy: true }, result: { promise: true, copy: true } });
        } catch (e) {
          console.error('[ff/fetch-shim] __fetch.apply throw url=' + String(url) + ' err=' + (e && e.message ? e.message : String(e)));
          throw e;
        }
        return {
          status: res.status,
          ok: res.ok,
          headers: {
            get: (k) => res.headers[String(k).toLowerCase()] || null,
            entries: () => Object.entries(res.headers),
          },
          text: async () => res.bodyText,
          json: async () => JSON.parse(res.bodyText),
          bytes: async () => ({ base64: res.bodyBase64, length: res.bodyLength }),
          arrayBuffer: async () => {
            // Decodifica base64 nell'host (richiede atob/Uint8Array shim)
            const b = res.bodyBase64;
            const bin = atob(b);
            const len = bin.length;
            const ab = new ArrayBuffer(len);
            const view = new Uint8Array(ab);
            for (let i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
            return ab;
          },
        };
      };
    `);

    // Buffer shim
    await jail.set('__bufferFrom', new ivm.Reference((data: string, encoding: string) => {
      const buf = Buffer.from(data, encoding as BufferEncoding);
      return new ivm.ExternalCopy({ bytes: buf.toString('base64'), length: buf.length }).copyInto();
    }));
    await jail.set('__bufferToString', new ivm.Reference((base64: string, encoding: string) => {
      return Buffer.from(base64, 'base64').toString(encoding as BufferEncoding);
    }));
    // ROOT CAUSE #8 (2026-06-09): Buffer.byteLength(str, enc) — usato dal
    // bundle catalog_page per calcolare Content-Length della render HTML.
    // Senza shim: TypeError "Buffer.byteLength is not a function".
    await jail.set('__bufferByteLength', new ivm.Reference((data: string, encoding: string) => {
      return Buffer.byteLength(data, encoding as BufferEncoding);
    }));

    // ROOT CAUSE #10 (2026-06-09): node:crypto bridge — sistemico per OGNI
    // custom node che firma HMAC/hash payload (rotator HMAC signed URLs,
    // OAuth state, JWT, ecc). isolated-vm V8 NON include node:crypto.
    // Stream proxy seed mode chiama `createHmac("sha256", secret).update(s).digest("hex")`
    // → TypeError "createHmac is not a function".
    // Espongo i metodi più usati via Reference sync (host-bridge): createHmac,
    // createHash, randomBytes, randomUUID, timingSafeEqual.
    await jail.set('__cryptoHmac', new ivm.Reference((algo: string, secret: string, data: string, outEncoding: string) => {
      return createHmac(algo, secret).update(data, 'utf8').digest(outEncoding as 'hex' | 'base64' | 'binary');
    }));
    await jail.set('__cryptoHash', new ivm.Reference((algo: string, data: string, outEncoding: string) => {
      return createHash(algo).update(data, 'utf8').digest(outEncoding as 'hex' | 'base64' | 'binary');
    }));
    await jail.set('__cryptoRandomBytes', new ivm.Reference((size: number, outEncoding: string) => {
      // Guardia anti-OOM host (vedi sandbox-crypto-guard): stesso bridge dell'inline.
      const buf = guardedRandomBytes(size);
      return outEncoding === 'buffer' ? buf.toString('base64') : buf.toString(outEncoding as 'hex' | 'base64' | 'binary');
    }));
    await jail.set('__cryptoRandomUUID', new ivm.Reference(() => {
      return randomUUID();
    }));
    await jail.set('__cryptoTimingSafeEqual', new ivm.Reference((a: string, b: string, encoding: string) => {
      const ba = Buffer.from(a, encoding as BufferEncoding);
      const bb = Buffer.from(b, encoding as BufferEncoding);
      if (ba.length !== bb.length) return false;
      return timingSafeEqual(ba, bb);
    }));
    await ctx.eval(`
      // ROOT CAUSE #11 (2026-06-09): Buffer.from accept binary data (ArrayBuffer/
      // Uint8Array). Stream proxy fa Buffer.from(await res.arrayBuffer()) per
      // HLS playlist binary. Pre-fix: String(ArrayBuffer) = "[object ArrayBuffer]"
      // → URL proxy firmati con quell'oggetto → playback rotto.
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
          // Caso 1: stringa (path legacy + base64/hex/utf8 decoding)
          if (typeof data === 'string') return __ffBufferFromString(data, encoding);
          // Caso 2: ArrayBuffer/TypedArray — converti in hex → bridge senza
          // perdita dei bytes binari (sostituisce "[object ArrayBuffer]" rotto).
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
          // Caso 3: number array (es. [104, 105])
          if (Array.isArray(data)) {
            var hex2 = '';
            for (var j = 0; j < data.length; j++) {
              var n = (Number(data[j]) | 0) & 0xff;
              var b2 = n.toString(16);
              hex2 += b2.length === 1 ? '0' + b2 : b2;
            }
            return __ffBufferFromHex(hex2, 'utf8');
          }
          // Fallback: stringify (legacy)
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

    // ─── ROOT CAUSE #5 fix: URL global shim ─────────────────────────────
    // isolated-vm crea un V8 context VUOTO (solo ECMA-262: no Web/Node APIs).
    // `URL` è WHATWG Web API, NON ECMA — quindi `new URL(raw)` lancia
    // ReferenceError "URL is not defined" dentro l'isolate.
    // Il bundle del rotator (riga 329 del bundle: `const u = new URL(raw)`)
    // catcha l'error e ritorna "invalid URL" → tutti 6 candidates falliscono
    // PRIMA della fetch → NO_LIVE_HOST mascherato.
    //
    // FIX Cappella Sistina+: bridge il WHATWG URL del Node host nell'isolate
    // via Reference sync. Fidelity completa (protocol/host/hostname/port/
    // pathname/search/hash/origin/href + URLSearchParams via search).
    await jail.set('__urlParse', new ivm.Reference((raw: string, base?: string) => {
      try {
        const u = base ? new URL(raw, base) : new URL(raw);
        return new ivm.ExternalCopy({
          ok: true,
          protocol: u.protocol,
          host: u.host,
          hostname: u.hostname,
          port: u.port,
          pathname: u.pathname,
          search: u.search,
          hash: u.hash,
          origin: u.origin,
          href: u.href,
          username: u.username,
          password: u.password,
        }).copyInto();
      } catch (err) {
        return new ivm.ExternalCopy({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }).copyInto();
      }
    }));

    // ─── #223 + ROOT CAUSE #2 fix: setTimeout/clearTimeout/setInterval ────
    // ROOT CAUSE #2 (NO_LIVE_HOST workflow Streammy):
    //   `arguments: { reference: true }` wrappa I PRIMITIVE (es. Number 15000)
    //   come ivm.Reference NON dereferenziati → host riceve `undefined` →
    //   `Math.floor(undefined) = NaN` → `setTimeout(cb, NaN)` scatta SUBITO →
    //   pipelineTimeout (15s) di action_domain_rotator scatta a 0ms →
    //   parentSignal.aborted = true → 6 probe ritornano "aborted_before_probe"
    //   senza chiamare fetch → NO_LIVE_HOST mascherato.
    //
    // FIX: separare il payload. Numeri passati come COPY (deserializzati
    // correttamente lato host), callbacks passati via registry isolate-side
    // con un id (number). Il host triggera l'eval via __invokeCb(id).
    await jail.set('__hostSetTimeout', new ivm.Reference((delayMs: number, cbId: number) => {
      if (hostTimers.size >= MAX_HOST_TIMERS) {
        throw new Error(`Limite timer sandbox superato (${String(MAX_HOST_TIMERS)}): troppi setTimeout/setInterval attivi.`);
      }
      const id = nextTimerId++;
      const effectiveMs = Math.max(0, Math.floor(delayMs));
      // Diagnostic: log del delay reale ricevuto host-side, push in logCapture
      // così appare nel step.logs (verifica fix cb registry: delayMs=15000 atteso).
      if (logCapture.length < TRACE_MAX_LOG_ENTRIES) {
        logCapture.push(`[debug] [ff/setTimeout] id=${String(id)} cbId=${String(cbId)} requestedMs=${String(delayMs)} effectiveMs=${String(effectiveMs)}`);
      }
      const handle = setTimeout(() => {
        hostTimers.delete(id);
        try {
          ctx.evalSync(`globalThis.__cbRegistry && globalThis.__cbRegistry[${String(cbId)}] && globalThis.__cbRegistry[${String(cbId)}](); delete globalThis.__cbRegistry[${String(cbId)}];`, { timeout: 1_000 });
        } catch { /* cb crash inside isolate — swallow per evitare worker death */ }
      }, effectiveMs);
      hostTimers.set(id, handle);
      return id;
    }));
    await jail.set('__hostClearTimeout', new ivm.Reference((id: number) => {
      const h = hostTimers.get(id);
      if (h) { clearTimeout(h); hostTimers.delete(id); }
    }));
    await jail.set('__hostSetInterval', new ivm.Reference((delayMs: number, cbId: number) => {
      if (hostTimers.size >= MAX_HOST_TIMERS) {
        throw new Error(`Limite timer sandbox superato (${String(MAX_HOST_TIMERS)}): troppi setTimeout/setInterval attivi.`);
      }
      const id = nextTimerId++;
      const handle = setInterval(() => {
        try {
          ctx.evalSync(`globalThis.__cbRegistry && globalThis.__cbRegistry[${String(cbId)}] && globalThis.__cbRegistry[${String(cbId)}]();`, { timeout: 1_000 });
        } catch { /* swallow */ }
      }, Math.max(1, Math.floor(delayMs)));
      hostTimers.set(id, handle);
      return id;
    }));
    await jail.set('__hostClearInterval', new ivm.Reference((id: number) => {
      const h = hostTimers.get(id);
      if (h) { clearInterval(h); hostTimers.delete(id); }
    }));

    // Web globals shim (AbortController, structuredClone, queueMicrotask, timers)
    await ctx.eval(`
      // Timer shim — host-bridged via cb registry isolate-side.
      // I numeri sono passati come COPY (deserializzati correttamente),
      // i callback registrati in __cbRegistry con id numerico.
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

      if (typeof AbortController === 'undefined') {
        function ASig() { this.aborted = false; this.reason = undefined; this._l = []; }
        ASig.prototype.addEventListener = function(t, cb) { if (t === 'abort') this._l.push(cb); };
        ASig.prototype.removeEventListener = function(t, cb) { if (t === 'abort') this._l = this._l.filter(function(x){return x!==cb;}); };
        ASig.prototype.throwIfAborted = function() { if (this.aborted) throw new Error(this.reason || 'AbortError'); };
        ASig.timeout = function(ms) { var s = new ASig(); setTimeout(function(){ s.aborted = true; s.reason = 'TimeoutError'; s._l.forEach(function(cb){try{cb();}catch(e){}});}, ms); return s; };
        function ACtrl() { this.signal = new ASig(); }
        ACtrl.prototype.abort = function(reason) { this.signal.aborted = true; this.signal.reason = reason; this.signal._l.forEach(function(cb){try{cb();}catch(e){}}); };
        globalThis.AbortController = ACtrl;
        globalThis.AbortSignal = ASig;
      }
      if (typeof structuredClone === 'undefined') globalThis.structuredClone = function(x) { return JSON.parse(JSON.stringify(x)); };
      if (typeof queueMicrotask === 'undefined') globalThis.queueMicrotask = function(cb) { Promise.resolve().then(cb); };

      // ROOT CAUSE #5: URL/URLSearchParams shim via host bridge (vedi __urlParse).
      // WHATWG fidelity: ogni getter/setter delega al WHATWG URL del Node host.
      if (typeof URL === 'undefined') {
        function FFURL(input, base) {
          var raw = String(input);
          var parsed = __urlParse.applySync(undefined, base ? [raw, String(base)] : [raw], { arguments: { copy: true }, result: { copy: true } });
          if (!parsed || !parsed.ok) throw new TypeError('Invalid URL: ' + raw + (parsed && parsed.error ? ' (' + parsed.error + ')' : ''));
          this.protocol = parsed.protocol;
          this.host = parsed.host;
          this.hostname = parsed.hostname;
          this.port = parsed.port;
          this.pathname = parsed.pathname;
          this.search = parsed.search;
          this.hash = parsed.hash;
          this.origin = parsed.origin;
          this.href = parsed.href;
          this.username = parsed.username || '';
          this.password = parsed.password || '';
          this._searchParams = null;
        }
        FFURL.prototype.toString = function() { return this.href; };
        FFURL.prototype.toJSON = function() { return this.href; };
        FFURL.canParse = function(input, base) {
          var parsed = __urlParse.applySync(undefined, base ? [String(input), String(base)] : [String(input)], { arguments: { copy: true }, result: { copy: true } });
          return !!(parsed && parsed.ok);
        };
        // ROOT CAUSE #7 (2026-06-09): WHATWG URL.searchParams è URLSearchParams
        // LIVE sincronizzato con .search/.href. Bundle streammy_catalog chiama
        // u.searchParams.set("cursor", cursor) - senza shim ritorna undefined.
        // Implementiamo getter lazy che wrappa set/append/delete per sync back
        // a this.search e this.href (WHATWG behavior canonico).
        Object.defineProperty(FFURL.prototype, 'searchParams', {
          configurable: true,
          enumerable: true,
          get: function() {
            if (this._searchParams !== null) return this._searchParams;
            var self = this;
            var sp = new URLSearchParams(self.search || '');
            var sync = function() {
              var s = sp.toString();
              self.search = s ? '?' + s : '';
              // Rebuild href (semplice — auth.host.path.search.hash).
              var auth = self.username ? (self.username + (self.password ? ':' + self.password : '') + '@') : '';
              self.href = self.protocol + '//' + auth + self.host + self.pathname + self.search + self.hash;
            };
            // Decora i mutator per side-effect sync (no Proxy: isolated-vm OK).
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

      // URLSearchParams shim — sufficient per la stragrande maggioranza dei
      // casi (parse + iterate + get/set/has/append/delete + toString). Niente
      // host bridge: pure JS, deterministic.
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
            if (Array.isArray(init)) {
              for (var j = 0; j < init.length; j++) this._p.push([String(init[j][0]), String(init[j][1])]);
            } else {
              for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) this._p.push([k, String(init[k])]);
            }
          }
        }
        FFURLSearchParams.prototype.get = function(k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) return this._p[i][1]; return null; };
        FFURLSearchParams.prototype.getAll = function(k) { var r = []; for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) r.push(this._p[i][1]); return r; };
        FFURLSearchParams.prototype.has = function(k) { return this.get(k) !== null; };
        FFURLSearchParams.prototype.set = function(k, v) { var found = false; for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) { if (!found) { this._p[i][1] = String(v); found = true; } else { this._p.splice(i, 1); i--; } } if (!found) this._p.push([k, String(v)]); };
        FFURLSearchParams.prototype.append = function(k, v) { this._p.push([String(k), String(v)]); };
        FFURLSearchParams.prototype['delete'] = function(k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) { this._p.splice(i, 1); i--; } };
        FFURLSearchParams.prototype.toString = function() { var out = []; for (var i = 0; i < this._p.length; i++) out.push(encodeURIComponent(this._p[i][0]) + '=' + encodeURIComponent(this._p[i][1])); return out.join('&'); };
        FFURLSearchParams.prototype.forEach = function(cb, thisArg) { for (var i = 0; i < this._p.length; i++) cb.call(thisArg, this._p[i][1], this._p[i][0], this); };
        FFURLSearchParams.prototype.entries = function() { var arr = this._p.slice(); var idx = 0; return { next: function() { return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } }; };
        FFURLSearchParams.prototype.keys = function() { var arr = this._p.slice(); var idx = 0; return { next: function() { return idx < arr.length ? { value: arr[idx++][0], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } }; };
        FFURLSearchParams.prototype.values = function() { var arr = this._p.slice(); var idx = 0; return { next: function() { return idx < arr.length ? { value: arr[idx++][1], done: false } : { value: undefined, done: true }; }, [Symbol.iterator]: function() { return this; } }; };
        FFURLSearchParams.prototype[Symbol.iterator] = FFURLSearchParams.prototype.entries;
        globalThis.URLSearchParams = FFURLSearchParams;
      }
      // ROOT CAUSE #10 — node:crypto shim. Espone __nodeCrypto compatibile con
      // Node API (createHmac/createHash/randomBytes/randomUUID/timingSafeEqual)
      // + globalThis.crypto.randomUUID per WebCrypto fidelity.
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
            _hex: hex,
            length: Number(size),
            toString(enc) {
              if (!enc || enc === 'hex') return hex;
              if (enc === 'base64') return __cryptoRandomBytes.applySync(undefined, [Number(size), 'base64'], { arguments: { copy: true }, result: { copy: true } });
              return hex;
            },
          };
          if (typeof cb === 'function') { cb(null, pseudoBuf); return; }
          return pseudoBuf;
        },
        randomUUID() {
          return __cryptoRandomUUID.applySync(undefined, [], { arguments: { copy: true }, result: { copy: true } });
        },
        timingSafeEqual(a, b) {
          // a/b sono Buffer-like — uso il loro hex per il bridge.
          var aHex = typeof a === 'string' ? a : (a && typeof a.toString === 'function' ? a.toString('hex') : '');
          var bHex = typeof b === 'string' ? b : (b && typeof b.toString === 'function' ? b.toString('hex') : '');
          return __cryptoTimingSafeEqual.applySync(undefined, [aHex, bHex, 'hex'], { arguments: { copy: true }, result: { copy: true } });
        },
      };
      // WebCrypto fidelity: globalThis.crypto.randomUUID (usato da pacchetti
      // moderni tipo ulid, nanoid, drizzle, ecc).
      if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {};
      if (typeof globalThis.crypto.randomUUID === 'undefined') {
        globalThis.crypto.randomUUID = function() { return globalThis.__nodeCrypto.randomUUID(); };
      }

      // atob/btoa shim (richiesto da fetch().arrayBuffer() che decodifica bodyBase64)
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

    // STDLIB INJECTION (Pipedream dollar pattern) — pre-eval bundle prima del vendor source.
    // Espone globalThis.ff dentro l'isolate con ff.csv/ff.crypto/ff.transform/etc.
    await ctx.eval(STDLIB_BUNDLE, { timeout: 2_000 });

    const script = await isolate.compileScript(d.bootstrapSource);
    const resultJson = await script.run(ctx, { timeout: EXEC_TIMEOUT_MS, promise: true }) as string;

    // Cappella Sistina+ error propagation: il bootstrap del sandbox include
    // serializeError → questo parsed include errorName/errorCode/errorMeta/
    // errorCause (con probes/outcomes)/errorStackHead. Forwarda TUTTO al
    // chiamante in modo che il collector loggi le ragioni reali per ogni
    // candidate fallito (es. rotator 6 probes con reason network/status/marker).
    interface ParsedOk { ok: true; value: unknown }
    interface ParsedErr {
      ok: false;
      error: string;
      errorName?: string;
      errorCode?: string;
      errorMeta?: Record<string, unknown>;
      errorContext?: Record<string, unknown>;
      errorCause?: { message?: string; name?: string; probes?: unknown[]; outcomes?: unknown[] };
      errorStackHead?: string;
    }
    let parsed: ParsedOk | ParsedErr;
    try {
      parsed = JSON.parse(resultJson) as ParsedOk | ParsedErr;
    } catch {
      parentPort!.postMessage({ ok: false, error: 'Community node returned non-serializable value' });
      return;
    }
    if (!parsed.ok) {
      parentPort!.postMessage({
        ok: false,
        error: parsed.error,
        ...(parsed.errorName ? { errorName: parsed.errorName } : {}),
        ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
        ...(parsed.errorMeta ? { errorMeta: parsed.errorMeta } : {}),
        ...(parsed.errorContext ? { errorContext: parsed.errorContext } : {}),
        ...(parsed.errorCause ? { errorCause: parsed.errorCause } : {}),
        ...(parsed.errorStackHead ? { errorStackHead: parsed.errorStackHead } : {}),
        trace: d.captureTrace ? { logs: logCapture, network, durationMs: Date.now() - startMs } : undefined,
      });
      return;
    }
    parentPort!.postMessage({
      ok: true,
      value: parsed.value,
      trace: d.captureTrace ? { logs: logCapture, network, durationMs: Date.now() - startMs } : undefined,
    });
  } catch (err) {
    parentPort!.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      trace: d.captureTrace ? { logs: logCapture, network, durationMs: Date.now() - startMs } : undefined,
    });
  } finally {
    // #223: clear host-bridged timers BEFORE isolate.dispose
    for (const h of hostTimers.values()) {
      try { clearTimeout(h); clearInterval(h); } catch { /* swallow */ }
    }
    hostTimers.clear();
    isolate.dispose();
  }
}

void run(workerData as WorkerInput);
