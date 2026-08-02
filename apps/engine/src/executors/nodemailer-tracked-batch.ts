/**
 * `action_email_send_tracked_batch` — executor.
 *
 * Iterates a list of recipients calling `sendEmailTrackedExecutor` for
 * each, paced by the stdlib scheduler. Pattern: simple, observable,
 * resumable. The scheduler returns `requeued=true` on items it didn't
 * have time/budget for; the upstream cron picks them up next tick.
 *
 * Performance posture
 * ───────────────────
 * Sequential by design. Concurrency on outbound SMTP is a footgun:
 *   - Gmail rate-limits per account, not per connection.
 *   - Two simultaneous XOAUTH2 connections to the same Gmail account
 *     can both succeed-then-fail when the token rotates mid-flight.
 *   - The scheduler enforces a per-item cadence; concurrency would
 *     defeat the whole point.
 *
 * @module executors/nodemailer-tracked-batch
 */

import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import {
  EmailSendTrackedBatchConfigSchema,
  runBatch,
  type BatchItem,
  type AttemptResult,
} from '@medea/engine-nodes-stdlib';
import { sendEmailTrackedExecutor } from './nodemailer-tracked.js';
import { logger } from '@/lib/logger.js';

export const sendEmailTrackedBatchExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const parsed = EmailSendTrackedBatchConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `action_email_send_tracked_batch: configurazione non valida — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const cfg = parsed.data;

  const incoming = (input ?? {}) as Record<string, unknown>;
  const incomingRecipients = Array.isArray(incoming.recipients) ? incoming.recipients : undefined;
  const recipients = cfg.recipients ?? incomingRecipients;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error(
      'action_email_send_tracked_batch: lista destinatari vuota (campo `recipients` config o `$json.recipients` upstream)',
    );
  }

  // The single-send executor enforces its own consent gate — but doing
  // the check ONCE here for the batch lets us fail fast before any send.
  if (cfg.requireConsent && incoming.consentVerified !== true) {
    throw new Error(
      "action_email_send_tracked_batch: invio rifiutato — l'input upstream non porta `consentVerified=true`.",
    );
  }

  const items: BatchItem[] = recipients.map((r, index) => ({
    index,
    overrides: r as Record<string, unknown>,
  }));

  const attempt = async (item: BatchItem, _attemptIdx: number): Promise<AttemptResult> => {
    const rec = item.overrides as {
      leadId?: string;
      to?: string;
      fromAddress?: string;
      templateVars?: Record<string, string | number | boolean | null>;
      sendId?: string;
    };
    if (!rec.leadId || !rec.to) {
      return { ok: false, retry: false, error: `recipient #${item.index}: leadId/to mancanti` };
    }

    const subject = interpolate(cfg.subject, rec.templateVars);
    const body = interpolate(cfg.body, rec.templateVars);

    const single: Record<string, unknown> = {
      ...rawConfig,
      to: rec.to,
      subject,
      body,
      leadId: rec.leadId,
      campaignId: cfg.campaignId,
    };
    if (rec.fromAddress) single.from = rec.fromAddress;
    if (rec.sendId) single.sendId = rec.sendId;
    // The single-send executor handles its OWN consent check; we already
    // verified it once above, so we forward the input untouched.

    try {
      const out = await sendEmailTrackedExecutor(single, input, context);
      const outRec = (out.output ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        messageId: (outRec.messageId as string | undefined) ?? '',
        sendId: (outRec.sendId as string | undefined) ?? rec.sendId ?? '',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Gmail / SMTP 4xx codes are retryable; 5xx and config errors are not.
      const retry =
        /\b(429|421|450|451|452)\b/.test(msg) || /timeout|ECONN|ENOTFOUND|throttl/i.test(msg);
      return { ok: false, retry, error: msg };
    }
  };

  const ratePerHour = cfg.ratePerHour;
  const result = await runBatch({
    items,
    ratePerHour,
    jitter: cfg.jitter,
    maxAttempts: cfg.maxAttempts,
    backoffBaseMs: cfg.backoffBaseMs,
    ...(cfg.budgetMs !== undefined ? { budgetMs: cfg.budgetMs } : {}),
    ...(context.abortSignal ? { signal: context.abortSignal } : {}),
    attempt,
  });

  logger.info(
    {
      component: 'email-send-tracked-batch',
      campaignId: cfg.campaignId,
      ...result.stats,
      items: items.length,
    },
    'batch send completed',
  );

  return {
    output: {
      stats: result.stats,
      results: result.results,
    },
    durationMs: result.stats.totalMs,
  };
};

/**
 * Cheap mustache-flavoured interpolation. Supports `{{key}}` and
 * `{{lead.field}}`. Missing keys substitute the literal empty string —
 * `action_email_send_tracked` rejects bodies that still carry `{{…}}`
 * tokens, so a typo'd variable name is caught downstream.
 *
 * We DON'T pull in a templating engine — Handlebars is 30kb min+gzip
 * and overkill for the variable-substitution patterns the workflow
 * authors use here.
 */
function interpolate(
  template: string,
  vars: Record<string, string | number | boolean | null> | undefined,
): string {
  const bag = vars ?? {};
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, key: string) => {
    const v = bag[key];
    if (v === undefined || v === null) return '';
    return String(v);
  });
}
