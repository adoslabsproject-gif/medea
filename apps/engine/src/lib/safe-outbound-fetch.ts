/**
 * safeOutboundFetch — wrapper canonical per OGNI fetch HTTP outbound runtime-side.
 *
 * Sostituisce `globalThis.fetch()` raw negli integration executor (gmail, stripe,
 * google-drive, whatsapp, ocr, etc.) con un'unica chiamata che applica
 * trasversalmente (zero ripetizione per executor):
 *
 *   1. SSRF guard            — @medea/engine-safe-fetch validateUrlForFetch
 *                              (blocca IP privati, cloud metadata, link-local)
 *   2. Per-host circuit breaker — @medea/engine-shared via executeWithHostBreaker
 *                              (5 failures → open 30s, recover half-open)
 *   3. OTel span             — withSpan(name, http.* attrs) — zero overhead
 *                              quando il tracer non e\` registrato
 *   4. Timeout opzionale     — AbortController interno (default 30s)
 *   5. Error mapping         — HttpError/NetworkError/TimeoutError tipizzati
 *                              (NodeError hierarchy → engine retry policy aware)
 *
 * Vantaggi vs `fetch` raw:
 *   • 1 host down NON drena thread pool — fast-fail per-host bucket.
 *   • Workflow LLM con 100 retry su provider giu\` non droga tutti i tenant.
 *   • Telemetry uniforme: ogni outbound ha span `http.<defId>` con method/host/status.
 *   • Idempotency / Retry NON sono qui — restano in NodeExecutorStrategy
 *     (engine) per non duplicare la policy. Questo wrapper e\` SINGLE CALL.
 *
 * Convenzione: gli executor che fanno N fetch nel loop (pagination, multipart
 * upload) chiamano safeOutboundFetch N volte — il breaker memorizza state
 * per-host attraverso le call, behavior corretto out-of-the-box.
 */

import {
  executeWithHostBreaker,
  withSpan,
  httpSpanAttrs,
  HttpError,
  NetworkError,
  TimeoutError,
} from '@medea/engine-nodes-stdlib';
import { getSecureDispatcher, getPermissiveDispatcher } from './secure-dispatcher.js';
import { readTextTruncated } from './capped-response.js';

/**
 * Difesa SSRF DNS-rebinding (2026-06-10, semplificata): UNA difesa, il dispatcher
 * undici con `connect.lookup` hook che valida l'IP ESATTO della socket al momento
 * della connessione → zero TOCTOU, copre ogni hop, nessuna DNS lookup extra (usa
 * quella che fetch fa comunque), e quando `fetch` è mockato nei test il dispatcher
 * non viene invocato → test puliti/veloci. Installato anche come dispatcher
 * GLOBALE (vedi secure-dispatcher.installGlobalSecureDispatcher) → protegge anche
 * i `fetch` raw degli executor stdlib (action_http).
 *
 * `allowPrivateHost: true` (servizi interni trusted) → dispatcher PERMISSIVO che
 * scavalca quello globale sicuro e raggiunge l'IP privato del servizio.
 *
 * Node's global fetch accetta `dispatcher` (opzione undici, non in RequestInit).
 */
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };
function withDispatcher(init: RequestInit, dispatcher: unknown): RequestInit {
  if (dispatcher === undefined) return init;
  return { ...init, dispatcher } as FetchInitWithDispatcher;
}

