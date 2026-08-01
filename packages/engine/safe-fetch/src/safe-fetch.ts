/**
 * `safeFetchWithRedirects` — fetch shim per input utente o LLM-controllato.
 *
 * Combina:
 *   • SSRF guard pre-fetch (`assertUrlSafe`)
 *   • Redirect manuali con SSRF re-validate per ogni hop
 *   • Strip cross-host di `Authorization` / `Cookie` / `Proxy-Authorization`
 *     (anti-Bearer-leak, OWASP A07:2021)
 *   • Timeout via `AbortSignal.timeout` (default 30s)
 *   • Max redirect hop cap (default 5)
 *
 * Usato da:
 *   • `@flowforge/nodes-stdlib` HTTP action (lì il loop è inline, mantenuto
 *     per backwards-compat con retry + pagination context)
 *   • `@flowforge/nodes-ai-agents` http_request tool (N20 audit 2026-05-29)
 *   • Future nodes che fanno fetch su URL utente/LLM-controllati
 *
 * Note semantics:
 *   • Solo le response 3xx con `Location` triggerano hop. 3xx senza Location
 *     viene restituita verbatim (caller decide cosa farne).
 *   • La response finale viene RESTITUITA come `Response`. Caller fa `.text()`,
 *     `.json()`, ecc — non drainiamo il body internamente.
 *   • Errori SSRF/timeout/redirect-loop sono Error con messaggio human-readable.
 *
 * Limiti:
 *   • DNS rebind: la `lookup` hook di undici è il punto vero. Qui blocchiamo
 *     solo la URL parsata + ogni redirect Location.
 *   • Body retry: l'helper NON è retry-aware. Per retry + backoff usare
 *     `@flowforge/nodes-stdlib` HTTP action che incapsula entrambi.
 */

import { assertUrlSafe, validateUrlForFetch } from './ssrf-guard.js';
import { DEFAULT_RESPONSE_CAP_BYTES, readTextCapped, readJsonCapped, readBytesCapped } from './capped-response.js';

export interface SafeFetchOptions {
  method?: string;
  /** Headers mutati internamente per strip cross-host (caller non li riusa). */
  headers?: Record<string, string>;
  /**
   * Body forwardato al fetch. Tipo identico a `RequestInit['body']`
   * (string | URLSearchParams | FormData | Blob | BufferSource | ReadableStream | null).
   * Evitiamo `BodyInit` perché richiede lib DOM, non disponibile in
   * lib: ["ES2022"] (la configurazione del workspace).
   */
  body?: RequestInit['body'];
  /** Max redirect hops (default 5). 0 = nessun follow. */
  maxRedirects?: number;
  /** Timeout per singolo hop (default 30_000 ms). */
  timeoutMs?: number;
  /** Forwarded a `validateUrlForFetch` — solo per service-to-service interni. */
  allowDockerNet?: boolean;
  /**
   * Host:porta ESATTI fidati, esenti dal guard (es. il gateway LLM interno di sistema).
   * Match esatto su `url.host` — NON apre la rete privata. Lo passano SOLO i call-site
   * interni di sistema (mai input utente). Si applica anche ai redirect (un hop verso un
   * host NON in lista resta bloccato).
   */
  allowedHosts?: readonly string[];
  /**
   * Tetto in byte per la lettura del body via `.json()/.text()/.arrayBuffer()/.blob()`
   * della Response ritornata (default 25 MB). Anti-OOM STRUTTURALE: non serve che i
   * consumer ricordino di cappare — il body-read è cappato per costruzione (vedi
   * `withCappedBody`). I download legittimamente grandi (es. asset binari) passano
   * un valore più alto e dedicato. Lo streaming raw via `res.body` NON è toccato
   * (chi lo usa, es. il nodo http, applica già il proprio cap sullo stream).
   */
  maxResponseBytes?: number;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Avvolge una `Response` perché `.json()/.text()/.arrayBuffer()/.blob()` siano
 * CAPPATI a `capBytes` (streaming, RangeError oltre il limite) — senza che il
 * chiamante debba fare nulla. È il cuore dell'anti-OOM strutturale: `safeFetch`
 * è l'unico punto da cui passa ogni fetch esterno, quindi cappare QUI rende
 * impossibile leggere un body non limitato in TUTTO il codebase (executor, nodi,
 * integrazioni, codice futuro). Tutto il resto (ok/status/headers/url/body/clone)
 * è delegato alla Response reale.
 */
function withCappedBody(res: Response, capBytes: number): Response {
  return new Proxy(res, {
    get(target, prop) {
      switch (prop) {
        case 'text': return () => readTextCapped(target, capBytes);
        case 'json': return () => readJsonCapped(target, capBytes);
        case 'arrayBuffer': return async () => {
          const buf = await readBytesCapped(target, capBytes);
          // copia esatta in un ArrayBuffer (evita di esporre il pool di Buffer)
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        };
        case 'blob': return async () => new Blob([await readBytesCapped(target, capBytes)]);
        // clone propaga il cap così anche la copia resta protetta
        case 'clone': return () => withCappedBody(target.clone(), capBytes);
        default: {
          // receiver = target (NON il proxy): i getter di Response (body/status/
          // headers/url…) leggono slot interni e con this=proxy darebbero
          // "Illegal invocation". I metodi delegati vanno bindati a target.
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
      }
    },
  });
}

/**
 * Headers da rimuovere su cross-host redirect (case-insensitive — i fetch
 * runtime normalizzano tutto a lower-case, ma facciamo entrambi per safety).
 *
 * Pattern: il browser fa lo stesso strip su redirect cross-origin per
 * `Authorization` (RFC 7231 §6.4) + `Cookie` (SameSite=Strict implicito).
 */
/**
 * Header sensibili da rimuovere su redirect CROSS-HOST. ESPORTATO come single source
 * of truth: l'http executor (actions/http/executor.ts) reimplementa il proprio loop di
 * redirect (gli serve il dispatcher per-host per gli host interni allowlisted) e DEVE
 * usare QUESTA stessa lista, altrimenti il "codice cugino" diverge e riapre il leak
 * (è esattamente il bug H1: il loop inline aveva perso lo strip). Lower-case: i fetch
 * runtime normalizzano gli header; `Headers.delete` è comunque case-insensitive.
 */
export const CROSS_HOST_STRIP_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-csrf-token',
] as const;

/** Set lower-case per il lookup O(1) senza cast (CROSS_HOST_STRIP_HEADERS è `as const`). */
const CROSS_HOST_STRIP_SET = new Set<string>(CROSS_HOST_STRIP_HEADERS);

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CROSS_HOST_STRIP_SET.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Fetch con SSRF guard + manual redirect + auth strip cross-host.
 *
 * Esempio:
 *   const res = await safeFetchWithRedirects('https://example.com/api', {
 *     method: 'POST',
 *     headers: { 'Authorization': 'Bearer xyz', 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ x: 1 }),
 *   });
 *   const json = await res.json();
 */
