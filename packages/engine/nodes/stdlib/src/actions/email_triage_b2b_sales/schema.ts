/**
 * `agent_email_triage_b2b_sales` — config schema.
 *
 * @module actions/email_triage_b2b_sales/schema
 */

import { z } from 'zod';

const trimmed = z.string().trim();

export const EmailTriageB2BSalesConfigSchema = z
  .object({
    /** Field on the input object that holds the subject. Default: `subject`. */
    subjectField: trimmed.min(1).default('subject'),
    /** Field that holds the plain-text body. Default: `body`. */
    bodyField: trimmed.min(1).default('body'),
    /** Field that holds the sender email (for noreply override). Default: `from`. */
    fromField: trimmed.min(1).default('from'),
    /** Language hint or `auto`. */
    lang: z.enum(['auto', 'it', 'en', 'de', 'fr']).default('auto'),
    /** Below this confidence the result is downgraded to needs_human_review. */
    minConfidence: z.coerce.number().min(0).max(1).default(0.7),
  })
  .passthrough();

export type EmailTriageB2BSalesConfig = z.infer<typeof EmailTriageB2BSalesConfigSchema>;
