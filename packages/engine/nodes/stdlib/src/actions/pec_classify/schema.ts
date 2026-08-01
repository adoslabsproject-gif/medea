/**
 * `action_pec_classify` — Zod config schema.
 *
 * Branching node: it reads PEC headers from the input and routes the flow
 * to one of FOUR output handles based on the receipt category.
 *
 * @module actions/pec_classify/schema
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

export const PecClassifyConfigSchema = z.object({
  /**
   * Dotted path into `input` that points at the headers map. Default
   * `headers` — matches the shape emitted by the standard IMAP trigger
   * (the existing `italia_pec_aruba_receive` trigger).
   *
   * Examples:
   *   - `headers`                  (default IMAP shape)
   *   - `output.headers`           (when wrapped in a run-row envelope)
   *   - `mail.headers`             (custom trigger shape)
   */
  headersPath: z.string().min(1).max(120).default('headers'),

  /**
   * When true, the classify step ALSO emits a `classified.match` payload
   * that includes the raw headers in a redacted form (`X-*` only). Useful
   * for downstream audit nodes. Disabled by default to avoid leaking
   * `From` / `Subject` into nodes that don't need them.
   */
  includeHeadersInOutput: boolish.default(false),

  /** Embed pipelineSteps in the output. */
  includePipelineLog: boolish.default(true),
}).passthrough();

export type PecClassifyConfig = z.infer<typeof PecClassifyConfigSchema>;
