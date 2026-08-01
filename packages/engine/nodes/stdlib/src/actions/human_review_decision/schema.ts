/**
 * `flow_human_review_decision` — config schema.
 *
 * @module actions/human_review_decision/schema
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

export const HumanReviewDecisionConfigSchema = z.object({
  /** Confidence threshold below which the decision routes to "review". */
  confidenceThreshold: z.coerce.number().min(0).max(1).default(0.7),

  /** Path on the input record that carries the numeric confidence. */
  confidenceField: z.string().min(1).max(64).default('confidence'),

  /** Optional second field — when present, the LOWER of the two wins. */
  secondaryConfidenceField: z.string().max(64).optional(),

  /**
   * Categories that ALWAYS go to review regardless of confidence. Comma-
   * separated (UI), normalised to a Set at runtime. Example:
   * `legal_request,fraud,payment_failed`.
   */
  alwaysReviewLabels: z.string().max(500).default(''),

  /** Field that carries the classifier label (read for alwaysReviewLabels). */
  labelField: z.string().min(1).max(64).default('label'),

  /**
   * When true, route to "review" if the classifier returned NO label / no
   * confidence (safer than passing junk to "auto"). Default true.
   */
  fallbackOnMissing: boolish.default(true),

  /**
   * Optional Zod-validated reason code stamped on the review record so the
   * operator sees WHY it was kicked to review.
   */
  reasonTemplate: z.string().max(200).optional(),
}).passthrough();

export type HumanReviewDecisionConfig = z.infer<typeof HumanReviewDecisionConfigSchema>;
