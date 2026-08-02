/**
 * `action_pec_legal_archive` — executor.
 *
 * Pipeline (10-15ms typical)
 * ──────────────────────────
 *   1. Parse Zod config.
 *   2. Extract { raw, messageId, receivedAt, pecType? } from input.
 *   3. Call `archivePec(input, opts)` from `lib/pec/legal-archive`.
 *   4. Surface receipt as output + pass-through input fields.
 *
 * @module actions/pec_legal_archive/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { ValidationError } from '../../core/node-error.js';
import { PecLegalArchiveConfigSchema } from './schema.js';
import { archivePec, type ArchiveInput } from '../../lib/pec/legal-archive.js';

export const pecLegalArchiveExecutor: NodeExecutor = async (rawConfig, input) => {
  const startedAt = Date.now();

  const parsed = parseConfig(PecLegalArchiveConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  const obj = unwrap(input);
  const raw = pickString(obj?.[cfg.rawField]);
  const messageId = pickString(obj?.[cfg.messageIdField]);
  const receivedAt = pickString(obj?.[cfg.receivedAtField]);
  if (!raw || !messageId || !receivedAt) {
    const missing: string[] = [];
    if (!raw) missing.push(cfg.rawField);
    if (!messageId) missing.push(cfg.messageIdField);
    if (!receivedAt) missing.push(cfg.receivedAtField);
    throw new ValidationError(`PEC_ARCHIVE_INPUT_MISSING_FIELDS: ${missing.join(', ')}`);
  }

  const archiveInput: ArchiveInput = { raw, messageId, receivedAt };
  const pecType = pickString(obj?.[cfg.pecTypeField]);
  if (pecType) archiveInput.pecType = pecType;

  const receipt = await archivePec(archiveInput, {
    archiveDir: cfg.archiveDir,
    conservationDays: cfg.conservationDays,
    hashAlgorithm: cfg.hashAlgorithm,
    writeSidecar: cfg.writeSidecar,
  });

  const ret: NodeExecutionResult = {
    output: {
      ...(obj ?? {}),
      archiveReceipt: receipt,
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
  if (root.output !== null && typeof root.output === 'object' && !('raw' in root)) {
    return root.output as Record<string, unknown>;
  }
  return root;
}

function pickString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return null;
}
