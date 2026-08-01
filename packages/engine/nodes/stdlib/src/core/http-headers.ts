/**
 * buildRequestHeaders — UNICA fonte per assemblare gli header di richiesta degli
 * executor HTTP-like (action_http, openapi, oauth2). Merge CASE-INSENSITIVE (spec
 * `Headers`): così NON si duplica il `Content-Type` quando una sorgente usa
 * `content-type` minuscolo e un'altra `Content-Type` (bug latente che `openapi`
 * aveva col vecchio `headers['Content-Type'] ?? default`).
 *
 * Precedenza (dal più debole al più forte):
 *   1. `base`            — header utente / dello spec (precedenza più bassa);
 *   2. `auth`            — header di autenticazione (vincono sui base);
 *   3. `contentTypeDefault` — applicato SOLO se nessun Content-Type è già presente.
 *
 * Ritorna un `Headers` (passabile direttamente a `fetch` come `init.headers`).
 * I test leggono via `.get(name)` (case-insensitive).
 *
 * @module core/http-headers
 */

import { ValidationError } from './node-error.js';

/**
 * NF2 — `Headers.set` lancia un `TypeError` GREZZO se il nome (o il valore) header è
 * malformato (es. l'utente scrive "X Bad Name" con spazi in headersJson). La dottrina
 * #7 vuole errori TIPIZZATI: wrappiamo in `ValidationError` con un messaggio azionabile,
 * mai un TypeError nudo che risale all'utente come "errore interno".
 */
function setHeaderSafe(headers: Headers, name: string, value: string): void {
  try {
    headers.set(name, value);
  } catch {
    throw new ValidationError(`Header non valido: "${name}" (nome o valore con caratteri non ammessi dallo standard HTTP).`);
  }
}

export interface BuildRequestHeadersOptions {
  /** Header base (es. headersJson utente, req.headers dello spec). Più bassa precedenza. */
  base?: Record<string, string> | undefined;
  /** Header di auth (Authorization, X-Api-Key, ...). Vincono sui base. */
  auth?: Record<string, string> | undefined;
  /** Content-Type applicato SOLO se assente (case-insensitive). */
  contentTypeDefault?: string | undefined;
}

export function buildRequestHeaders(opts: BuildRequestHeadersOptions): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.base ?? {})) setHeaderSafe(headers, k, v);
  for (const [k, v] of Object.entries(opts.auth ?? {})) setHeaderSafe(headers, k, v);
  if (opts.contentTypeDefault && !headers.has('Content-Type')) {
    setHeaderSafe(headers, 'Content-Type', opts.contentTypeDefault);
  }
  return headers;
}
