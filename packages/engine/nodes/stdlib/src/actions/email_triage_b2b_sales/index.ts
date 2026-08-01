/**
 * `agent_email_triage_b2b_sales` — NodeModule.
 *
 * Lib classifier is bundled in the stdlib (`lib/email/triage-b2b-sales.ts`)
 * — fully self-contained, no LLM dependency. The workflow author can
 * pipe the `needs_human_review` branch into an `action_llm_complete`
 * downstream if they want richer analysis.
 *
 * @module actions/email_triage_b2b_sales
 */

import type { NodeModule } from '../../types.js';
import { emailTriageB2BSalesNodeDef } from './definition.js';
import { emailTriageB2BSalesExecutor } from './executor.js';

export const emailTriageB2BSalesNode: NodeModule = {
  def: emailTriageB2BSalesNodeDef,
  executor: emailTriageB2BSalesExecutor,
};

export { emailTriageB2BSalesNodeDef, emailTriageB2BSalesExecutor };
export { EmailTriageB2BSalesConfigSchema, type EmailTriageB2BSalesConfig } from './schema.js';
export {
  classifyB2BSalesReply,
  detectLang,
  type B2BSalesLabel,
  type Lang,
  type SuggestedAction,
  type ClassifyInput,
  type ClassifyResult,
} from '../../lib/email/triage-b2b-sales.js';
