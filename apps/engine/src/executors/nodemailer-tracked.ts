/**
 * `action_email_send_tracked` — executor.
 *
 * Pattern: this executor is a thin wrapper around `sendEmailExecutor`.
 * It does three things the plain version doesn't:
 *
 *   1. **GDPR consent gate** — refuses to send unless the inbound input
 *      carries `consentVerified: true` (default; opt-out via config).
 *   2. **Body injection** — pixel + click-rewrite via the pure
 *      `injectTracking()` helper from the stdlib.
 *   3. **Interaction log** — after a successful send we INSERT into
 *      `b2b_interactions` so the lead-score workflow can attribute the
 *      delivery (basis for the open-rate / click-rate denominators).
 *
 * Why a wrapper, not a re-implementation
 * ──────────────────────────────────────
 * The SMTP / Gmail-XOAUTH2 / circuit breaker / deliverability logic
 * lives in `nodemailer.ts` and is battle-tested. Re-implementing 200
 * lines of transport setup would duplicate every subtle XOAUTH2 quirk
 * we already fixed. Wrapping is honest: we transform the body, then
 * delegate.
 *
 * @module executors/nodemailer-tracked
 */

import { randomUUID } from 'node:crypto';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { EmailSendTrackedConfigSchema } from '@medea/engine-nodes-stdlib';
import { injectTracking } from '@medea/engine-nodes-stdlib/server';
import { sendEmailExecutor } from './nodemailer.js';
import { getDatabase } from '@/storage/db.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';

const log = (extra: Record<string, unknown>): void => {
  logger.info({ component: 'email-send-tracked', ...extra });
};

export const sendEmailTrackedExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const parsed = EmailSendTrackedConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `action_email_send_tracked: configurazione non valida — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const cfg = parsed.data;

  // ── GDPR consent gate ────────────────────────────────────────────
  // The schema default for requireConsent is TRUE — sending without a
  // verified consent stamp is the classic GDPR €20M trap. We accept
  // ONLY a literal `true` (not "true" / 1 / truthy object) to prevent
  // accidental upstream coercion from waving past the gate.
  if (cfg.requireConsent) {
    const incoming = (input ?? {}) as Record<string, unknown>;
    if (incoming.consentVerified !== true) {
      throw new Error(
        'action_email_send_tracked: invio rifiutato — l\'input upstream non porta `consentVerified=true`. ' +
        'Sblocca il consenso (workflow GDPR Consent) PRIMA di chiamare questo nodo, ' +
        'oppure spegni `requireConsent` SOLO per email transazionali non commerciali.',
      );
    }
  }

  // ── Resolve tracking base URL + HMAC secret ──────────────────────
  const runtimeCfg = loadConfig();
  const baseUrl = (cfg.trackingBaseUrl ?? runtimeCfg.MEDEA_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'action_email_send_tracked: trackingBaseUrl non impostato. ' +
      'Configura il campo "URL base tracking" nel nodo, oppure l\'env MEDEA_PUBLIC_BASE_URL nel container.',
    );
  }
  const secret = runtimeCfg.MEDEA_SSO_SECRET ?? process.env.MEDEA_SSO_SECRET ?? '';
  if (!secret || secret.length < 32) {
    throw new Error('action_email_send_tracked: MEDEA_SSO_SECRET mancante (≥32 char) — impossibile firmare i token tracking.');
  }

  const sendId = cfg.sendId ?? randomUUID();

  // ── Body injection (only for HTML; text/plain doesn't support <img>) ─
  let finalBody = cfg.body;
  let pixelUrl: string | null = null;
  let openToken: string | null = null;
  let clickTokens: string[] = [];

  if (cfg.bodyType === 'html' && (cfg.trackOpens || cfg.trackClicks)) {
    const injected = await injectTracking({
      html: cfg.body,
      workspaceId: context.tenantId,
      leadId: cfg.leadId,
      campaignId: cfg.campaignId,
      sendId,
      trackOpens: cfg.trackOpens,
      trackClicks: cfg.trackClicks,
      trackingBaseUrl: baseUrl,
      clickWhitelist: cfg.clickWhitelist.length > 0 ? cfg.clickWhitelist : [],
      secret,
    });
    finalBody = injected.html;
    pixelUrl = injected.pixelUrl;
    openToken = injected.openToken;
    clickTokens = injected.clickTokens;
  }

  // ── Delegate to the plain SMTP executor with the modified body ──
  // We pass an enriched config that's a superset of action_send_email's
  // schema — extra keys are ignored downstream (passthrough on Zod).
  const delegateConfig: Record<string, unknown> = {
    ...rawConfig,
    body: finalBody,
    bodyType: cfg.bodyType,
  };

  const delegate = await sendEmailExecutor(delegateConfig, input, context);

  // ── Persist the `email_sent` interaction ──
  // Best-effort: a failed INSERT does NOT roll back the send (the email
  // has already left the building). We just log + move on.
  recordEmailSent({
    tenantId: context.tenantId,
    leadId: cfg.leadId,
    campaignId: cfg.campaignId,
    sendId,
    messageId: ((delegate.output as Record<string, unknown> | undefined)?.messageId as string | undefined) ?? null,
  });

  log({
    leadId: cfg.leadId,
    campaignId: cfg.campaignId,
    sendId,
    trackOpens: cfg.trackOpens,
    trackClicks: cfg.trackClicks,
    clickCount: clickTokens.length,
  });

  return {
    output: {
      ...((delegate.output ?? {}) as Record<string, unknown>),
      sendId,
      leadId: cfg.leadId,
      campaignId: cfg.campaignId,
      pixelUrl,
      openToken,
      clickTokens,
    },
    durationMs: delegate.durationMs,
  };
};

interface RecordSentArgs {
  tenantId: string;
  leadId: string;
  campaignId: string;
  sendId: string;
  messageId: string | null;
}

function recordEmailSent(args: RecordSentArgs): void {
  try {
    const { sqlite } = getDatabase();
    sqlite.prepare(
      `INSERT INTO b2b_interactions (id, tenant_id, lead_id, campaign_id, send_id, type, payload_json)
       VALUES (?, ?, ?, ?, ?, 'email_sent', ?)`,
    ).run(
      randomUUID(),
      args.tenantId,
      args.leadId,
      args.campaignId,
      args.sendId,
      JSON.stringify({ messageId: args.messageId }),
    );
  } catch (err) {
    logger.error({ err, args, component: 'email-send-tracked' }, 'INSERT b2b_interactions(email_sent) failed');
  }
}
