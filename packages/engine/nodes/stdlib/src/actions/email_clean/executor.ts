/**
 * `action_email_clean` — executor.
 *
 * Input contract
 * ──────────────
 *   • `{ <inputBodyField>: string, ... }` — typical (from `trigger_imap`)
 *   • `{ output: { <inputBodyField>: string } }` — nested run-row wrap
 *   • `string` — bare body
 *
 * Output
 * ──────
 *   {
 *     ...input,                 // pass-through (subject, from, etc.)
 *     <inputBodyField>: cleanedBody,
 *     cleanReport: {
 *       removedQuotedReply, removedSignature, removedDisclaimer,
 *       trackingUrlsReplaced, originalLength, cleanedLength,
 *       reductionRatio
 *     }
 *   }
 *
 * @module actions/email_clean/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { ValidationError } from '../../core/node-error.js';
import { EmailCleanConfigSchema } from './schema.js';
import { cleanEmailBody, type EmailCleanOptions } from '../../lib/email/cleaner.js';

export const emailCleanExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();

  const parsed = parseConfig(EmailCleanConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const { body, container } = extractBody(input, cfg.inputBodyField);

  const cleanOpts: EmailCleanOptions = {
    stripQuotedReply: cfg.stripQuotedReply,
    stripSignatures: cfg.stripSignatures,
    stripDisclaimers: cfg.stripDisclaimers,
    stripTrackingUrls: cfg.stripTrackingUrls,
    collapseBlankLines: cfg.collapseBlankLines,
    maxBodyLength: cfg.maxBodyLength,
  };
  const result = cleanEmailBody(body, cleanOpts);

  // Pass-through pattern: merge over the original record so downstream nodes
  // keep seeing `subject`, `from`, etc. Replace ONLY the body field.
  const output: Record<string, unknown> = {
    ...(container ?? {}),
    [cfg.inputBodyField]: result.cleanedBody,
    cleanReport: {
      removedQuotedReply: result.removedQuotedReply,
      removedSignature: result.removedSignature,
      removedDisclaimer: result.removedDisclaimer,
      trackingUrlsReplaced: result.trackingUrlsReplaced,
      originalLength: result.originalLength,
      cleanedLength: result.cleanedLength,
      reductionRatio: result.reductionRatio,
    },
  };

  const ret: NodeExecutionResult = {
    output,
    durationMs: Date.now() - startedAt,
  };
  // Warning only on the suspicious case: input was non-empty but cleaning
  // dropped EVERYTHING — likely a misconfigured `inputBodyField` or a body
  // that was actually 100% boilerplate.
  if (result.originalLength > 50 && result.cleanedLength === 0) {
    ret.warnings = ['cleaner removed the entire body — check inputBodyField + strippers'];
  }
  return ret;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface BodyExtraction {
  body: string;
  /** The container object the body lives in (used for pass-through). */
  container: Record<string, unknown> | null;
}

function extractBody(input: unknown, field: string): BodyExtraction {
  if (typeof input === 'string') {
    return { body: input, container: null };
  }
  if (input === null || typeof input !== 'object') {
    throw new ValidationError(
      `EMAIL_CLEAN_INPUT_INVALID: expected string or object with "${field}" field`,
    );
  }
  const root = input as Record<string, unknown>;

  // Allow either flat or { output: { … } } wrap.
  let container: Record<string, unknown> = root;
  if (typeof root[field] !== 'string' && root.output !== null && typeof root.output === 'object') {
    container = root.output as Record<string, unknown>;
  }

  const raw = container[field];
  if (typeof raw !== 'string') {
    throw new ValidationError(
      `EMAIL_CLEAN_INPUT_MISSING_FIELD: input has no string field "${field}"`,
    );
  }
  return { body: raw, container };
}
