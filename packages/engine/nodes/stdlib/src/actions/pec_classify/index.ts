/**
 * `action_pec_classify` — NodeModule.
 *
 * Pure-compute branching node — no I/O. Wraps with error-mapping + abort-guard.
 *
 * @module actions/pec_classify
 */

import type { NodeModule } from '../../types.js';
import { wrap } from '../../core/middleware.js';
import { withErrorMapping, withAbortGuard } from '../../core/middleware/error-handling.js';
import { pecClassifyNodeDef } from './definition.js';
import { pecClassifyExecutor } from './executor.js';

export const pecClassifyActionNode: NodeModule = {
  def: pecClassifyNodeDef,
  executor: wrap(pecClassifyExecutor, [withErrorMapping(), withAbortGuard()]),
};

export { pecClassifyExecutor, pecClassifyNodeDef };
export { PecClassifyConfigSchema, type PecClassifyConfig } from './schema.js';
