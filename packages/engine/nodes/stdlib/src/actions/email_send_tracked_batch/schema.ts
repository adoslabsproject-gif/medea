/**
 * `action_email_send_tracked_batch` — config schema.
 *
 * Inputs a list of recipients (each with its own leadId + template
 * variables) plus a batch-wide template body. Internally calls
 * `action_email_send_tracked` for each, paced by the scheduler.
 *
 * @module actions/email_send_tracked_batch/schema
 */

import { z } from 'zod';

/** Cap HARD sul numero di destinatari per batch (anti-DoS/toll). Coerente con il tetto
 *  di ratePerHour; un batch oltre questo va spezzato a monte. */
const MAX_BATCH_RECIPIENTS = 10_000;

const trimmed = z.string().trim();

const booleanish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (v === '' || v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  }
  if (typeof v === 'number') return v !== 0;
  return v;
}, z.boolean());

/**
 * Per-recipient row. Fields the batch template doesn't carry — leadId,
 * destination email, personalization variables — live here.
 *
 * `templateVars` is a free-form bag the executor injects into the body
 * by simple `{{key}}` substitution. Empty by default.
 */
export const BatchRecipientSchema = z.object({
  leadId: trimmed.min(1).max(120),
  to: trimmed.email().max(254),
  fromAddress: trimmed.email().max(254).optional(),
  templateVars: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  /** Idempotent send-id; auto-generated when omitted. */
  sendId: trimmed.min(1).max(120).optional(),
});
export type BatchRecipient = z.infer<typeof BatchRecipientSchema>;

export const EmailSendTrackedBatchConfigSchema = z
  .object({
    // ── Account / transport ──
    systemAccountId: trimmed
      .min(1)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    host: trimmed
      .max(255)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    security: z.enum(['none', 'starttls', 'tls']).default('starttls'),
    username: trimmed
      .max(255)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    password: z
      .string()
      .max(2048)
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // ── Envelope template ──
    from: trimmed
      .email()
      .max(254)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Replied-to. */
    replyTo: trimmed
      .email()
      .max(254)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Subject template. Each recipient gets {{vars}} interpolated. */
    subject: trimmed.min(1, 'subject obbligatorio').max(998),
    /** Body template. */
    body: trimmed.min(1, 'body obbligatorio').max(500_000),
    bodyType: z.enum(['html', 'text']).default('html'),

    // ── Tracking ──
    campaignId: trimmed.min(1).max(120),
    trackOpens: booleanish.default(true),
    trackClicks: booleanish.default(true),
    trackingBaseUrl: trimmed
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    clickWhitelist: z.array(trimmed).default([]),

    // ── GDPR ──
    requireConsent: booleanish.default(true),

    // ── Recipients ──
    /**
     * Array of recipient rows. The executor accepts either:
     *  - this field on the config (when the workflow author serializes
     *    the list at design-time), OR
     *  - `context.input.recipients` (when it comes from a db_query upstream).
     *
     * `.max()` OBBLIGATORIO (anti-DoS/toll): senza, un upstream (db_query) può iniettare
     * un array illimitato → invii illimitati. I campi singoli erano cappati, l'array no.
     */
    recipients: z.array(BatchRecipientSchema).max(MAX_BATCH_RECIPIENTS).optional(),

    // ── Throttling ──
    ratePerHour: z.coerce.number().int().min(1).max(10_000).default(60),
    jitter: z.coerce.number().min(0).max(0.95).default(0.2),
    maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
    backoffBaseMs: z.coerce.number().int().min(500).max(120_000).default(5_000),
    /**
     * Total budget in ms. When the run exceeds it, remaining recipients
     * get `requeued=true` in the result so an upstream cron can pick them
     * up next tick. Default: 2× the ideal time.
     */
    budgetMs: z.coerce.number().int().min(1_000).optional(),

    timeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  })
  .passthrough();

export type EmailSendTrackedBatchConfig = z.infer<typeof EmailSendTrackedBatchConfigSchema>;

/** Input shape — same consent gate as the single-send sibling. */
export const EmailSendTrackedBatchInputSchema = z
  .object({
    recipients: z.array(BatchRecipientSchema).max(MAX_BATCH_RECIPIENTS).optional(),
    consentVerified: z.unknown().optional(),
  })
  .passthrough();
