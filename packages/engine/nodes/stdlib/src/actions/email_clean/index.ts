/**
 * `action_email_clean` — NodeModule.
 *
 * @module actions/email_clean
 */

import type { NodeModule } from '../../types.js';
import { wrap } from '../../core/middleware.js';
import { emailCleanNodeDef } from './definition.js';
import { emailCleanExecutor } from './executor.js';

export const emailCleanActionNode: NodeModule = {
  def: emailCleanNodeDef,
  executor: wrap(emailCleanExecutor, []),
};

export { emailCleanExecutor, emailCleanNodeDef };
export { EmailCleanConfigSchema, type EmailCleanConfig } from './schema.js';
