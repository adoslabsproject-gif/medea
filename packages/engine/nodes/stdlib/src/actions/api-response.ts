/**
 * action_api_response — trasforma un workflow in una vera API REST con risposta
 * STRUTTURATA e coerente. JavaScript puro (ZERO dipendenze, browser-safe).
 *
 * Si abbina al `trigger_webhook` (responseMode="use-respond-node"): il workflow
 * riceve la richiesta HTTP dal trigger, elabora, e questo nodo costruisce la
 * risposta REST. A differenza di `action_webhook_respond` (generico, mandi quel
 * che vuoi), questo è OPINIONATO sul formato REST 2026: envelope coerente
 * { ok, data, meta } / { ok, error: { code, message, details } }, status code
 * SEMANTICO, CORS pronto, codici d'errore standard — l'API "a prova di idiota".
 *
 * Emette il sentinel `__webhookResponse` letto dal runtime (webhooks.ts):
 *   { status, contentType, body (stringa), headers }.
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
/** CWE-113: rimuove CR/LF/NUL da un valore header (cors/custom da config utente). */
function stripCrlf(v: string): string {
  return v.replace(/[\r\n\0]/g, '');
}
/** Nome header valido = token RFC 7230 (no CRLF/spazi/`:`). Altri → scartati. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

// Codici d'errore REST standard → status HTTP semantico.
const ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_error: 422,
  rate_limited: 429,
  server_error: 500,
};

const apiResponseExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const mode = str(config.mode, 'success');
  const useEnvelope = str(config.envelope, 'true') !== 'false';

  // ── Body ─────────────────────────────────────────────────────────────
  let status: number;
  let bodyObj: unknown;
  if (mode === 'error') {
    const code = str(config.errorCode, 'bad_request');
    status = ERROR_STATUS[code] ?? 400;
    const message = str(config.errorMessage) || code.replace(/_/g, ' ');
    const details = parseMaybeJson(config.errorDetails);
    const errObj: Record<string, unknown> = { code, message };
    if (details !== undefined) errObj.details = details;
    bodyObj = useEnvelope ? { ok: false, error: errObj } : errObj;
  } else {
    status = Number(config.statusSuccess) || 200;
    const data =
      config.data !== undefined && str(config.data) !== ''
        ? parseMaybeJson(config.data)
        : parseMaybeJson(input);
    const meta = parseMaybeJson(config.meta);
    bodyObj = useEnvelope
      ? { ok: true, data: data ?? null, ...(meta !== undefined ? { meta } : {}) }
      : (data ?? null);
  }

  // ── Headers (CORS + custom) ──────────────────────────────────────────
  const headers: Record<string, string> = {};
  if (str(config.cors) === 'true') {
    headers['Access-Control-Allow-Origin'] = stripCrlf(str(config.corsOrigin, '*') || '*');
    headers['Access-Control-Allow-Methods'] = stripCrlf(
      str(config.corsMethods, 'GET,POST,PUT,DELETE,OPTIONS') || 'GET,POST,PUT,DELETE,OPTIONS',
    );
    headers['Access-Control-Allow-Headers'] = stripCrlf(
      str(config.corsHeaders, 'Content-Type,Authorization') || 'Content-Type,Authorization',
    );
    if (str(config.corsCredentials) === 'true')
      headers['Access-Control-Allow-Credentials'] = 'true';
  }
  const extra = parseMaybeJson(config.headers);
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      // Header injection guard (CWE-113): nome token-valido E valore senza CRLF.
      if (HEADER_NAME_RE.test(k) && !/[\r\n]/.test(str(v))) headers[k] = str(v);
    }
  }

  const body = JSON.stringify(bodyObj);
  return {
    output: {
      __webhookResponse: { status, contentType: 'application/json; charset=utf-8', body, headers },
      // Eco osservabile (per debug / step successivi): non usato dal runtime.
      status,
      ok: mode !== 'error',
    },
    durationMs: Date.now() - startedAt,
  };
};

export const apiResponseNode: NodeModule = {
  def: {
    id: 'action_api_response',
    type: 'action',
    label: 'API: Risposta REST',
    icon: 'send',
    color: '#0284c7',
    description:
      'Trasforma il tuo workflow in una vera API REST con risposta STRUTTURATA e coerente, in JavaScript puro ' +
      '(zero dipendenze). Si posiziona alla fine di un workflow che parte da `trigger_webhook` ' +
      '(responseMode = "use-respond-node"): il trigger riceve la chiamata HTTP, il workflow elabora, e questo ' +
      'nodo costruisce la risposta nel formato REST standard 2026 — così chi consuma la tua API riceve SEMPRE ' +
      'una struttura prevedibile, non un JSON improvvisato. Due modalità da dropdown: ' +
      '(1) SUCCESS — avvolge i dati in un envelope coerente `{ ok: true, data: <payload>, meta?: {…} }` con uno ' +
      'status di successo semantico (200 OK / 201 Created / 202 Accepted / 204 No Content) e un blocco meta ' +
      'opzionale per paginazione, totali, versione; ' +
      "(2) ERROR — produce `{ ok: false, error: { code, message, details? } }` con il CODICE D'ERRORE REST " +
      'standard che mappa automaticamente sullo status HTTP corretto (bad_request→400, unauthorized→401, ' +
      'forbidden→403, not_found→404, conflict→409, validation_error→422, rate_limited→429, server_error→500) — ' +
      "niente più status sbagliati o messaggi d'errore incoerenti tra un endpoint e l'altro. " +
      'Gestione CORS integrata (origin, metodi, header, credentials) per essere chiamato direttamente dal ' +
      'browser di una SPA senza configurare nulla a mano, header personalizzati con guardia anti-injection (no ' +
      'CRLF), e modalità "envelope off" se preferisci restituire i dati grezzi. Content-Type sempre ' +
      'application/json; charset=utf-8. ' +
      'Output: sentinel `__webhookResponse` raccolto dal runtime (status + body + headers). ' +
      'Use case: esponi un endpoint pubblico che restituisce i dati di un ordine in formato REST pulito ' +
      '(SUCCESS + envelope + meta paginazione); rispondi 404 strutturato quando una risorsa non esiste (ERROR ' +
      "not_found); valida l'input e rispondi 422 con i dettagli dei campi sbagliati (ERROR validation_error + " +
      'details); crea una micro-API consumata da una SPA browser (CORS on); webhook che risponde 200 con un ack ' +
      'strutturato a un partner B2B.',
    configFields: [
      {
        key: 'mode',
        label: 'Tipo di risposta',
        type: 'select',
        required: true,
        defaultValue: 'success',
        options: ['success', 'error'],
        help: 'success = { ok:true, data } · error = { ok:false, error } con status mappato automaticamente.',
      },
      {
        key: 'data',
        label: 'Dati (payload)',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "Il contenuto della risposta (oggetto/JSON o expression upstream). Vuoto = usa l'input del nodo.",
        showIf: { field: 'mode', equals: 'success' },
      },
      {
        key: 'statusSuccess',
        label: 'Status di successo',
        type: 'select',
        required: false,
        defaultValue: '200',
        options: ['200', '201', '202', '204'],
        help: '200 OK · 201 Created · 202 Accepted · 204 No Content (senza body).',
        showIf: { field: 'mode', equals: 'success' },
      },
      {
        key: 'meta',
        label: 'Meta (JSON, opzionale)',
        type: 'json',
        required: false,
        placeholder: '{ "page": 1, "pageSize": 20, "total": 137 }',
        help: 'Metadati aggiunti come { ok, data, meta }. Tipico per paginazione/totali.',
        showIf: { field: 'mode', equals: 'success' },
      },
      {
        key: 'errorCode',
        label: 'Codice errore',
        type: 'select',
        required: false,
        defaultValue: 'bad_request',
        options: [
          'bad_request',
          'unauthorized',
          'forbidden',
          'not_found',
          'conflict',
          'validation_error',
          'rate_limited',
          'server_error',
        ],
        help: 'Mappa automaticamente sullo status HTTP (es. not_found→404, validation_error→422).',
        showIf: { field: 'mode', equals: 'error' },
      },
      {
        key: 'errorMessage',
        label: 'Messaggio errore',
        type: 'text',
        required: false,
        placeholder: 'Risorsa non trovata',
        help: 'Messaggio leggibile. Vuoto = derivato dal codice.',
        showIf: { field: 'mode', equals: 'error' },
      },
      {
        key: 'errorDetails',
        label: 'Dettagli errore (JSON, opzionale)',
        type: 'json',
        required: false,
        placeholder: '{ "field": "email", "reason": "formato non valido" }',
        help: 'Dettagli strutturati (es. errori di validazione per campo).',
        showIf: { field: 'mode', equals: 'error' },
      },
      {
        key: 'envelope',
        label: 'Envelope { ok, data/error }',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Avvolge la risposta nel formato standard. Disattiva per restituire i dati grezzi.',
      },
      {
        key: 'cors',
        label: 'Abilita CORS',
        type: 'boolean',
        required: false,
        help: "Aggiunge gli header CORS — necessario se l'API è chiamata dal browser di una SPA.",
      },
      {
        key: 'corsOrigin',
        label: 'CORS Origin',
        type: 'text',
        required: false,
        defaultValue: '*',
        help: 'Origine consentita (* o un dominio specifico).',
        showIf: { field: 'cors', equals: 'true' },
      },
      {
        key: 'corsMethods',
        label: 'CORS Metodi',
        type: 'text',
        required: false,
        defaultValue: 'GET,POST,PUT,DELETE,OPTIONS',
        showIf: { field: 'cors', equals: 'true' },
      },
      {
        key: 'corsHeaders',
        label: 'CORS Header consentiti',
        type: 'text',
        required: false,
        defaultValue: 'Content-Type,Authorization',
        showIf: { field: 'cors', equals: 'true' },
      },
      {
        key: 'corsCredentials',
        label: 'CORS Credentials',
        type: 'boolean',
        required: false,
        help: "Consente l'invio di cookie/credenziali (Access-Control-Allow-Credentials).",
        showIf: { field: 'cors', equals: 'true' },
      },
      {
        key: 'headers',
        label: 'Header personalizzati (JSON)',
        type: 'json',
        required: false,
        placeholder: '{ "Cache-Control": "no-store", "X-Api-Version": "1" }',
        help: 'Header extra. I valori con a-capo (CRLF) vengono scartati (anti-injection).',
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: apiResponseExecutor,
};