export async function safeFetchWithRedirects(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowDockerNet = opts.allowDockerNet ?? false;
  const allowedHosts = opts.allowedHosts;
  const capBytes = opts.maxResponseBytes ?? DEFAULT_RESPONSE_CAP_BYTES;
  const guardOpts = { allowDockerNet, ...(allowedHosts ? { allowedHosts } : {}) };

  // Pre-flight: throw se URL iniziale non sicura.
  assertUrlSafe(rawUrl, guardOpts);

  let currentUrl = rawUrl;
  let currentHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  const initialHost = new URL(rawUrl).host;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: currentHeaders,
      // FORCE manual redirect — il loop sotto gestisce hop con SSRF re-validate.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (opts.body !== undefined) init.body = opts.body;

    const res = await fetch(currentUrl, init);
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
    if (!isRedirect) return withCappedBody(res, capBytes);

    if (hop === maxRedirects) {
      // Drain body per evitare leak FD prima del throw.
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      throw new Error(`safeFetch: too many redirects (max ${String(maxRedirects)})`);
    }

    const locationRaw = res.headers.get('location') ?? '';
    let nextUrl: string;
    try {
      nextUrl = new URL(locationRaw, currentUrl).toString();
    } catch {
      // Location malformata → restituiamo la 3xx senza follow.
      return withCappedBody(res, capBytes);
    }

    // SSRF re-validate sull'hop successivo (stessa esenzione host fidati del pre-flight:
    // un redirect verso un host NON in allowedHosts resta comunque bloccato).
    const r = validateUrlForFetch(nextUrl, guardOpts);
    if (!r.ok) {
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      throw new Error(`safeFetch: redirect bloccato (${r.reason ?? 'BLOCKED'}): ${r.detail ?? 'unsafe URL'}`);
    }

    // Cross-host? Strip credenziali dai successivi hop.
    const nextHost = new URL(nextUrl).host;
    if (nextHost !== initialHost) {
      currentHeaders = stripSensitiveHeaders(currentHeaders);
    }

    // Drain body precedente per evitare leak FD.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    currentUrl = nextUrl;
  }

  // Unreachable — il loop ritorna o throw prima di uscire.
  throw new Error('safeFetch: redirect loop terminated unexpectedly');
}
