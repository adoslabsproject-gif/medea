/**
 * `action_email_triage` — executor.
 *
 * @module actions/email_triage/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { ValidationError } from '../../core/node-error.js';
import { triageEmail, type RawEmail } from '../../lib/email/triage.js';
import { EmailTriageConfigSchema } from './schema.js';

export const emailTriageExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();

  const parsed = parseConfig(EmailTriageConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const email = resolveInput(input, cfg.inputPath);
  const triaged = triageEmail(email, { bodyMaxChars: cfg.bodyMaxChars });

  const output: Record<string, unknown> = {
    senderName: triaged.senderName,
    senderEmail: triaged.senderEmail,
    senderDomain: triaged.senderDomain,
    subjectClean: triaged.subjectClean,
    bodyTextShort: triaged.bodyTextShort,
    bodyTextOriginalLength: triaged.bodyTextOriginalLength,
    attachments: triaged.attachments,
    languageGuess: triaged.languageGuess,
    urgencySignals: triaged.urgencySignals,
    isPec: triaged.isPec,
    isNewsletter: triaged.isNewsletter,
    messageId: triaged.messageId,
  };
  if (cfg.includePipelineLog) {
    output.pipelineSteps = [
      {
        name: 'email_triage',
        startedAt,
        durationMs: Date.now() - startedAt,
        ok: true,
        evidence: {
          senderDomain: triaged.senderDomain,
          languageGuess: triaged.languageGuess,
          urgencyCount: triaged.urgencySignals.length,
          attachmentsCount: triaged.attachments.count,
          truncated: triaged.bodyTextOriginalLength > cfg.bodyMaxChars,
        },
      },
    ];
  }

  return { output, durationMs: Date.now() - startedAt } satisfies NodeExecutionResult;
};

function resolveInput(input: unknown, path: string): RawEmail {
  let cur: unknown = input;
  if (path && path.trim() !== '') {
    for (const seg of path.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') break;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) {
    throw new ValidationError(
      `EMAIL_TRIAGE_NO_INPUT: expected an email object at input.${path || '(root)'} — ` +
      `pass the IMAP / SMTP receive node output`,
    );
  }
  return cur;
}
