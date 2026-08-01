/**
 * `agent_email_triage_b2b_sales` — executor.
 *
 * @module actions/email_triage_b2b_sales/executor
 */

import type { NodeExecutor } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { EmailTriageB2BSalesConfigSchema } from './schema.js';
import { classifyB2BSalesReply } from '../../lib/email/triage-b2b-sales.js';

export const emailTriageB2BSalesExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();
  const parsed = parseConfig(EmailTriageB2BSalesConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const obj = unwrap(input);
  const subject = pickString(obj?.[cfg.subjectField]);
  const body = pickString(obj?.[cfg.bodyField]);
  const from = pickString(obj?.[cfg.fromField]);

  const classifyArgs: Parameters<typeof classifyB2BSalesReply>[0] = {
    subject, body, lang: cfg.lang,
  };
  if (from !== null) classifyArgs.from = from;
  const result = classifyB2BSalesReply(classifyArgs);

  // Apply per-config minConfidence override (defaults to the lib's 0.7 too,
  // but a workflow author may want to be stricter).
  let finalLabel = result.label;
  let finalAction = result.suggestedAction;
  if (finalLabel !== 'needs_human_review' && result.confidence < cfg.minConfidence) {
    finalLabel = 'needs_human_review';
    finalAction = 'forward_to_human';
  }

  return {
    output: {
      ...(obj ?? {}),
      label: finalLabel,
      confidence: result.confidence,
      matchedKeywords: result.matchedKeywords,
      language: result.language,
      suggestedAction: finalAction,
      replyDraft: finalLabel === 'needs_human_review' ? '' : result.replyDraft,
    },
    durationMs: Date.now() - startedAt,
  };
};

function unwrap(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') return null;
  const root = input as Record<string, unknown>;
  if (root.output !== null && typeof root.output === 'object' && !('subject' in root)) {
    return root.output as Record<string, unknown>;
  }
  return root;
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
