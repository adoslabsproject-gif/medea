/**
 * `action_email_triage` — NodeModule.
 *
 * @module actions/email_triage
 */

import type { NodeModule } from '../../types.js';
import { wrap } from '../../core/middleware.js';
import { withErrorMapping, withAbortGuard } from '../../core/middleware/error-handling.js';
import { emailTriageNodeDef } from './definition.js';
import { emailTriageExecutor } from './executor.js';

export const emailTriageActionNode: NodeModule = {
  def: emailTriageNodeDef,
  executor: wrap(emailTriageExecutor, [withErrorMapping(), withAbortGuard()]),
};

export { emailTriageExecutor, emailTriageNodeDef };
export { EmailTriageConfigSchema, type EmailTriageConfig } from './schema.js';