export interface SafeFetchOptions extends RequestInit {
  /** Timeout ms (default 30_000). 0 = no timeout. */
  timeoutMs?: number;
  /**
   * Span name custom. Default `http.outbound.<host>`.
   * Override per disambiguare nodi nello stesso trace (es. `node.gmail.send`).
   */
  spanName?: string;
  /**
   * Abort signal esterna (es. da ctx.abortSignal dell'executor) — viene
   * combinata con il timeout interno via AbortSignal.any (Node 20+).
   */
  externalSignal?: AbortSignal;
  /**
   * Salta il SSRF guard per host interni TRUSTED (servizi loopback gestiti da
   * noi: vLLM :5000, BGE-M3 :5001, PDF :5002, Vision :5004). Default false.
   *
   * ⚠️ Usare SOLO con URL hard-coded/da config server (MAI con URL utente):
   * il SSRF guard blocca apposta loopback/IP-privati per impedire che un URL
   * controllato dall'utente colpisca servizi interni. Per i NOSTRI servizi
   * interni l'URL non è user-controlled → SSRF è un falso positivo, ma breaker
   * + timeout restano (un servizio ML appeso NON deve drenare il pool).
   */
  allowPrivateHost?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Max redirect hop seguiti in modalità safe-follow (anti redirect-loop). */
const MAX_REDIRECT_HOPS = 5;
/**
 * Header sensibili da rimuovere su redirect CROSS-HOST (anti Bearer/cookie
 * leak, OWASP A07:2021). Identico al set di @medea/engine-safe-fetch.
 */
const CROSS_HOST_STRIP_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-csrf-token'];

/**
 * Equivalente di `HeadersInit` derivato dal costruttore globale `Headers`
 * (sempre disponibile: il codice fa già `new Headers(...)`). Il global type
 * `HeadersInit` NON è esposto in tutti i contesti @types/node/lib → rompeva
 * il build Docker pulito del runtime (`Cannot find name 'HeadersInit'`,
 * mascherato in locale dalla cache .tsbuildinfo). Derivandolo strutturalmente
 * dal costruttore evitiamo la dipendenza dall'identificatore globale.
 */
type HeadersInitCompat = NonNullable<ConstructorParameters<typeof Headers>[0]>;

function stripCrossHostHeaders(h: HeadersInitCompat | undefined): Headers {
  const out = new Headers(h ?? {});
  for (const name of CROSS_HOST_STRIP_HEADERS) out.delete(name);
  return out;
}

export async function safeOutboundFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  // SSRF guard PRIMA di toccare la rete — saltato SOLO per host interni trusted
  // (allowPrivateHost, URL hard-coded server-side, mai user-controlled).
  const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
  if (!opts.allowPrivateHost) {
    const safety = validateUrlForFetch(url);
    if (!safety.ok) {
      throw new NetworkError(
        `SSRF blocked: ${safety.reason ?? 'BLOCKED'} (${safety.detail ?? 'unsafe URL'})`,
        { url },
      );
    }
    // Il DNS-rebinding (host pubblico → IP privato) è bloccato a livello
    // connessione dal dispatcher sicuro (sotto), non da una pre-risoluzione.
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = (opts.method ?? 'GET').toUpperCase();
  const spanName = opts.spanName ?? `http.outbound.${hostOf(url)}`;

  // Redirect handling — il bug storico: `fetch` default `redirect:'follow'`
  // seguiva un 302 → IP privato/metadata BYPASSANDO il guard SSRF (che valida
  // solo l'URL iniziale). Tre modalità:
  //   • allowPrivateHost → URL hard-coded server-side trusted: segue nativo.
  //   • redirect 'manual'/'error' esplicito → il caller possiede gli hop (es.
  //     community-node sandbox che rifiuta ogni 3xx): passthrough invariato.
  //   • default (redirect non-impostato o 'follow') su URL non-trusted →
  //     SAFE FOLLOW: redirect manuale con SSRF re-validate ogni Location +
  //     strip credenziali su cross-host.
  const explicitRedirect = opts.redirect === 'manual' || opts.redirect === 'error';
  const safeFollow = !opts.allowPrivateHost && !explicitRedirect;

  // Layer 2 anti-SSRF: per URL non-trusted usa il dispatcher undici con lookup
  // hook connection-time (valida l'IP esatto della socket → zero TOCTOU, copre
  // ogni hop e ogni connessione del pool). I servizi interni trusted
  // (allowPrivateHost) restano sul dispatcher di default (devono raggiungere
  // 127.0.0.1 dei nostri servizi ML).
  const dispatcher: unknown = opts.allowPrivateHost
    ? getPermissiveDispatcher()
    : getSecureDispatcher();

  return withSpan(spanName, httpSpanAttrs(method, url), async () => {
    return executeWithHostBreaker(url, async () => {
      const ctrl = new AbortController();
      const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const signals: AbortSignal[] = [ctrl.signal];
      if (opts.externalSignal) signals.push(opts.externalSignal);
      // AbortSignal.any disponibile da Node 20.3+. Fallback manual su older.
      const combined = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
        ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals)
        : ctrl.signal;

      try {
        const baseInit: RequestInit = { ...opts, signal: combined };
        // Rimuovi i nostri custom field per non confondere fetch nativo.
        delete (baseInit as { timeoutMs?: unknown }).timeoutMs;
        delete (baseInit as { spanName?: unknown }).spanName;
        delete (baseInit as { externalSignal?: unknown }).externalSignal;
        delete (baseInit as { allowPrivateHost?: unknown }).allowPrivateHost;

        if (!safeFollow) {
          // Passthrough: host interno trusted o redirect gestito dal caller.
          // Dispatcher anti-SSRF applicato se !allowPrivateHost (redirect manual
          // su URL utente → comunque protetto a livello connessione).
          return await fetch(url, withDispatcher(baseInit, dispatcher));
        }

        // SAFE FOLLOW: loop manuale, re-validate SSRF su ogni Location.
        let currentUrl = url;
        let currentHeaders: HeadersInitCompat | undefined = baseInit.headers;
        const initialHost = hostOf(url);
        for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
          const hopInit: RequestInit = { ...baseInit, redirect: 'manual' };
          // Assegnazione condizionale: con exactOptionalPropertyTypes non si può
          // passare `headers: undefined` esplicito.
          if (currentHeaders !== undefined) hopInit.headers = currentHeaders;
          const res = await fetch(currentUrl, withDispatcher(hopInit, dispatcher));
          const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
          if (!isRedirect) return res;
          if (hop === MAX_REDIRECT_HOPS) {
            try {
              await res.body?.cancel();
            } catch {
              /* drain FD: cancel non bufferizza (arrayBuffer leggeva tutto → OOM su 3xx con body enorme) */
            }
            throw new NetworkError(`too many redirects (max ${String(MAX_REDIRECT_HOPS)})`, {
              url: currentUrl,
            });
          }
          const locationRaw = res.headers.get('location') ?? '';
          let nextUrl: string;
          try {
            nextUrl = new URL(locationRaw, currentUrl).toString();
          } catch {
            return res;
          } // Location malformata → restituiamo la 3xx verbatim
          const reval = validateUrlForFetch(nextUrl);
          if (!reval.ok) {
            try {
              await res.body?.cancel();
            } catch {
              /* drain FD: cancel non bufferizza (arrayBuffer leggeva tutto → OOM su 3xx con body enorme) */
            }
            throw new NetworkError(
              `SSRF blocked redirect: ${reval.reason ?? 'BLOCKED'} (${reval.detail ?? 'unsafe Location'})`,
              { url: nextUrl },
            );
          }
          // Il redirect verso un host pubblico che risolve a IP privato è
          // bloccato a livello connessione dal dispatcher sicuro (ogni hop usa
          // lo stesso dispatcher) → niente pre-risoluzione qui.
          // Cross-host? Strip credenziali dai successivi hop.
          if (hostOf(nextUrl) !== initialHost)
            currentHeaders = stripCrossHostHeaders(currentHeaders);
          try {
            await res.body?.cancel();
          } catch {
            /* drain FD: cancel non bufferizza (arrayBuffer leggeva tutto → OOM su 3xx con body enorme) */
          }
          currentUrl = nextUrl;
        }
        // Unreachable — il loop ritorna o throw prima.
        throw new NetworkError('redirect loop terminated unexpectedly', { url: currentUrl });
      } catch (err) {
        // NetworkError già tipizzato (SSRF redirect / too many redirects) → propaga.
        if (err instanceof NetworkError) throw err;
        // Classifica l'errore in NodeError discriminato.
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new TimeoutError({ url, timeoutMs, cause: err });
        }
        if (err instanceof Error) {
          throw new NetworkError(err.message, { url, cause: err });
        }
        throw new NetworkError(String(err), { url });
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  });
}

/**
 * Helper convenience: come safeOutboundFetch ma valida lo status code,
 * throwa HttpError tipizzato se !res.ok. Util per gli executor che vogliono
 * solo "fetch + throw on error" semantica.
 */
export async function safeOutboundFetchOk(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const res = await safeOutboundFetch(url, opts);
  if (!res.ok) {
    // Excerpt errore CAPPATO (readTextTruncated ferma lo stream a 8KB): un non-2xx
    // con body enorme con `res.text()` veniva bufferizzato TUTTO → OOM (poi scartato
    // a 500 char). Tronca durante il download, non dopo.
    let bodyExcerpt: string | undefined;
    try {
      bodyExcerpt = (await readTextTruncated(res, 8192)).text.slice(0, 500);
    } catch {
      /* drained twice — no-op */
    }
    throw new HttpError({
      status: res.status,
      statusText: res.statusText,
      url,
      ...(bodyExcerpt ? { bodyExcerpt } : {}),
    });
  }
  return res;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}
