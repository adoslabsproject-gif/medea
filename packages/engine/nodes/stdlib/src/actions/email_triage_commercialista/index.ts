/**
 * `agent_email_triage_commercialista` — NodeModule.
 *
 * @module actions/email_triage_commercialista
 */

import type { NodeModule } from '../../types.js';
import { wrap } from '../../core/middleware.js';
import { emailTriageCommercialistaNodeDef } from './definition.js';
import { emailTriageCommercialistaExecutor } from './executor.js';

export const emailTriageCommercialistaActionNode: NodeModule = {
  def: emailTriageCommercialistaNodeDef,
  executor: wrap(emailTriageCommercialistaExecutor, []),
};

export { emailTriageCommercialistaExecutor, emailTriageCommercialistaNodeDef };
export {
  EmailTriageCommercialistaConfigSchema,
  type EmailTriageCommercialistaConfig,
} from './schema.js';
