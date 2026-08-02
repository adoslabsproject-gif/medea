/**
 * `action_email_send_tracked_batch` — NodeModule.
 *
 * Stdlib provides def + schema + pure scheduler. The executor that
 * iterates and calls `action_email_send_tracked` per recipient lives in
 * `apps/engine/src/executors/nodemailer-tracked-batch.ts`.
 *
 * @module actions/email_send_tracked_batch
 */

import type { NodeModule } from '../../types.js';
import { emailSendTrackedBatchNodeDef } from './definition.js';

export const emailSendTrackedBatchNode: NodeModule = {
  def: emailSendTrackedBatchNodeDef,
};

export { emailSendTrackedBatchNodeDef };
export {
  EmailSendTrackedBatchConfigSchema,
  EmailSendTrackedBatchInputSchema,
  BatchRecipientSchema,
  type EmailSendTrackedBatchConfig,
  type BatchRecipient,
} from './schema.js';
export {
  runBatch,
  type SchedulerOptions,
  type BatchItem,
  type BatchResult,
  type BatchStats,
  type AttemptResult,
} from './scheduler.js';
