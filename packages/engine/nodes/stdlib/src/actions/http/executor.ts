/**
 * HTTP executor v3.0 — orchestration sopra utils + core middleware.
 *
 * Responsabilita\`:
 *   1. Parse config via Zod → tipato + defaulted.
 *   2. SSRF guard (assertUrlSafe + manual redirect + Link header re-validate).
 *   3. Auth + body + query builders (helpers shared).
 *   4. Single-page vs paginated flow (Strategy pattern).
 *   5. Retry interno per singola request (5xx + retryOnStatus configurabili).
 *
 * Middleware esterni (circuit breaker per-host, telemetry, error mapping)
 * sono applicati in `index.ts` via `httpMiddlewarePreset` — questo executor
 * resta puro orchestrator.
 */

import type { NodeExecutor } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { ValidationError, HttpError, parseRetryAfter } from '../../core/node-error.js';
import { buildAuthHeaders, buildBody, applyQueryParams, parseKvJson, parseCsvInts, withRetry, sleep,
  paginationWalker, PageNumberStrategy, OffsetLimitStrategy, CursorStrategy, LinkHeaderStrategy,
  type PaginationStrategy } from '../../utils/index.js';
import { HttpConfigSchema, type HttpConfig } from './schema.js';
import { acquireOAuth2Token } from './oauth2.js';
import { readResponse } from './response-reader.js';
import { buildRequestHeaders } from '../../core/http-headers.js';
// safe-fetch e\` server-only ma altri 25+ moduli stdlib lo importano statico —
// dynamic qui non code-splittava nulla (warning Vite "dynamic + static").
// Allineamento: static import in TUTTI gli executor (server-only by design).
import { assertUrlSafe, validateUrlForFetch, CROSS_HOST_STRIP_HEADERS } from '@medea/engine-safe-fetch';
import { nodeRetriesInternally } from '@medea/engine-core-schema';

const MAX_REDIRECTS = 5;

