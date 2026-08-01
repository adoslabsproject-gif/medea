/**
 * Protocollo cross-tenant collaboration — primitive PURE (zero I/O).
 *
 * Contratto col RICEVENTE (trigger_webhook, routes/webhooks.ts authorize()):
 * il destinatario imposta authMode='hmac-signature', hmacSecret=<token
 * condiviso>, hmacHeader=COLLAB_SIGNATURE_HEADER, hmacTimestampHeader=
 * COLLAB_TIMESTAMP_HEADER → verifica HMAC-SHA256 su `${ts}.${body}`
 * (formato Stripe-like, default di authorize) + anti-replay ±300s + dedup
 * LRU della signature. Il contract test tenant-collab.contract.test.ts
 * verifica la compatibilità contro authorize() REALE — se uno dei due lati
 * cambia formato, il test si rompe SUBITO.
 *
 * @module executors/tenant-collab-protocol
 */

import { createHash, createHmac } from 'node:crypto';

/** Header firma HMAC — il ricevente lo dichiara come hmacHeader. */
export const COLLAB_SIGNATURE_HEADER = 'x-ff-collab-signature';
/** Header timestamp Unix (secondi) — il ricevente lo dichiara come hmacTimestampHeader. */
export const COLLAB_TIMESTAMP_HEADER = 'x-ff-collab-timestamp';
/** Tenant mittente (workspace id) — per correlazione/audit lato ricevente. */
export const COLLAB_SOURCE_HEADER = 'x-ff-collab-source-tenant';
/** Correlation id univoco dell'invio — compare nell'audit di ENTRAMBI i tenant. */
export const COLLAB_CORRELATION_HEADER = 'x-ff-collab-correlation-id';
/** Chiave di deduplica applicativa (stabile sui retry). */
export const COLLAB_IDEMPOTENCY_HEADER = 'idempotency-key';

/** Cap payload: il bridge trasporta DATI, non file (per i file → link). */
export const COLLAB_MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Lunghezza minima del token condiviso: sotto, l'HMAC è brute-forzabile. */
export const COLLAB_MIN_TOKEN_LENGTH = 16;

const DEFAULT_ALLOWED_HOST_SUFFIXES = ['.app.automazionezeli.com'];

/**
 * Suffissi host ammessi per l'URL di collaborazione. Override via env
 * FLOWFORGE_COLLAB_ALLOWED_HOST_SUFFIXES (CSV) per staging/dev — MAI per
 * aprire il nodo a host arbitrari: il valore di sicurezza del nodo è
 * proprio il perimetro chiuso FlowForge→FlowForge.
 */
export function allowedCollabHostSuffixes(): string[] {
  const raw = process.env.FLOWFORGE_COLLAB_ALLOWED_HOST_SUFFIXES ?? '';
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith('.') && s.length > 1);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_HOST_SUFFIXES;
}

export type CollabUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Allowlist SSRF del bridge: SOLO webhook FlowForge tenant.
 *
 * Più stretta del guard generico di safeOutboundFetch (che blocca solo IP
 * privati/metadata): qui rifiutiamo QUALSIASI host che non sia un subdomain
 * tenant, porte esplicite, credenziali in-URL e path fuori da
 * /api/v1/webhooks/ — il nodo non deve poter diventare un HTTP client
 * generico verso altre API del tenant remoto.
 */
export function validateCollabUrl(raw: string): CollabUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'URL non valido — copia l\'URL webhook dal workflow del destinatario' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'È ammesso solo https://' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'Credenziali nell\'URL non ammesse' };
  }
  if (url.port !== '') {
    return { ok: false, reason: 'Porta esplicita non ammessa (i webhook FlowForge sono su 443)' };
  }
  const host = url.hostname.toLowerCase();
  const suffixOk = allowedCollabHostSuffixes().some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
  if (!suffixOk) {
    return {
      ok: false,
      reason: `Host "${host}" non è un workspace FlowForge (atteso *.app.automazionezeli.com)`,
    };
  }
  if (!url.pathname.startsWith('/api/v1/webhooks/')) {
    return { ok: false, reason: 'Il path deve essere un webhook FlowForge (/api/v1/webhooks/…)' };
  }
  if (url.pathname.replace('/api/v1/webhooks/', '').length === 0) {
    return { ok: false, reason: 'URL webhook incompleto: mancano workflowId e token' };
  }
  return { ok: true, url };
}

/**
 * Firma HMAC-SHA256 esadecimale su `${timestampSec}.${body}` — ESATTAMENTE
 * il signed-payload format 'ts.body' che authorize() verifica di default
 * quando hmacTimestampHeader è configurato.
 */
export function signCollabPayload(args: { body: string; token: string; timestampSec: number }): string {
  return createHmac('sha256', args.token)
    .update(`${String(args.timestampSec)}.${args.body}`)
    .digest('hex');
}

/** Impronta sha256 del payload — va nell'audit AL POSTO del contenuto (GDPR data minimization). */
export function collabPayloadFingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Redazione dell'URL per audit/log/errori: l'ULTIMO path segment è il token
 * del webhook destinatario (sia /webhooks/:wfId/:token che
 * /webhooks/c/:path/:token) → sostituito con '***'. Niente query/fragment.
 */
export function redactCollabUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const segments = url.pathname.split('/');
    if (segments.length > 0 && (segments[segments.length - 1] ?? '') !== '') {
      segments[segments.length - 1] = '***';
    }
    return `${url.origin}${segments.join('/')}`;
  } catch {
    return '<url-non-valido>';
  }
}

/**
 * Rimuove i segreti (token di connessione + token URL) da un testo destinato
 * a messaggi d'errore o log. Difesa in profondità: i messaggi che costruiamo
 * usano già l'URL redatto, ma gli errori del layer fetch possono incorporare
 * l'URL originale.
 */
export function scrubCollabSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('***');
  }
  return out;
}
