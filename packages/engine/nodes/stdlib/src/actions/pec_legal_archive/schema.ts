/**
 * `action_pec_legal_archive` — Zod config schema.
 *
 * @module actions/pec_legal_archive/schema
 */

import { z } from 'zod';

const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
]);

export const PecLegalArchiveConfigSchema = z.object({
  /**
   * Root directory inside the tenant container for archived eml + sidecars
   * + manifest. Default `/data/pec-archive` — same volume that stores the
   * tenant SQLite, persistent across container restarts.
   */
  archiveDir: z.string().min(1).max(200).regex(/^\/[A-Za-z0-9_\-./]+$/, 'absolute path required')
    .default('/data/pec-archive'),

  /** Retention in days (≥365). Default 3650 (10 years, fiscale IT). */
  conservationDays: z.coerce.number().int().min(365).max(36_500).default(3650),

  /** Hash algorithm for integrity proof. */
  hashAlgorithm: z.enum(['sha256', 'sha384', 'sha512']).default('sha256'),

  /** Write the sidecar `<receiptId>.eml.<alg>` checksum file. */
  writeSidecar: boolish.default(true),

  /** Field on the input that carries the raw eml bytes/string. */
  rawField: z.string().min(1).max(64).default('raw'),
  /** Field on the input that carries the upstream messageId. */
  messageIdField: z.string().min(1).max(64).default('messageId'),
  /** Field on the input that carries the receivedAt ISO timestamp. */
  receivedAtField: z.string().min(1).max(64).default('receivedAt'),
  /** Field that carries the PEC type (optional — surfaced in manifest only). */
  pecTypeField: z.string().min(1).max(64).default('pecType'),
}).passthrough();

export type PecLegalArchiveConfig = z.infer<typeof PecLegalArchiveConfigSchema>;
