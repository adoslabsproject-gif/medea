/**
 * OpenAPI Connector executor — esegue UNA operation di una spec OpenAPI 3.0.
 *
 * Flusso: parsa la spec → trova l'operation per operationId → costruisce la
 * richiesta (path/query/header param) → fetch SSRF-safe → ritorna status+data.
 * Un solo nodo copre qualunque API REST con spec OpenAPI (Stripe, Slack, …).
 */
import type { NodeExecutor } from '../../types.js';
import {
  ValidationError,
  HttpError,
  NetworkError,
  parseRetryAfter,
} from '../../core/node-error.js';
import {
  parseOpenApiOperations,
  openApiBaseUrl,
  buildOpenApiRequest,
} from '../../lib/openapi/parser.js';
import { assertUrlSafe, validateUrlForFetch, readTextCapped } from '@medea/engine-safe-fetch';
import { buildRequestHeaders } from '../../core/http-headers.js';

/**
 * AUDIT FIX M1 (2026-06-09): redirect manuale + per-hop SSRF re-validate.
 *
 * Pre-fix: il fetch usava `redirect: 'follow'` (default Web Platform). Un
 * first-hop allowed (es. https://api.partner.com/x) che ritornava 302 a
 * http://169.254.169.254/latest/meta-data/ veniva seguito SILENZIOSAMENTE
 * dal runtime fetch → leak credenziali cloud metadata. Sister
 * http/executor.ts già usa `redirect: 'manual'` (SSRF #202 fix). Allineamento.
 */
const MAX_OPENAPI_REDIRECTS = 5;

function parseJsonObject(raw: string | undefined, field: string): Record<string, string> {
  if (!raw || raw.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ValidationError(`OpenAPI: ${field} non è JSON valido`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new ValidationError(`OpenAPI: ${field} deve essere un oggetto JSON`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>))
    out[k] = typeof val === 'string' ? val : JSON.stringify(val);
  return out;
}

export const openapiExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const cfg = rawConfig as Record<string, string>;
  const startedAt = Date.now();
  let spec: unknown;
  try {
    spec = JSON.parse(cfg.specJson ?? '');
  } catch {
    throw new ValidationError('OpenAPI: la spec non è JSON valido');
  }

  const ops = parseOpenApiOperations(spec);
  if (ops.length === 0) throw new ValidationError('OpenAPI: nessuna operation trovata nella spec');
  const operationId = (cfg.operationId ?? '').trim();
  const op = ops.find((o) => o.operationId === operationId);
  if (!op)
    throw new ValidationError(
      `OpenAPI: operation "${operationId}" non trovata (disponibili: ${ops
        .slice(0, 8)
        .map((o) => o.operationId)
        .join(', ')}…)`,
    );

  const baseUrl = (cfg.baseUrl || openApiBaseUrl(spec) || '').trim();
  if (!baseUrl)
    throw new ValidationError(
      'OpenAPI: Base URL mancante (né in config né in servers[] della spec)',
    );

  const params = parseJsonObject(cfg.paramsJson, 'paramsJson');
  const req = buildOpenApiRequest(op, baseUrl, params);
  const qs = new URLSearchParams(req.query).toString();
  const fullUrl = qs ? `${req.url}?${qs}` : req.url;
  assertUrlSafe(fullUrl); // sync: throw su URL non sicura (no await)

  const auth: Record<string, string> | undefined =
    cfg.authHeader && cfg.authValue ? { [cfg.authHeader]: cfg.authValue } : undefined;
  let body: string | undefined;
  let contentTypeDefault: string | undefined;
  if (op.hasBody && cfg.bodyJson && cfg.bodyJson.trim() !== '') {
    contentTypeDefault = 'application/json';
    body = cfg.bodyJson;
  }
  // Builder condiviso (core/http-headers.ts): merge CASE-INSENSITIVE → niente
  // Content-Type duplicato se lo spec usa 'content-type' minuscolo (fix vs il
  // vecchio headers['Content-Type'] ?? default).
  const headers = buildRequestHeaders({ base: req.headers, auth, contentTypeDefault });

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => {
      ctrl.abort();
    },
    Number(cfg.timeoutMs ?? 30000),
  );
  if (context.abortSignal)
    context.abortSignal.addEventListener(
      'abort',
      () => {
        ctrl.abort();
      },
      { once: true },
    );
  let res: Response;
  try {
    // M1: manual redirect loop, per-hop SSRF re-validate.
    // Pre-fix: redirect: 'follow' permetteva chain 302 a IP interni.
    let current = fullUrl;
    let hop = 0;
    for (;;) {
      const initBase = {
        method: req.method,
        headers,
        signal: ctrl.signal,
        redirect: 'manual' as const,
      };
      const finalInit = body !== undefined ? { ...initBase, body } : initBase;
      const hopRes = await fetch(current, finalInit);
      const is3xx = hopRes.status >= 300 && hopRes.status < 400 && hopRes.headers.has('location');
      if (!is3xx) {
        res = hopRes;
        break;
      }
      if (hop >= MAX_OPENAPI_REDIRECTS) {
        throw new HttpError({ status: 0, url: current, statusText: 'too many redirects' });
      }
      const loc = hopRes.headers.get('location') ?? '';
      let nextUrl: string;
      try {
        nextUrl = new URL(loc, current).toString();
      } catch {
        // Location header non parsabile → restituiamo la 3xx al caller
        res = hopRes;
        break;
      }
      const check = validateUrlForFetch(nextUrl);
      if (!check.ok) {
        throw new HttpError({
          status: 0,
          url: nextUrl,
          statusText: `redirect bloccato (${check.reason ?? 'BLOCKED'}): ${check.detail ?? 'unsafe URL'}`,
        });
      }
      try {
        await hopRes.body?.cancel();
      } catch {
        /* drain to free FD senza bufferizzare */
      }
      current = nextUrl;
      hop += 1;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new NetworkError('OpenAPI: richiesta fallita', {
      url: fullUrl,
      ...(e instanceof Error ? { cause: e } : {}),
    });
  } finally {
    clearTimeout(timer);
  }

  // anti-OOM: questo fetch è raw (loop redirect proprio) → non passa dal cap del
  // chokepoint safeFetch; cappiamo qui la lettura del body (una spec/endpoint
  // ostile potrebbe rispondere con un payload enorme).
  const text = await readTextCapped(res);
  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw new HttpError({
      status: res.status,
      statusText: res.statusText,
      url: fullUrl,
      bodyExcerpt: text,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    });
  }
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON → stringa grezza */
  }
  return {
    output: { status: res.status, operationId: op.operationId, data },
    durationMs: Date.now() - startedAt,
  };
};