export const httpExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const startedAt = Date.now();

  // 1. Parse config (Zod, parse-once).
  const parsed = parseConfig(HttpConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  // 2. Egress policy per host (sicurezza). La decisione (allowlist + dispatcher) vive
  // nel RUNTIME (resolveOutboundDispatcher iniettato): un host nella allowlist interna
  // del tenant può scavalcare il SSRF guard + (se allowSelfSigned) usare il dispatcher
  // insecure-TLS. Host pubblici / privati non dichiarati → SSRF attivo + TLS verificato
  // (#201). Valutata PER-HOST (redirect inclusi) — un redirect verso pubblico NON eredita.
  function egressFor(url: string): { allowlisted: boolean; dispatcher?: unknown } {
    let host = '';
    try { host = new URL(url).hostname; } catch { return { allowlisted: false }; }
    return context.resolveOutboundDispatcher?.(host, cfg.allowSelfSigned === true) ?? { allowlisted: false };
  }

  // 3b. OAuth2 client_credentials: ottieni l'access-token PRIMA di costruire gli header.
  // Il fetch del token riusa lo STESSO egress guard (SSRF + dispatcher per-host + timeout)
  // della request principale → un token endpoint interno/self-signed è trattato come tale,
  // un endpoint pubblico resta SSRF-verificato. Il token è cachato (vedi oauth2.ts).
  let oauth2Bearer: string | undefined;
  if (cfg.authMode === 'oauth2') {
    oauth2Bearer = await acquireOAuth2Token({
      tokenUrl: cfg.oauth2TokenUrl ?? '',
      clientId: cfg.oauth2ClientId ?? '',
      clientSecret: cfg.oauth2ClientSecret ?? '',
      ...(cfg.oauth2Scope && cfg.oauth2Scope.trim() !== '' ? { scope: cfg.oauth2Scope } : {}),
      authStyle: cfg.oauth2AuthStyle, // schema default 'header' → sempre valorizzato
      fetchToken: async (url, init) => {
        const eg = egressFor(url);
        if (!eg.allowlisted) assertUrlSafe(url);
        const ctrl = new AbortController();
        const timer = setTimeout(() => { ctrl.abort(); }, cfg.timeoutMs);
        // R1: salva il riferimento e RIMUOVILO nel finally. {once:true} rimuove il
        // listener solo se l'abort scatta — al completamento normale resterebbe attaccato,
        // accumulandosi su un signal condiviso (paginazione/retry) → leak + MaxListeners.
        const onAbort = (): void => { ctrl.abort(); };
        context.abortSignal?.addEventListener('abort', onAbort, { once: true });
        try {
          const full = { ...init, signal: ctrl.signal, ...(eg.dispatcher !== undefined ? { dispatcher: eg.dispatcher } : {}) } as RequestInit & { dispatcher?: unknown };
          return await fetch(url, full);
        } finally {
          clearTimeout(timer);
          context.abortSignal?.removeEventListener('abort', onAbort);
        }
      },
    });
  }

  // 4. Build headers/body/init.
  const explicitHeaders = parseKvJson(cfg.headersJson);
  const authHeaders = buildAuthHeaders(cfg);
  // OAuth2: inietta il Bearer ottenuto (buildAuthHeaders ritorna {} per mode 'oauth2').
  if (oauth2Bearer !== undefined) authHeaders.Authorization = `Bearer ${oauth2Bearer}`;
  let { body, contentType } = buildBody(cfg, cfg.method);
  // REF-PRIMARIO upload: bodyType='binary' → il body sono i byte di un handle
  // BinaryData in INPUT (da file-read / http download / pdf / imap). Il content-type
  // viene dal mimeType dell'handle (override-abile da rawBinaryContentType).
  if (cfg.bodyType === 'binary') {
    const cs = await import('@medea/engine-core-schema');
    const bin = cs.getBinaryData(input);
    if (bin !== null) {
      body = await cs.readBinaryBytes(bin, context.readBinary);
      // mimeType dell'handle; un Content-Type esplicito in headersJson vince comunque
      // nel merge sottostante (explicitHeaders ha precedenza).
      contentType = bin.mimeType || 'application/octet-stream';
    }
  }
  // Merge header via builder condiviso (case-insensitive): explicit < auth,
  // Content-Type del body solo se assente. Vedi core/http-headers.ts.
  const headers = buildRequestHeaders({ base: explicitHeaders, auth: authHeaders, contentTypeDefault: contentType });

  const initialUrl = applyQueryParams(cfg.url, cfg.queryParamsJson);
  const initialEgress = egressFor(initialUrl);
  // allowSelfSigned è onorato SOLO verso host allowlisted; altrove resta IGNORATO (#201).
  if (cfg.allowSelfSigned && !initialEgress.allowlisted) {
    context.logger?.warn('[stdlib/http v3] allowSelfSigned=true IGNORATO: host non nella allowlist interna del tenant (TLS verificato, #201)', { node: 'action_http' });
  }
  // SSRF guard PRIMA della prima fetch — saltato SOLO per host interni allowlisted
  // (trust esplicito dell'operatore; il dispatcher permissivo/insecure raggiunge l'IP privato).
  if (!initialEgress.allowlisted) assertUrlSafe(initialUrl);

  const baseInit: RequestInit = {
    method: cfg.method,
    headers,
    redirect: 'manual', // SSRF #202 — gestiamo i redirect a mano, re-validate ogni hop.
  };
  if (body !== undefined && !['GET', 'HEAD'].includes(cfg.method)) {
    baseInit.body = body;
  }

  // UN SOLO livello di retry (review nodi): il nodo ritenta INTERNAMENTE solo se è lui
  // l'owner (retryStrategy=auto/node — default per un nodo self-managed). Se l'owner è
  // 'workflow' o 'none', il retry interno è disattivato (count 0) → niente doppione con
  // l'engine. Resolver condiviso (core-schema), stesso usato dall'engine.
  const internalRetryCount = nodeRetriesInternally(cfg.retryStrategy, true) ? cfg.retryCount : 0;
  // retryOnStatus conta SOLO se il retry interno è attivo: senza retry non ha senso
  // lanciare-per-ritentare (con 0 tentativi l'errore si propagherebbe invece di
  // restituire la response). Così il default '429,500,...' è inerte quando non si ritenta.
  const retryStatusSet = new Set(internalRetryCount > 0 && cfg.retryOnStatus ? parseCsvInts(cfg.retryOnStatus) : []);

  // ── Helper: single fetch con timeout + abort propagation. `headersOverride` permette
  // al redirect-loop di passare header DIVERSI da baseInit (strip cross-host, vedi H1).
  async function fetchOnce(url: string, headersOverride?: Headers): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); }, cfg.timeoutMs);
    // R1: rimuovi il listener nel finally. In un flusso PAGINATO (fino a paginationMaxPages)
    // o con RETRY, ogni pagina/tentativo chiama fetchOnce sullo STESSO context.abortSignal:
    // senza removeEventListener i listener si accumulano (mai rimossi al completamento
    // normale) → MaxListenersExceededWarning oltre 10 + memoria.
    const onAbort = (): void => { ctrl.abort(); };
    context.abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Dispatcher per-host: per un host interno allowlisted il runtime fornisce un
      // dispatcher permissivo (raggiunge l'IP privato) o insecure-TLS (se allowSelfSigned).
      // `dispatcher` è un'estensione undici NON nei tipi DOM di RequestInit → cast mirato.
      const { dispatcher } = egressFor(url);
      const init = { ...baseInit, signal: ctrl.signal, ...(headersOverride !== undefined ? { headers: headersOverride } : {}), ...(dispatcher !== undefined ? { dispatcher } : {}) } as RequestInit & { dispatcher?: unknown };
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  // ── Helper: fetch + manual SSRF-safe redirect loop.
  async function fetchWithSafeRedirects(url: string): Promise<Response> {
    let current = url;
    // H1 — strip cross-host delle credenziali: un redirect verso un host DIVERSO da quello
    // iniziale NON deve portarsi dietro Authorization/Cookie/… (furto del Bearer/API-key del
    // cliente verso un host attacker-controlled). `safeFetchWithRedirects` del package lo fa;
    // questo loop inline (necessario per il dispatcher per-host) lo replica con la STESSA
    // lista CROSS_HOST_STRIP_HEADERS (single source of truth, anti ri-divergenza).
    let initialHost: string;
    try { initialHost = new URL(url).host; } catch { initialHost = ''; }
    let hopHeaders = new Headers(headers); // copia mutabile (headers = baseInit.headers)
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await fetchOnce(current, hopHeaders);
      const is3xx = res.status >= 300 && res.status < 400 && res.headers.has('location');
      if (!cfg.followRedirects || !is3xx) return res;
      if (hop === MAX_REDIRECTS) return res;
      const loc = res.headers.get('location') ?? '';
      let next: string;
      try { next = new URL(loc, current).toString(); } catch { return res; }
      // Cross-host → rimuovi le credenziali dai prossimi hop (Headers.delete è case-insensitive).
      let nextHost: string;
      try { nextHost = new URL(next).host; } catch { nextHost = ''; }
      if (nextHost !== initialHost) {
        hopHeaders = new Headers(hopHeaders);
        for (const h of CROSS_HOST_STRIP_HEADERS) hopHeaders.delete(h);
      }
      // Re-valida SSRF ogni hop — SALTATO solo se il NUOVO host è allowlisted (un redirect
      // verso un host pubblico/non-dichiarato NON eredita il bypass: viene ri-validato).
      if (!egressFor(next).allowlisted) {
        const check = validateUrlForFetch(next);
        if (!check.ok) {
          throw new HttpError({
            status: 0,
            url: next,
            statusText: `redirect bloccato (${check.reason ?? 'BLOCKED'}): ${check.detail ?? 'unsafe URL'}`,
          });
        }
      }
      // Libera la connessione del redirect intermedio CANCELLANDO il body, non
      // leggendolo: `res.text()` bufferizzava l'intero body SENZA cap → un server
      // che risponde 3xx con un body enorme causava OOM aggirando readBodyWithCap
      // (che protegge solo la risposta finale). cancel() chiude lo stream a costo 0.
      try { await res.body?.cancel(); } catch { /* best-effort: connessione comunque rilasciata da undici */ }
      current = next;
    }
    throw new HttpError({ status: 0, url, statusText: 'too many redirects' });
  }

  // ── Helper: fetch + retry su 5xx / configured statuses.
  async function fetchPage(url: string): Promise<{ res: Response; body: unknown }> {
    return withRetry(async () => {
      const res = await fetchWithSafeRedirects(url);
      if (!res.ok && retryStatusSet.has(res.status)) {
        // Throw to trigger withRetry; the catch path uses NodeError.
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        throw new HttpError({ status: res.status, statusText: res.statusText, url, ...(retryAfterMs !== null ? { retryAfterMs } : {}) });
      }
      const parsedBody = cfg.statusCodeOnly ? null : await readResponse(res, cfg.responseFormat, context.writeBinary, cfg.maxResponseMb * 1024 * 1024);
      return { res, body: parsedBody };
    }, {
      count: internalRetryCount,
      initialDelayMs: cfg.retryInitialDelayMs,
      factor: cfg.retryBackoffFactor,
      maxDelayMs: 30_000,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      shouldRetry: (err) => {
        // Errori DETERMINISTICI (validazione config / risposta troppo grande):
        // ritentare non cambia l'esito → non-retriable.
        if (err instanceof ValidationError) return false;
        // Retry HTTP retryable + network errors. Per HttpError uso `retryable` flag.
        if (err instanceof HttpError) return retryStatusSet.has(err.status) || err.retryable;
        return true; // network/timeout: retry
      },
    });
  }

  // ── No pagination: singola chiamata.
  if (cfg.paginationMode === 'none') {
    const { res, body: parsedBody } = await fetchPage(initialUrl);
    if (!res.ok && cfg.throwOnError) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      throw new HttpError({ status: res.status, statusText: res.statusText, url: initialUrl, ...(retryAfterMs !== null ? { retryAfterMs } : {}) });
    }
    const headersOut: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) headersOut[k] = v;
    const output: Record<string, unknown> = { status: res.status, statusText: res.statusText, headers: headersOut };
    if (!cfg.statusCodeOnly) output.body = parsedBody;
    return { output, durationMs: Date.now() - startedAt };
  }

  // ── Paginated: Strategy + walker.
  const strategy = makeStrategy(cfg);
  const walker = await paginationWalker({
    strategy,
    ctx: { baseUrl: initialUrl, maxPages: cfg.paginationMaxPages, pageSize: cfg.paginationPageSize },
    ...(cfg.paginationItemsField ? { itemsField: cfg.paginationItemsField } : {}),
    fetchPage: async (url) => {
      const { res, body: parsedBody } = await fetchPage(url);
      const headersOut: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) headersOut[k] = v;
      return { body: parsedBody, headers: headersOut, status: res.status };
    },
    validateUrl: (url) => {
      const r = validateUrlForFetch(url);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'BLOCKED' };
    },
    ...(context.abortSignal ? { signal: context.abortSignal } : {}),
  });

  return {
    output: {
      status: walker.lastStatus,
      headers: walker.lastHeaders,
      pagesFetched: walker.pagesFetched,
      body: walker.items,
    },
    durationMs: Date.now() - startedAt,
  };
};

