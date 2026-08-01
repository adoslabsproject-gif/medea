/**
 * `flow_human_review_decision` — NodeModule.
 *
 * @module actions/human_review_decision
 */

import type { NodeModule } from '../../types.js';
import { wrap } from '../../core/middleware.js';
import { humanReviewDecisionNodeDef } from './definition.js';
import { humanReviewDecisionExecutor } from './executor.js';

export const humanReviewDecisionNode: NodeModule = {
  def: humanReviewDecisionNodeDef,
  executor: wrap(humanReviewDecisionExecutor, []),
};

export { humanReviewDecisionExecutor, humanReviewDecisionNodeDef };
export {
  HumanReviewDecisionConfigSchema,
  type HumanReviewDecisionConfig,
} from './schema.js';
