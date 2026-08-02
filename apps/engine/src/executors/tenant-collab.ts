/**
 * Executor `action_tenant_collab` — invio dati CROSS-TENANT via webhook bridge.
 *
 * Garanzie:
 *   • Allowlist SSRF stretta (validateCollabUrl): SOLO webhook FlowForge
 *     tenant — il nodo NON è un action_http generico.
 *   • HMAC-SHA256 'ts.body' calcolata UNA SOLA volta e riusata sui retry:
 *     il dedup anti-replay del ricevente (webhookSignatureSeen) garantisce
 *     at-most-once anche quando un retry segue una risposta persa.
 *   • Retry exponential backoff SOLO su transitori (5xx/429/timeout/rete).
 *   • Audit GDPR: ogni invio (riuscito O fallito) è un data-transfer
 *     cross-tenant nell'audit log immutabile — con sha256 del payload,
 *     MAI il contenuto, e URL redatto (il token è un segreto).
 *
 * @module executors/tenant-collab
 */

import { coerceString } from '@/lib/coerce.js';
import { readTextTruncated } from '@/lib/capped-response.js';
import { createHash, randomUUID } from 'node:crypto';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, withRetry } from './integrations/common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { AuditLogService } from '@/services/audit.service.js';
import { logger } from '@/lib/logger.js';
import {
  COLLAB_CORRELATION_HEADER,
  COLLAB_IDEMPOTENCY_HEADER,
  COLLAB_MAX_PAYLOAD_BYTES,
  COLLAB_MIN_TOKEN_LENGTH,
  COLLAB_SIGNATURE_HEADER,
  COLLAB_SOURCE_HEADER,
  COLLAB_TIMESTAMP_HEADER,
  collabPayloadFingerprint,
  redactCollabUrl,
  scrubCollabSecrets,
  signCollabPayload,
  validateCollabUrl,
} from './tenant-collab-protocol.js';

const audit = new AuditLogService();

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES_CAP = 5;
/** Cap della risposta inclusa nell'output (waitForResponse) — anti memory-blow. */
const MAX_RESPONSE_CHARS = 262_144;

function collabError(code: string, message: string, extra?: { httpStatus?: number; retryable?: boolean; cause?: unknown }): IntegrationError {
  return new IntegrationError({
    provider: 'unknown',
    code,
    message: `action_tenant_collab: ${message}`,
    ...(extra?.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra?.retryable !== undefined ? { retryable: extra.retryable } : {}),
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
  });
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || coerceString(value).toLowerCase() === 'true';
}

function asClampedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Messaggi idiot-proof per i 4xx del ricevente — dicono COSA sistemare. */
function explain4xx(status: number): string {
  if (status === 401 || status === 403) {
    return 'il destinatario ha RIFIUTATO la firma: token di connessione errato/ruotato (consenso revocato?) oppure invio duplicato (anti-replay)';
  }
  if (status === 404) return 'workflow destinatario non trovato: l\'URL di collaborazione è cambiato o il workflow è stato eliminato';
  if (status === 409) return 'workflow destinatario disabilitato o senza trigger Webhook';
  if (status === 429) return 'il destinatario sta limitando le richieste (rate limit)';
  return 'richiesta rifiutata dal destinatario';
}

