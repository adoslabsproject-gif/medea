/**
 * `agent_email_triage_commercialista` — Zod config schema.
 *
 * @module actions/email_triage_commercialista/schema
 */

import { z } from 'zod';

const optionalRecord = z
  .string()
  .max(2_000)
  .refine(
    (s) => {
      if (s === '') return true;
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be valid JSON' },
  )
  .transform((s) => (s === '' ? undefined : (JSON.parse(s) as Record<string, unknown>)))
  .optional();

export const EmailTriageCommercialistaConfigSchema = z
  .object({
    /** Field on the input record containing the subject. */
    subjectField: z.string().min(1).max(64).default('subject'),
    /** Field on the input record containing the body. */
    bodyField: z.string().min(1).max(64).default('body'),
    /** Field on the input record containing the sender. */
    fromField: z.string().min(1).max(64).default('from'),

    /**
     * Override per-label operator address. JSON object string, e.g.:
     * `{"fiscale":"anna@studio","f24":"marco@studio"}`.
     */
    operatorsJson: optionalRecord,

    /** Override per-label reply template (same JSON shape). */
    replyTemplatesJson: optionalRecord,

    /**
     * Override per-label urgency tier (high/normal/low). JSON object, e.g.:
     * `{"payment":"normal","altro":"low"}`.
     */
    urgencyJson: optionalRecord,
  })
  .passthrough();

export type EmailTriageCommercialistaConfig = z.infer<typeof EmailTriageCommercialistaConfigSchema>;
