/**
 * Build HTTP request body + Content-Type da un picker (json/form/multipart/raw).
 *
 * Estratto da http.ts. Per metodi senza body (GET/HEAD) ritorna shape vuota
 * — il caller controlla `body !== undefined` prima di assegnare a RequestInit.
 */

import { safeString, parseKvJson } from './safe-coerce.js';

export type BodyType =
  | 'none'
  | 'json'
  | 'form-urlencoded'
  | 'multipart'
  | 'raw-text'
  | 'raw-binary-base64'
  | 'binary';

export interface BodyConfig {
  bodyType?: string;
  body?: unknown;
  formFields?: unknown;
  rawBinaryContentType?: unknown;
}

export interface BuildBodyResult {
  body?: string | URLSearchParams | FormData | Buffer;
  contentType?: string;
}

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

export function buildBody(config: BodyConfig, method: string): BuildBodyResult {
  if (METHODS_WITHOUT_BODY.has(method.toUpperCase())) return {};

  const type = (typeof config.bodyType === 'string' ? config.bodyType : 'json') as BodyType;
  switch (type) {
    case 'none':
      return {};
    // REF-PRIMARIO upload: il body sono i byte di un handle BinaryData in INPUT.
    // buildBody è sync e senza input → l'executor risolve i byte e sovrascrive body
    // + contentType (dal mimeType dell'handle). Qui solo placeholder.
    case 'binary':
      return {};
    case 'json':
      return { body: safeString(config.body), contentType: 'application/json' };
    case 'raw-text':
      return { body: safeString(config.body), contentType: 'text/plain; charset=utf-8' };
    case 'raw-binary-base64': {
      const b64 = safeString(config.body);
      return {
        body: Buffer.from(b64, 'base64'),
        contentType: safeString(config.rawBinaryContentType) || 'application/octet-stream',
      };
    }
    case 'form-urlencoded': {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(parseKvJson(config.formFields))) params.append(k, v);
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'multipart': {
      const form = new FormData();
      for (const [k, v] of Object.entries(parseKvJson(config.formFields))) form.append(k, v);
      // fetch native imposta Content-Type con boundary corretto — lasciar passare undefined.
      return { body: form };
    }
    default:
      return {};
  }
}

/**
 * Apply query parameters da un kv-json string sopra l'URL gia\` esistente
 * (preserva eventuali ?x=y nell'URL).
 */
export function applyQueryParams(url: string, queryRaw: unknown): string {
  const params = parseKvJson(queryRaw);
  if (Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
  return u.toString();
}
