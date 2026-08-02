/**
 * `agent_email_triage_commercialista` — executor.
 *
 * @module actions/email_triage_commercialista/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { ValidationError } from '../../core/node-error.js';
import { EmailTriageCommercialistaConfigSchema } from './schema.js';
import {
  classifyCommercialistaEmail,
  type ClassifyOptions,
  type CommercialistaLabel,
} from '../../lib/email/triage-commercialista.js';

const VALID_TIERS = new Set(['high', 'normal', 'low']);

export const emailTriageCommercialistaExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();

  const parsed = parseConfig(EmailTriageCommercialistaConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const obj = unwrap(input);

  const classifyOpts: ClassifyOptions = {};
  if (cfg.operatorsJson) classifyOpts.operators = coerceStringRecord(cfg.operatorsJson);
  if (cfg.replyTemplatesJson)
    classifyOpts.replyTemplates = coerceStringRecord(cfg.replyTemplatesJson);
  if (cfg.urgencyJson) classifyOpts.urgency = coerceUrgencyRecord(cfg.urgencyJson);

  const result = classifyCommercialistaEmail(
    {
      subject: pickString(obj?.[cfg.subjectField]),
      body: pickString(obj?.[cfg.bodyField]),
      from: pickString(obj?.[cfg.fromField]),
    },
    classifyOpts,
  );

  const ret: NodeExecutionResult = {
    output: {
      ...(obj ?? {}),
      label: result.label,
      confidence: result.confidence,
      matchedKeywords: result.matchedKeywords,
      suggestedOperator: result.suggestedOperator,
      suggestedReplyTemplate: result.suggestedReplyTemplate,
      urgencyTier: result.urgencyTier,
    },
    durationMs: Date.now() - startedAt,
  };
  return ret;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function unwrap(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object') return null;
  const root = input as Record<string, unknown>;
  if (root.output !== null && typeof root.output === 'object' && !('subject' in root)) {
    return root.output as Record<string, unknown>;
  }
  return root;
}

function pickString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  return null;
}

function coerceStringRecord(
  raw: Record<string, unknown>,
): Partial<Record<CommercialistaLabel, string>> {
  const out: Partial<Record<CommercialistaLabel, string>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isCommercialistaLabel(k)) continue;
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

function coerceUrgencyRecord(
  raw: Record<string, unknown>,
): Partial<Record<CommercialistaLabel, 'high' | 'normal' | 'low'>> {
  const out: Partial<Record<CommercialistaLabel, 'high' | 'normal' | 'low'>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isCommercialistaLabel(k)) continue;
    if (typeof v === 'string' && VALID_TIERS.has(v)) {
      out[k] = v as 'high' | 'normal' | 'low';
    } else {
      throw new ValidationError(`EMAIL_TRIAGE_INVALID_TIER: "${k}" → must be high/normal/low`);
    }
  }
  return out;
}

function isCommercialistaLabel(s: string): s is CommercialistaLabel {
  return [
    'fiscale',
    'iva',
    'f24',
    'forfettario',
    'sollecito',
    'pec_legal',
    'payment',
    'bilancio',
    'altro',
  ].includes(s);
}