export const tenantCollabExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const start = Date.now();
  const cfg = rawConfig;

  // ── 1. URL allowlist (PRIMA di qualunque I/O) ────────────────────────
  const rawUrl = coerceString(cfg.collaborationUrl ?? '').trim();
  if (!rawUrl) throw collabError('MISSING_URL', '"URL di collaborazione" è obbligatorio');
  const urlCheck = validateCollabUrl(rawUrl);
  if (!urlCheck.ok) throw collabError('COLLAB_URL_NOT_ALLOWED', `URL rifiutato — ${urlCheck.reason}`);
  const targetUrl = urlCheck.url.toString();
  const redactedUrl = redactCollabUrl(targetUrl);
  const urlToken = urlCheck.url.pathname.split('/').pop() ?? '';

  // ── 2. Config tipizzata (CanvasNode.config è string-only) ────────────
  const signPayload = asBool(cfg.signPayload, true);
  const waitForResponse = asBool(cfg.waitForResponse, true);
  const timeoutMs = asClampedInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxRetries = asClampedInt(cfg.maxRetries, 3, 0, MAX_RETRIES_CAP);
  const connectionToken = coerceString(cfg.connectionToken ?? '').trim();
  if (signPayload && connectionToken.length < COLLAB_MIN_TOKEN_LENGTH) {
    throw collabError(
      'CONNECTION_TOKEN_INVALID',
      `con la firma attiva serve un token di connessione di almeno ${String(COLLAB_MIN_TOKEN_LENGTH)} caratteri ` +
      '(concordalo col tenant destinatario — è la chiave HMAC e il suo consenso)',
    );
  }
  const secretsToScrub = [connectionToken, urlToken];

  // ── 3. Payload: payloadJson (già interpolato dall'engine) o input ────
  let payload: unknown;
  const payloadJson = typeof cfg.payloadJson === 'string' ? cfg.payloadJson.trim() : '';
  if (payloadJson !== '') {
    try {
      payload = JSON.parse(payloadJson);
    } catch (err) {
      throw collabError(
        'INVALID_PAYLOAD',
        `"Payload (JSON)" non è JSON valido — ${scrubCollabSecrets(err instanceof Error ? err.message : String(err), secretsToScrub)}`,
      );
    }
  } else {
    payload = input ?? {};
  }
  const body = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(body, 'utf8');
  if (payloadBytes > COLLAB_MAX_PAYLOAD_BYTES) {
    throw collabError(
      'PAYLOAD_TOO_LARGE',
      `payload ${String(payloadBytes)} byte > cap ${String(COLLAB_MAX_PAYLOAD_BYTES)} — per i file condividi un link, non il contenuto`,
    );
  }

  // ── 4. Identità dell'invio (stabile sui retry) ───────────────────────
  const correlationId = randomUUID();
  const customIdemKey = typeof cfg.idempotencyKey === 'string' ? cfg.idempotencyKey.trim() : '';
  const idempotencyKey = customIdemKey !== ''
    ? customIdemKey.slice(0, 128)
    : createHash('sha256').update(`collab:${context.tenantId}:${context.runId}:${context.nodeId}`).digest('hex').slice(0, 32);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    [COLLAB_SOURCE_HEADER]: context.tenantId,
    [COLLAB_CORRELATION_HEADER]: correlationId,
    [COLLAB_IDEMPOTENCY_HEADER]: idempotencyKey,
  };
  if (signPayload) {
    // Firma UNA VOLTA, fuori dal retry loop: il ricevente deduplica sulla
    // signature → un retry dopo risposta persa NON viene processato due volte.
    const timestampSec = Math.floor(Date.now() / 1000);
    headers[COLLAB_TIMESTAMP_HEADER] = String(timestampSec);
    headers[COLLAB_SIGNATURE_HEADER] = signCollabPayload({ body, token: connectionToken, timestampSec });
  }

  // ── 5. Invio con retry backoff sui soli transitori ───────────────────
  let attempts = 0;
  const auditBase = {
    tenantId: context.tenantId,
    actorId: `workflow:${context.workflowId}`,
    resourceType: 'tenant_collab',
    resourceId: correlationId,
  };
  const auditMeta: Record<string, unknown> = {
    targetUrl: redactedUrl,
    targetHost: urlCheck.url.hostname,
    sourceWorkflowId: context.workflowId,
    runId: context.runId,
    nodeId: context.nodeId,
    correlationId,
    idempotencyKey,
    payloadSha256: collabPayloadFingerprint(body),
    payloadBytes,
    signed: signPayload,
  };
  const warnings: string[] = [];
  /** L'invio è GIÀ partito: l'audit fallito non lo annulla — non fallire il run, ma traccia forte. */
  const appendAudit = async (action: string, extra: Record<string, unknown>): Promise<void> => {
    try {
      await audit.append({ ...auditBase, action, metadata: { ...auditMeta, ...extra } });
    } catch (err) {
      const msg = `audit GDPR del data-transfer NON registrato: ${err instanceof Error ? err.message : String(err)}`;
      logger.error({ correlationId, action }, `[tenant_collab] ${msg}`);
      warnings.push(msg);
    }
  };

  let res: Response;
  try {
    res = await withRetry(async () => {
      attempts += 1;
      let response: Response;
      try {
        const fetchInit: Parameters<typeof safeOutboundFetch>[1] = {
          method: 'POST',
          headers,
          body,
          timeoutMs,
          spanName: 'node.tenant_collab.send',
        };
        if (context.abortSignal) fetchInit.externalSignal = context.abortSignal;
        response = await safeOutboundFetch(targetUrl, fetchInit);
      } catch (err) {
        // Timeout/rete = transitori (retry sicuro: firma stabile → at-most-once
        // lato ricevente). Messaggio scrubbed: il layer fetch può citare l'URL.
        const raw = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        throw collabError(
          isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          `invio a ${redactedUrl} fallito — ${scrubCollabSecrets(raw, secretsToScrub)}`,
          { retryable: true, cause: err },
        );
      }
      if (response.status >= 500) {
        try { await response.body?.cancel(); } catch { /* drain FD senza leggere il body */ }
        throw collabError('RECIPIENT_5XX', `destinatario in errore (HTTP ${String(response.status)}) su ${redactedUrl}`, {
          httpStatus: response.status, retryable: true,
        });
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* drain FD senza leggere il body */ }
        throw collabError('RECIPIENT_REJECTED', `HTTP ${String(response.status)} — ${explain4xx(response.status)} (${redactedUrl})`, {
          httpStatus: response.status, retryable: response.status === 429,
        });
      }
      return response;
    }, { retries: maxRetries, label: 'tenant_collab.send' });
  } catch (err) {
    await appendAudit('collab.data_transfer.failed', {
      outcome: 'failed',
      attempts,
      errorCode: err instanceof IntegrationError ? err.code : 'UNKNOWN',
      ...(err instanceof IntegrationError && err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    });
    throw err;
  }

  // ── 6. Risposta + audit del transfer riuscito ────────────────────────
  let responseBody: unknown = null;
  try {
    const text = (await readTextTruncated(res, 4 * 1024 * 1024)).text.slice(0, MAX_RESPONSE_CHARS);
    if (waitForResponse && text !== '') {
      try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    }
  } catch { /* body non leggibile: la consegna (2xx) resta valida */ }

  await appendAudit('collab.data_transfer.sent', { outcome: 'sent', attempts, httpStatus: res.status });

  return {
    output: {
      delivered: true,
      status: res.status,
      response: responseBody,
      correlationId,
      idempotencyKey,
      attempts,
      signed: signPayload,
      targetHost: urlCheck.url.hostname,
      durationMs: Date.now() - start,
    },
    durationMs: Date.now() - start,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};