/** Factory: NodeDef config → PaginationStrategy concreta. */
function makeStrategy(cfg: HttpConfig): PaginationStrategy {
  switch (cfg.paginationMode) {
    case 'page-number':
      return new PageNumberStrategy({
        pageParam: cfg.paginationPageParam,
        limitParam: cfg.paginationLimitParam,
        startPage: cfg.paginationStartPage,
      });
    case 'offset-limit':
      return new OffsetLimitStrategy({
        offsetParam: cfg.paginationOffsetParam,
        limitParam: cfg.paginationLimitParam,
        startOffset: cfg.paginationStartOffset,
      });
    case 'cursor':
      return new CursorStrategy({
        cursorParam: cfg.paginationCursorParam,
        cursorResponseField: cfg.paginationCursorField,
      });
    case 'link-header':
      return new LinkHeaderStrategy();
    case 'none':
      // makeStrategy è chiamato SOLO per paginationMode != 'none' (l'executor gestisce
      // 'none' nel ramo single-fetch) → difensivo, non raggiunto a runtime.
      throw new ValidationError('makeStrategy: paginationMode "none" non ha strategia (gestito a parte)');
    default: {
      // R8: exhaustiveness check. Coperti tutti i valori dell'enum Zod → qui il tipo è
      // `never`. Se un domani si aggiunge un paginationMode senza il suo case, QUESTA
      // riga non compila → forza l'aggiornamento. Niente String()+eslint-disable.
      const _exhaustive: never = cfg.paginationMode;
      void _exhaustive;
      throw new ValidationError('paginationMode non gestito');
    }
  }
}

// Helper sleep esposto per i test (timeouts).
export { sleep };
