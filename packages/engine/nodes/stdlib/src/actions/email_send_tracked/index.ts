/**
 * `action_email_send_tracked` — NodeModule export.
 *
 * Pattern matches `action_send_email`: stdlib provides ONLY the
 * `NodeDef` (UI + schema metadata). The actual executor lives in
 * `apps/engine/src/executors/nodemailer.ts` where nodemailer,
 * the OAuth refresh service, and the tenant DB pool already live.
 *
 * @module actions/email_send_tracked
 */

import type { NodeModule } from '../../types.js';
import { emailSendTrackedNodeDef } from './definition.js';

export const emailSendTrackedNode: NodeModule = {
  def: emailSendTrackedNodeDef,
};

export { emailSendTrackedNodeDef };
export {
  EmailSendTrackedConfigSchema,
  EmailSendTrackedInputSchema,
  type EmailSendTrackedConfig,
} from './schema.js';
