/**
 * `action_pec_classify` — executor.
 *
 * Branching node: returns `result.branch` set to one of:
 *   'received_message' | 'acceptance_receipt' | 'delivery_receipt' | 'rejection'
 *
 * The engine reads `branch` and follows the matching outgoing edge. The
 * payload (`output`) is the SAME on every branch so downstream nodes can
 * read the classification metadata uniformly.
 *
 * @module actions/pec_classify/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { ValidationError } from '../../core/node-error.js';
import {
  classifyPecMessage,
  type PecInputHeaders,
  type PecMessageType,
} from '../../lib/pec/receipt-parser.js';
import { PecClassifyConfigSchema } from './schema.js';

const BRANCH_BY_TYPE: Readonly<
  Record<
    PecMessageType,
    'received_message' | 'acceptance_receipt' | 'delivery_receipt' | 'rejection'
  >
> = {
  pec_received_message: 'received_message',
  pec_acceptance_receipt: 'acceptance_receipt',
  pec_delivery_receipt: 'delivery_receipt',
  pec_rejection: 'rejection',
};

export const pecClassifyExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();

  const parsed = parseConfig(PecClassifyConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const headers = extractHeaders(input, cfg.headersPath);
  const classified = classifyPecMessage(headers);

  const output: Record<string, unknown> = {
    type: classified.type,
    branch: BRANCH_BY_TYPE[classified.type],
    receiptCategory: classified.receiptCategory,
    receiptStyle: classified.receiptStyle,
    refMessageId: classified.refMessageId,
    trasporto: classified.trasporto,
    isPec: classified.isPec,
  };
  if (cfg.includeHeadersInOutput) {
    output.headers = filterXHeaders(headers);
  }
  if (cfg.includePipelineLog) {
    output.pipelineSteps = [
      {
        name: 'pec_classify',
        startedAt,
        durationMs: Date.now() - startedAt,
        ok: true,
        evidence: {
          type: classified.type,
          receiptCategory: classified.receiptCategory,
          refMessageId: classified.refMessageId,
        },
      },
    ];
  }

  return {
    output,
    branch: BRANCH_BY_TYPE[classified.type],
    durationMs: Date.now() - startedAt,
  } satisfies NodeExecutionResult;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function extractHeaders(input: unknown, path: string): PecInputHeaders {
  const parts = path.split('.');
  let cur: unknown = input;
  for (const seg of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') break;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) {
    throw new ValidationError(
      `PEC_CLASSIFY_NO_HEADERS: nothing at input.${path} — pass the IMAP message ` +
        `output (with .headers map) or override the headersPath config`,
    );
  }
  return cur as PecInputHeaders;
}

function filterXHeaders(headers: PecInputHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^x-/i.test(k)) continue;
    if (typeof v === 'string' || Array.isArray(v)) out[k] = v;
  }
  return out;
}
