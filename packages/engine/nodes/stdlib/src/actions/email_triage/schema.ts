/**
 * `action_email_triage` — Zod config schema.
 *
 * @module actions/email_triage/schema
 */

import { z } from 'zod';

const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
]);

export const EmailTriageConfigSchema = z
  .object({
    /** Body truncation length. Default 2000. Range 200-20000. */
    bodyMaxChars: z.coerce.number().int().min(200).max(20_000).default(2_000),

    /**
     * Dotted path into `input` that points at the email object. Default
     * `''` (use input directly). Useful for nested run-row shapes.
     */
    inputPath: z.string().max(120).default(''),

    /** Embed pipelineSteps in the output. */
    includePipelineLog: boolish.default(true),
  })
  .passthrough();

export type EmailTriageConfig = z.infer<typeof EmailTriageConfigSchema>;
