/**
 * action_webhook_respond executor — produces a structured response payload
 * that the webhook HTTP handler consumes after the pipeline finishes.
 *
 * Supports 7 respondWith modes:
 *   json     — serialize body as JSON (default)
 *   text     — plain text body
 *   html     — HTML body
 *   redirect — 302 + Location header (no body)
 *   binary   — base64-decoded bytes (PDFs, images, archives) + optional download
 *   empty    — 204 No Content, no body
 *   custom   — manual contentType + body for advanced cases
 *
 * The executor itself doesn't write to the response stream (no handle to the
 * underlying Hono Context). It returns an output object with the sentinel
 * `__webhookResponse` key which `routes/webhooks.ts` picks up after the run.
 */

import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { resolveBinaryValue } from '@medea/engine-core-schema';

/**
 * Reserved key the webhook HTTP handler looks for. Documented here AND in
 * routes/webhooks.ts — keep in sync if renamed.
 */
export const WEBHOOK_RESPONSE_KEY = '__webhookResponse';

/**
 * Payload the HTTP handler consumes. `bodyIsBase64` tells the handler to
 * Buffer.from(body, 'base64') before writing it to the wire — needed for
 * binary file responses since the engine serializes step output as JSON.
 */
export interface WebhookResponsePayload {
  status: number;
  contentType: string;
  body: string;
  bodyIsBase64?: boolean;
  headers: Record<string, string>;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * SECURITY (CWE-113 HTTP response splitting): rimuove CR/LF/NUL da un valore
 * header. I valori header in questo nodo sono CONFIG dell'autore (headersJson,
 * cors, location, filename) e finiscono nella response HTTP verso il chiamante
 * esterno → senza strip, `"a\r\nSet-Cookie: evil"` inietterebbe header arbitrari.
 */
function sanitizeHeaderValue(v: string): string {
  return v.replace(/[\r\n\0]/g, '');
}

/**
 * Valida la destinazione di un redirect 302. Ammette SOLO:
 *  - path relativo same-origin che inizia con "/" (NON "//host" = protocol-relative,
 *    che porterebbe su un host esterno);
 *  - URL assoluto http(s).
 * Rifiuta `javascript:`/`data:`/`vbscript:` (XSS-on-redirect in alcuni browser) e
 * ogni schema non-http. Il nodo gira su un dominio TENANT fidato
 * (`<slug>.app.automazionezeli.com`): senza guard, un redirectLocation templato da
 * input di richiesta lo trasformerebbe in open-redirect per phishing sul dominio fidato.
 * Ritorna la location sicura (già CRLF-sanitizzata) o `null` se non valida.
 */
function safeRedirectLocation(raw: string): string | null {
  const v = sanitizeHeaderValue(raw.trim());
  if (!v) return null;
  // path relativo same-origin (ma non protocol-relative "//")
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  // URL assoluto: solo http/https
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/** Nome header valido = token RFC 7230 (no spazi/CRLF/separatori). Altri → scartati. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function parseHeadersJson(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Nome non-token (contiene CRLF/spazi/`:`) → header malevolo, scartato.
      if (!HEADER_NAME_RE.test(k)) continue;
      if (typeof v === 'string') out[k] = sanitizeHeaderValue(v);
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Parse the statusPreset config value. The select options are formatted
 * "<code> <reason>" (e.g. "200 OK", "404 Not Found"). We extract the leading
 * integer. The "Custom" option returns null so the caller uses the explicit
 * `status` field.
 */
function parseStatusPreset(preset: unknown): number | null {
  if (typeof preset !== 'string') return null;
  if (preset.startsWith('Custom')) return null;
  const match = /^(\d{3})\s/u.exec(preset);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) && code >= 100 && code <= 599 ? code : null;
}

function clampStatus(raw: unknown, fallback = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100 || n > 599) return fallback;
  return Math.floor(n);
}

/**
 * Resolve the final HTTP status. Priority:
 *   1. statusPreset (when not "Custom")
 *   2. explicit status field (used when statusPreset is "Custom" or absent)
 *   3. mode-specific default (302 for redirect, 204 for empty, 200 otherwise)
 */
