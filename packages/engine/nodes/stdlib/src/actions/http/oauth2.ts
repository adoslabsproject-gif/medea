/**
 * OAuth2 client_credentials grant per action_http (auth machine-to-machine).
 *
 * Il nodo HTTP ottiene un access-token dal token endpoint e lo inietta come
 * `Authorization: Bearer <token>` sulla request reale. Il token è CACHATO in-process
 * fino a (expires_in − margine) per non chiamare il token endpoint a ogni request
 * (pattern enterprise: un token vale minuti/ore, ri-emetterlo a ogni hit è spreco +
 * rate-limit del provider).
 *
 * SICUREZZA:
 *  - Il `fetchToken` è INIETTATO dall'executor → la chiamata al token endpoint passa
 *    per lo STESSO guard SSRF + dispatcher per-host della request principale (un token
 *    endpoint interno/self-signed è gestito come gli altri host allowlisted). Questo
 *    modulo NON apre socket da sé.
 *  - Nessun log di clientSecret/access_token. L'errore riporta solo status + body del
 *    token endpoint (mai l'header Authorization).
 *
 * Modulo PURO (fetch + clock iniettabili) → testabile senza rete. Le letture del body
 * sono cappate inline (anti-OOM, R5) senza dipendere da @flowforge/safe-fetch, così la
 * purezza resta. La risposta è validata con Zod (boundary esterno, R9), la cache fa
 * eviction LRU reale (R2) e la chiave NON contiene il secret in chiaro (hash, R4).
 */

import { z } from 'zod';
import { buildRequestHeaders } from '../../core/http-headers.js';

/** Esegue la POST al token endpoint applicando SSRF/dispatcher/timeout (fornita dall'executor). */
export type TokenFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface OAuth2Params {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** scope opzionale (space-delimited). */
  scope?: string;
  /** 'header' = HTTP Basic sul token endpoint (default, RFC 6749 §2.3.1); 'body' = creds nel form. */
  authStyle: 'header' | 'body';
  fetchToken: TokenFetcher;
  /** clock iniettabile per i test. */
  now?: () => number;
}

interface CacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

/** Margine di refresh: rinnova il token 30s PRIMA della scadenza (clock skew + latenza). */
const REFRESH_MARGIN_MS = 30_000;
/** Default conservativo se il token endpoint NON ritorna expires_in (RFC: campo opzionale). */
const DEFAULT_EXPIRES_IN_S = 3600;
/** Cap HARD della cache: un cap reale (eviction LRU), non un semplice trigger di GC. */
const MAX_CACHE_ENTRIES = 200;
/** Cap risposta token endpoint (R5): 1 MB è enorme per un { access_token, expires_in }. */
const TOKEN_RESPONSE_CAP = 1024 * 1024;

const tokenCache = new Map<string, CacheEntry>();

/**
 * NF1 — coalescing delle richieste IN VOLO: N chiamate concorrenti con le STESSE
 * credenziali (stessa key) condividono UNA sola Promise verso il token endpoint, invece
 * di colpirlo N volte (proprio il rate-limit che la cache vuole evitare, ma che la cache
 * NON copre nella finestra in cui il primo token non è ancora arrivato). La entry si
 * rimuove al completamento (finally) → la prossima ondata, post-cache, fa cache-hit.
 */
const inFlight = new Map<string, Promise<string>>();

/**
 * Chiave cache (R4): SHA-256 della tuple di identità delle credenziali. Il clientSecret
 * NON sosta più in chiaro come chiave nella Map per tutta la vita del processo — solo il
 * suo digest. Un secret ruotato → tuple diversa → hash diverso → token nuovo (invariato).
 *
 * async + lazy import di node:crypto: in stdlib l'import statico di node:* è vietato
 * (romperebbe il bundle Vite dell'editor) → caricato dynamic solo a runtime server.
 */
export async function cacheKey(p: OAuth2Params): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update([p.tokenUrl, p.clientId, p.clientSecret, p.scope ?? '', p.authStyle].join('\n'))
    .digest('hex');
}

/**
 * Eviction REALE (R2): prima rimuove le scadute; se ancora oltre il cap HARD, droppa le
 * più vecchie (la Map mantiene insertion-order → la prima chiave è la meno-recente).
 * Garantisce size ≤ MAX anche con 200+ credenziali TUTTE valide (rotation/multi-host).
 */
