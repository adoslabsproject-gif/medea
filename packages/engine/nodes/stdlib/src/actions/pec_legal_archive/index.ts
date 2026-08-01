/**
 * `action_pec_legal_archive` — NodeModule.
 *
 * @module actions/pec_legal_archive
 */

import type { NodeModule } from '../../types.js';
import { wrap } from '../../core/middleware.js';
import { pecLegalArchiveNodeDef } from './definition.js';
import { pecLegalArchiveExecutor } from './executor.js';

export const pecLegalArchiveActionNode: NodeModule = {
  def: pecLegalArchiveNodeDef,
  executor: wrap(pecLegalArchiveExecutor, []),
};

export { pecLegalArchiveExecutor, pecLegalArchiveNodeDef };
export {
  PecLegalArchiveConfigSchema,
  type PecLegalArchiveConfig,
} from './schema.js';