function resolveStatus(config: Record<string, unknown>, mode: string): number {
  const preset = parseStatusPreset(config.statusPreset);
  if (preset !== null) return preset;
  if (config.status !== undefined && config.status !== '' && config.status !== null) {
    return clampStatus(config.status);
  }
  if (mode === 'redirect') return 302;
  if (mode === 'empty') return 204;
  return 200;
}

export const webhookRespondExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();

  const mode = asString(config.respondWith) || 'json';
  const status = resolveStatus(config, mode);
  const extraHeaders = parseHeadersJson(config.headersJson);
  const cors = asString(config.corsOrigin).trim();

  let contentType = 'application/json';
  let body = '';
  let bodyIsBase64 = false;
  const headers: Record<string, string> = { ...extraHeaders };
  if (cors) headers['Access-Control-Allow-Origin'] = sanitizeHeaderValue(cors);

  switch (mode) {
    case 'text': {
      contentType = 'text/plain; charset=utf-8';
      const explicit = asString(config.body);
      body = explicit !== '' ? explicit : (typeof input === 'string' ? input : JSON.stringify(input ?? ''));
      break;
    }
    case 'html': {
      contentType = 'text/html; charset=utf-8';
      const explicit = asString(config.body);
      body = explicit !== '' ? explicit : (typeof input === 'string' ? input : '');
      break;
    }
    case 'redirect': {
      contentType = 'text/plain; charset=utf-8';
      // Solo http(s) assoluto o path relativo same-origin: niente javascript:/data:
      // né open-redirect su host esterno (vedi safeRedirectLocation).
      const rawLoc = asString(config.redirectLocation).trim();
      const location = safeRedirectLocation(rawLoc);
      if (rawLoc && !location) {
        throw new Error(`action_webhook_respond: redirectLocation non valido "${rawLoc}" — ammessi solo URL http(s) o path relativo "/...".`);
      }
      if (location) headers.Location = location;
      body = ''; // browsers ignore body on 3xx
      break;
    }
    case 'binary': {
      contentType = asString(config.binaryContentType) || 'application/octet-stream';
      // REF-PRIMARIO: se in input arriva un handle BinaryData (da http download /
      // pdf / file-read / imap) lo risolviamo ai byte → base64 per il wire. Altrimenti
      // config.binaryData (base64 esplicito) o input string (fail-soft). L'handler
      // HTTP fa Buffer.from(body, 'base64') prima di scrivere sul wire.
      const binBytes = await resolveBinaryValue(input, context.readBinary);
      body = binBytes !== null
        ? binBytes.toString('base64')
        : (asString(config.binaryData) || (typeof input === 'string' ? input : ''));
      bodyIsBase64 = true;
      const filename = asString(config.binaryFilename).trim();
      if (filename) {
        // Quote-safe + CRLF-safe filename (no double quotes né header injection).
        const safe = sanitizeHeaderValue(filename.replace(/"/gu, ''));
        headers['Content-Disposition'] = `attachment; filename="${safe}"`;
      }
      break;
    }
    case 'empty': {
      contentType = 'application/octet-stream'; // ignored when body is empty
      body = '';
      break;
    }
    case 'custom': {
      contentType = asString(config.contentType) || 'application/json';
      body = asString(config.customBody);
      // For custom mode we don't auto-fill from upstream input — if the
      // operator chose custom, they want explicit control. Empty stays empty.
      break;
    }
    case 'json':
    default: {
      contentType = 'application/json';
      const explicit = asString(config.body);
      if (explicit !== '') {
        body = explicit;
      } else {
        body = JSON.stringify(input ?? null);
      }
      break;
    }
  }

  const payload: WebhookResponsePayload = {
    status,
    contentType,
    body,
    bodyIsBase64,
    headers,
  };

  return {
    output: {
      [WEBHOOK_RESPONSE_KEY]: payload,
      status,
      contentType,
      respondWith: mode,
    },
    durationMs: Date.now() - start,
  };
};
