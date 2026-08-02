/**
 * Sentinel reporter — invia eventi sicurezza al portal zeliAI.
 *
 * Quando il container rileva anomalie (failed login burst, workflow anomaly,
 * credentials decrypt fail, ecc.), chiama POST /api/v1/webhooks/flowforge
 * con HMAC SHA-256 signature.
 *
 * Failure mode: fail-open (best-effort). Se il portal non risponde,
 * loggare ma NON bloccare l'operazione del container.
 */

import { createHmac } from 'node:crypto';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';

const log = logger;

export type EventType =
  | 'failed_login_burst'
  | 'workflow_anomaly'
  | 'credentials_decrypt_fail'
  | 'rate_limit_breach'
  | 'unauthorized_access';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityEvent {
  eventType: EventType;
  severity: Severity;
  details?: Record<string, unknown>;
}

const REPORT_TIMEOUT_MS = 3000;

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export async function reportSecurityEvent(ev: SecurityEvent): Promise<void> {
  const config = loadConfig();
  const tenantId = config.MEDEA_TENANT_ID;
  const portalUrl = config.MEDEA_PORTAL_URL;
  const secret = config.MEDEA_WEBHOOK_SECRET;

  // No tenant context o no secret = container in dev mode. Skip silently.
  if (!tenantId || !secret) {
    log.debug?.({ eventType: ev.eventType }, 'sentinel-reporter skipped (no tenant/secret)');
    return;
  }

  const payload = {
    eventType: ev.eventType,
    workspaceId: tenantId,
    occurredAt: new Date().toISOString(),
    severity: ev.severity,
    details: ev.details ?? {},
  };
  const body = JSON.stringify(payload);
  const signature = sign(body, secret);

  const url = `${portalUrl.replace(/\/$/, '')}/api/v1/webhooks/flowforge`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FF-Signature': signature,
        'X-FF-Tenant': tenantId,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn?.({ status: res.status, eventType: ev.eventType }, '[SENTINEL] portal returned non-2xx');
      return;
    }
    log.info?.({ eventType: ev.eventType, severity: ev.severity }, '[SENTINEL] event reported');
  } catch (err) {
    log.warn?.(
      { err: err instanceof Error ? err.message : err, eventType: ev.eventType },
      '[SENTINEL] report failed (fail-open)',
    );
  } finally {
    clearTimeout(timeout);
  }
}
