/**
 * Shared helpers per i 6 executor SaaS batch (Sheets/Discord/Airtable/Trello/
 * Calendly/Typeform). Estratti da saas-batch.ts per rispettare cap 250 righe.
 */
import { coerceString } from '@/lib/coerce.js';
import { IntegrationError } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { assertHostAllowed, HostNotAllowedError } from '@/lib/host-allowlist.js';

export interface SaasFetchOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  asForm?: boolean;
  /**
   * Allowlist di suffissi host (anti-esfiltrazione): OBBLIGATORIA quando `url` deriva da
   * config del tenant E si spedisce un `token`. Se l'host non matcha → throw PRIMA di
   * inviare la credenziale. Vedi {@link assertHostAllowed}.
   */
  allowHosts?: readonly string[];
}

/** Cap anti-OOM sulla risposta dei connettori SaaS (25 MB): una list API che torna
 *  decine di migliaia di record leggeva senza limite via res.text() → OOM. Vale per
 *  TUTTI i connettori che passano da jsonFetch (fix 2026-06-17). */
const SAAS_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const SAAS_MAX_MB_LABEL = (SAAS_MAX_RESPONSE_BYTES / 1048576).toString();

/**
 * Legge il body come testo con CAP: content-length oltre il limite → stop SUBITO
 * (nessun byte letto); in prod (Response reale con body stream) legge in streaming
 * col contatore e si ferma al cap; fallback a res.text()+post-check per Response
 * senza stream (mock/test). Non bufferizza mai più del cap.
 */
async function readTextCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > SAAS_MAX_RESPONSE_BYTES) {
    try { await res.body?.cancel(); } catch { /* best-effort */ }
    throw new Error(`risposta troppo grande: ${(declared / 1048576).toFixed(1)} MB oltre il limite di ${SAAS_MAX_MB_LABEL} MB`);
  }
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    // `getReader()` non porta con sé il tipo dei blocchi letti: senza
    // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > SAAS_MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new Error(`risposta troppo grande: superato il limite di ${SAAS_MAX_MB_LABEL} MB durante il download`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
  const text = await res.text();
  if (text.length > SAAS_MAX_RESPONSE_BYTES) {
    throw new Error(`risposta troppo grande: oltre il limite di ${SAAS_MAX_MB_LABEL} MB`);
  }
  return text;
}

/**
 * Legge SOLO un estratto (default 8 KB) del body per un messaggio d'errore, poi
 * cancella lo stream. Il body di una risposta non-2xx può essere enorme (es. una
 * pagina HTML d'errore, uno stack server) e ne serve solo un frammento: leggerlo
 * tutto con res.text() era un OOM (fix 2026-06-18, parallelo al cap del successo).
 * Non bufferizza mai più di maxBytes.
 */
async function readErrorSnippet(res: Response, maxBytes = 8192): Promise<string> {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    // `getReader()` non porta con sé il tipo dei blocchi letti: senza
    // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(Buffer.from(value));
          total += value.byteLength;
          if (total >= maxBytes) break;
        }
      }
    } catch { /* best-effort: torna ciò che si è letto */ }
    finally { try { await reader.cancel(); } catch { /* stream già chiuso */ } }
    return Buffer.concat(chunks).toString('utf-8').slice(0, maxBytes);
  }
  try { return (await res.text()).slice(0, maxBytes); } catch { return ''; }
}

export async function jsonFetch<T>(
  provider: string, url: string, token: string | null, opts: SaasFetchOpts = {},
): Promise<T> {
  // ANTI-ESFILTRAZIONE (finding sistemico): se l'host può derivare da config del tenant,
  // il chiamante passa `allowHosts` → validiamo PRIMA di attaccare qualsiasi credenziale.
  // Senza questo, un URL come `https://attacker.com/x` riceverebbe il token in chiaro.
  if (opts.allowHosts) {
    try {
      assertHostAllowed(url, opts.allowHosts);
    } catch (e) {
      if (e instanceof HostNotAllowedError) {
        throw new IntegrationError({ provider: provider as never, code: 'HOST_NOT_ALLOWED', message: e.message });
      }
      throw e;
    }
  }
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  if (!headers['Content-Type'] && opts.body !== undefined) {
    headers['Content-Type'] = opts.asForm ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  };
  if (opts.body !== undefined) {
    init.body = opts.asForm ? coerceString(opts.body) : JSON.stringify(opts.body);
  }
  const res = await safeOutboundFetch(url, init);
  if (res.status === 204) return {} as T;
  if (!res.ok) {
    let errMsg = `${provider} HTTP ${String(res.status)} ${res.statusText}`;
    // Body d'errore letto CAPPATO (anti-OOM): un non-2xx può avere un body enorme.
    const txt = await readErrorSnippet(res);
    if (txt) errMsg += ` — ${txt.slice(0, 300)}`;
    throw new IntegrationError({
      provider: provider as never, code: 'API_HTTP_ERROR', message: errMsg,
      httpStatus: res.status, retryable: res.status >= 500 || res.status === 429,
    });
  }
  // Robust empty-body 2xx (es. SendGrid 202 Accepted, molte API POST):
  // res.json() throwa "Unexpected end of JSON input" su body vuoto → text-first.
  // Lettura CAPPATA (anti-OOM su list API enormi).
  const text = await readTextCapped(res);
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export function parseJsonObj(provider: string, raw: unknown, fieldName: string): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error('not object');
    return p as Record<string, unknown>;
  } catch (e) {
    throw new IntegrationError({
      provider: provider as never, code: 'INVALID_PAYLOAD',
      message: `${provider}: ${fieldName} parse error — ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export function getIntegrationLabel(cfg: Record<string, unknown>): string | null {
  return typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null;
}

/** Sheets vuole 2D array; accetta [[..],..] o {values:[[..]]}. */
export function parseSheetValues(raw: unknown): unknown[][] {
  if (Array.isArray(raw)) return raw as unknown[][];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) return p as unknown[][];
      if (p && typeof p === 'object' && Array.isArray((p as { values?: unknown }).values)) {
        return (p as { values: unknown[][] }).values;
      }
    } catch { /* */ }
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { values?: unknown }).values)) {
    return (raw as { values: unknown[][] }).values;
  }
  throw new IntegrationError({
    provider: 'google_sheets', code: 'INVALID_PAYLOAD',
    message: 'google_sheets: valuesJson deve essere array 2D ([["a","b"],["c","d"]]) o oggetto {values:[[...]]}',
  });
}
