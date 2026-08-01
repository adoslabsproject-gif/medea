/**
 * `action_email_send_tracked` — config schema.
 *
 * Wraps SMTP / Gmail-XOAUTH2 send + injects:
 *   - 1×1 transparent GIF pixel pointing at `<base>/api/track/open/<token>`
 *   - rewrites every <a href="X"> into `<base>/api/track/click/<token>?u=<X>`
 *
 * The (lead, campaign, send) tuple is signed via HMAC-SHA256
 * (see `lib/email-tracking-token.ts`) so the open/click endpoints can
 * recover identity WITHOUT a database hit per request.
 *
 * GDPR posture: the executor refuses to send when `requireConsent=true`
 * and the inbound `consentVerified` flag isn't truthy. This is a hard
 * gate, not a hint — false-positives here cost €20M, so we err safe.
 *
 * @module actions/email_send_tracked/schema
 */

import { z } from 'zod';

const trimmed = z.string().trim();

/**
 * Coerce truthy/falsy strings into a real boolean.
 *
 * `z.coerce.boolean()` is a trap: it uses `Boolean()` which makes the
 * string "false" → true (any non-empty string is truthy). For UI fields
 * that arrive as form-encoded "false" / "0" / "" we need real semantics.
 */
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
const optionalEmail = trimmed.email().max(254).optional()
  .or(z.literal('').transform(() => undefined));

export const EmailSendTrackedConfigSchema = z.object({
  // ── Account/transport ──
  /**
   * Optional system-account ID — when set we ignore the per-fields below
   * and resolve SMTP host/port/auth from the encrypted store. Same
   * mechanism as `action_send_email`.
   */
  systemAccountId: z.string().min(1).optional()
    .or(z.literal('').transform(() => undefined)),
  /** Manual transport, used only when systemAccountId is empty. */
  host: trimmed.max(255).optional()
    .or(z.literal('').transform(() => undefined)),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  security: z.enum(['none', 'starttls', 'tls']).default('starttls'),
  username: trimmed.max(255).optional()
    .or(z.literal('').transform(() => undefined)),
  password: z.string().max(2048).optional()
    .or(z.literal('').transform(() => undefined)),

  // ── Envelope ──
  from: optionalEmail,
  to: trimmed.min(1, 'destinatario obbligatorio').max(2048),
  cc: trimmed.max(2048).optional()
    .or(z.literal('').transform(() => undefined)),
  bcc: trimmed.max(2048).optional()
    .or(z.literal('').transform(() => undefined)),
  replyTo: optionalEmail,
  subject: trimmed.min(1, 'oggetto obbligatorio').max(998),

  // ── Body ──
  /** Body content. May contain <a href> links — they all get rewritten. */
  body: z.string().min(1, 'corpo obbligatorio').max(500_000),
  /** Inferred or forced content type. Tracking pixel is injected into html only. */
  bodyType: z.enum(['html', 'text']).default('html'),

  // ── Tracking identity ──
  /**
   * Lead row id (in the tenant DB `leads` table). REQUIRED — without an
   * id we can't tie opens/clicks back to a contact, defeating the point.
   */
  leadId: trimmed.min(1, 'leadId obbligatorio').max(120),
  /**
   * Campaign id. Human-readable string. Used for analytics rollup
   * (open-rate per campaign).
   */
  campaignId: trimmed.min(1, 'campaignId obbligatorio').max(120),
  /**
   * Send id. If absent we auto-generate a uuid — but caller-supplied
   * ids are encouraged so a workflow retry doesn't create a phantom
   * duplicate send.
   */
  sendId: trimmed.min(1).max(120).optional(),

  // ── Tracking knobs ──
  /** Disable the open pixel (e.g. for ATP-sensitive recipients). */
  trackOpens: booleanish.default(true),
  /** Disable click rewriting (legal/compliance text-only mailings). */
  trackClicks: booleanish.default(true),
  /**
   * Public base URL where the runtime serves `/api/track/{open,click}/...`.
   * Required because the email may be opened months from now on a device
   * that has no way to discover the runtime URL on its own.
   *
   * Falls back to `process.env.FLOWFORGE_PUBLIC_BASE_URL` at runtime
   * (set by the container provisioner) when this field is blank.
   */
  trackingBaseUrl: trimmed.url().optional()
    .or(z.literal('').transform(() => undefined)),

  // ── GDPR ──
  /**
   * When true, the executor REFUSES to send unless the inbound payload
   * carries `consentVerified=true`. Default true — opt-out by config,
   * never accidental. Set to false ONLY for transactional non-marketing
   * mails (e.g. order receipts).
   */
  requireConsent: booleanish.default(true),
  /**
   * Sample-rate gate: when 0 < x < 1, only send to a fraction of recipients
   * (A/B testing). Implemented downstream by the workflow author — the
   * field is kept here for visibility in the run inspector.
   */
  sampleRate: z.coerce.number().min(0).max(1).default(1),

  // ── Knobs ──
  timeoutMs: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  /**
   * Whitelist of host suffixes the click rewriter is allowed to wrap.
   * Anything OUTSIDE the list is left as a plain link (no tracking) so
   * we never become an open-redirect ladder to arbitrary attacker URLs.
   * Default: same host as `trackingBaseUrl` + nothing else.
   *
   * `*` allows all hosts (legacy; emits a warning to the run log).
   */
  clickWhitelist: z.array(trimmed).default([]),
}).passthrough();

export type EmailSendTrackedConfig = z.infer<typeof EmailSendTrackedConfigSchema>;

/** Input shape expected on context.input — produced by upstream nodes. */
export const EmailSendTrackedInputSchema = z.object({
  /**
   * Stamped by the GDPR-consent workflow upstream. The executor REQUIRES
   * `true` when `requireConsent` is enabled. Anything truthy other than
   * `true` is treated as `false` (defense in depth).
   */
  consentVerified: z.unknown().optional(),
}).passthrough();