function evictForRoom(now: number): void {
  if (tokenCache.size < MAX_CACHE_ENTRIES) return;
  for (const [k, v] of tokenCache) {
    if (v.expiresAtMs <= now) tokenCache.delete(k);
  }
  while (tokenCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
}

/**
 * Legge il body con un cap di byte SENZA dipendere da safe-fetch (modulo PURO). Streaming
 * con contatore quando il body è leggibile; fallback per Response-mock senza stream.
 */
async function readCappedText(res: Response, capBytes: number): Promise<string> {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) {
        total += value.byteLength;
        if (total > capBytes) {
          try { await reader.cancel(); } catch { /* best-effort: connessione rilasciata comunque */ }
          throw new Error(`OAuth2 token endpoint: risposta troppo grande (oltre ${capBytes.toString()} byte)`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf-8') > capBytes) {
    throw new Error(`OAuth2 token endpoint: risposta troppo grande (oltre ${capBytes.toString()} byte)`);
  }
  return text;
}

/**
 * Schema della risposta del token endpoint (R9: boundary esterno → Zod, non a mano).
 * `access_token` è HARD (manca/vuoto → fail). `expires_in` è best-effort: coerce + .catch
 * → un valore mancante/negativo/non-numerico diventa undefined → poi DEFAULT_EXPIRES_IN_S,
 * SENZA invalidare l'intera risposta (un access_token valido non va perso per un expires_in
 * sporco). `.passthrough()` tollera i campi extra (token_type, scope, …).
 */
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive().optional().catch(undefined),
}).passthrough();

/**
 * Ritorna un access-token valido (dalla cache o richiedendolo). Lancia con messaggio
 * chiaro se il token endpoint risponde non-2xx o senza `access_token`.
 */
export async function acquireOAuth2Token(p: OAuth2Params): Promise<string> {
  const now = p.now ?? Date.now;
  const tNow = now();
  const key = await cacheKey(p);

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs > tNow + REFRESH_MARGIN_MS) {
    // LRU recency (R2): re-inserisci in coda così le chiavi più USATE non vengono
    // droppate per prime quando si supera il cap. delete+set sposta la entry in fondo.
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached.accessToken;
  }

  // NF1 — coalescing: se una richiesta per questa key è GIÀ in volo, riusala (niente
  // get+set con await in mezzo → atomico nel single-thread di Node).
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fetchAndCacheToken(p, key, tNow);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Esegue la richiesta al token endpoint, valida e popola la cache. Estratta da
 *  acquireOAuth2Token per il coalescing (NF1): è il corpo "non condiviso". */
async function fetchAndCacheToken(p: OAuth2Params, key: string, tNow: number): Promise<string> {
  const form = new URLSearchParams();
  form.set('grant_type', 'client_credentials');
  if (p.scope && p.scope.trim() !== '') form.set('scope', p.scope.trim());

  let authHeader: Record<string, string> | undefined;
  if (p.authStyle === 'header') {
    const basic = Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64');
    authHeader = { Authorization: `Basic ${basic}` };
  } else {
    form.set('client_id', p.clientId);
    form.set('client_secret', p.clientSecret);
  }
  // Builder condiviso (core/http-headers.ts) — UNA convenzione per tutti gli HTTP-like.
  const headers = buildRequestHeaders({
    base: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    auth: authHeader,
  });

  const res = await p.fetchToken(p.tokenUrl, {
    method: 'POST',
    headers,
    body: form.toString(),
    redirect: 'manual',
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await readCappedText(res, TOKEN_RESPONSE_CAP)).slice(0, 300); } catch { /* best-effort */ }
    throw new Error(`OAuth2 token endpoint ${res.status.toString()} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(await readCappedText(res, TOKEN_RESPONSE_CAP));
  } catch (err) {
    // Distingui "troppo grande" (cap) da "non-JSON": il primo è un messaggio già chiaro.
    if (err instanceof Error && err.message.includes('troppo grande')) throw err;
    throw new Error('OAuth2 token endpoint: risposta non-JSON (atteso { access_token, expires_in })');
  }

  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('OAuth2 token endpoint: nessun access_token nella risposta');
  }
  const accessToken = parsed.data.access_token;
  const expiresInS = parsed.data.expires_in ?? DEFAULT_EXPIRES_IN_S;

  evictForRoom(tNow);
  tokenCache.set(key, { accessToken, expiresAtMs: tNow + expiresInS * 1000 });
  return accessToken;
}

/** Svuota la cache token + le richieste in volo (per i test e per invalidazione esplicita). */
export function clearOAuth2TokenCache(): void {
  tokenCache.clear();
  inFlight.clear();
}
