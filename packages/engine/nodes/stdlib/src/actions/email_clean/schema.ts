/**
 * `action_email_clean` — Zod config schema.
 *
 * @module actions/email_clean/schema
 */

import { z } from 'zod';

const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
]);

export const EmailCleanConfigSchema = z.object({
  /** Strip "On … wrote:" / "Il giorno … ha scritto:" reply blocks. */
  stripQuotedReply: boolish.default(true),
  /** Strip RFC-3676 "-- " + mobile + generic contact-block signatures. */
  stripSignatures: boolish.default(true),
  /** Strip GDPR/confidentiality boilerplate. */
  stripDisclaimers: boolish.default(true),
  /** Replace UTM-tagged URLs with the bare domain. */
  stripTrackingUrls: boolish.default(false),
  /** Collapse runs of ≥3 blank lines to a single blank. */
  collapseBlankLines: boolish.default(true),
  /** Hard truncation cap (chars). */
  maxBodyLength: z.coerce.number().int().min(64).max(64_000).default(8_192),

  /** Field name on the input record that carries the raw body (default `body`). */
  inputBodyField: z.string().min(1).max(64).default('body'),
}).passthrough();

export type EmailCleanConfig = z.infer<typeof EmailCleanConfigSchema>;
