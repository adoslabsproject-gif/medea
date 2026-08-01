/**
 * Custom Node Editor — public types (Zod schemas + TS types).
 *
 * Single source of truth per:
 *   - Validation runtime (Zod)
 *   - Type inference compile-time (z.infer)
 *   - REST API contracts (route handlers usano questi schemi)
 *
 * Pattern enterprise: NO `any`, schemi strict (max length, regex slug, enum status),
 * preprocessing per trim/lowercase dove serve.
 *
 * @module services/custom-nodes/types
 */

import { z } from 'zod';
import type { CustomNodeRow, CustomNodeVersionRow, CustomNodeStatus } from '@/storage/schema.js';

// ─── Costanti policy (allineate ai CHECK SQL in migrate.schema.ts) ─────

/** Slug — kebab-case lowercase, 2-64 char. Unique per tenant. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const SLUG_MIN_LEN = 2;
export const SLUG_MAX_LEN = 64;

/** Semver semplificato (no pre-release/build tags per ora). */
export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Source code limits — anti-DoS al server compile (esbuild). */
export const SOURCE_MAX_BYTES = 256 * 1024;     // 256KB per file (executor/definition/schema)
export const ICON_SVG_MAX_BYTES = 32 * 1024;    // 32KB inline SVG

/** Test runs ring buffer — N max conservati in DB. */
export const TEST_RUNS_RING_SIZE = 20;

export const CUSTOM_NODE_STATUSES = [
  'draft',
  'candidate',
  'published_priv',
  'marketplace_pending',
  'marketplace_published',
  'archived',
] as const satisfies readonly CustomNodeStatus[];

export const CUSTOM_NODE_CATEGORIES = [
  'AI Agents',
  'Database',
  'Email',
  'File Transform',
  'HTTP / Webhooks',
  'Italian Integration',
  'DevOps',
  'Security',
  'Multimedia',
  'Custom',
] as const;

// ─── Zod schemas ────────────────────────────────────────────────────────

const slugField = z
  .string()
  .min(SLUG_MIN_LEN, `slug min ${SLUG_MIN_LEN} chars`)
  .max(SLUG_MAX_LEN, `slug max ${SLUG_MAX_LEN} chars`)
  .regex(SLUG_RE, 'slug must be lowercase kebab-case (a-z, 0-9, _, -)');

// Reserved for future API contract validating client-supplied semver (publish)
export const semverField = z.string().regex(SEMVER_RE, 'semver must be X.Y.Z');

const sourceField = z
  .string()
  .max(SOURCE_MAX_BYTES, `max ${SOURCE_MAX_BYTES} bytes`);

const iconSvgField = z
  .string()
  .max(ICON_SVG_MAX_BYTES)
  .optional();

export const CustomNodeCreateInputSchema = z.object({
  slug: slugField,
  displayName: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  iconSvg: iconSvgField,
  category: z.enum(CUSTOM_NODE_CATEGORIES).optional(),
  sourceExecutor: sourceField,
  sourceDefinition: sourceField,
  sourceSchema: sourceField,
});
export type CustomNodeCreateInput = z.infer<typeof CustomNodeCreateInputSchema>;

export const CustomNodeUpdateInputSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  iconSvg: iconSvgField,
  category: z.enum(CUSTOM_NODE_CATEGORIES).optional(),
  sourceExecutor: sourceField.optional(),
  sourceDefinition: sourceField.optional(),
  sourceSchema: sourceField.optional(),
  /** Bump semver — patch (0.0.1), minor (0.1.0), major (1.0.0). Auto se omesso. */
  semverBump: z.enum(['patch', 'minor', 'major']).optional(),
  /** Nota human-readable per la version history. */
  changelog: z.string().max(500).optional(),
});
export type CustomNodeUpdateInput = z.infer<typeof CustomNodeUpdateInputSchema>;

export const CustomNodeListFilterSchema = z.object({
  status: z.enum(CUSTOM_NODE_STATUSES).optional(),
  category: z.enum(CUSTOM_NODE_CATEGORIES).optional(),
  ownerUserId: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type CustomNodeListFilter = z.infer<typeof CustomNodeListFilterSchema>;

export const TestRunInputSchema = z.object({
  config: z.unknown(),
  input: z.unknown(),
});
export type TestRunInput = z.infer<typeof TestRunInputSchema>;

export interface TestRunRecord {
  at: string;                // ISO timestamp
  input: unknown;
  output: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info';
  line: number;
  col: number;
  message: string;
  code?: string;
  file: 'executor' | 'definition' | 'schema';
}

// ─── Domain types (re-export DB rows con shape friendly) ───────────────

export interface CustomNode extends Omit<CustomNodeRow, 'status' | 'compileWarnings' | 'testRuns'> {
  status: CustomNodeStatus;
  compileWarnings: CompileDiagnostic[];
  testRuns: TestRunRecord[];
}

export type CustomNodeVersion = CustomNodeVersionRow;

/** Lightweight view per liste — esclude i source che possono essere 256KB cad. */
export type CustomNodeSummary = Pick<
  CustomNode,
  | 'id' | 'workspaceId' | 'ownerUserId' | 'slug' | 'displayName'
  | 'description' | 'iconSvg' | 'category' | 'semver' | 'status'
  | 'compileAt' | 'marketplaceSubmittedAt' | 'marketplacePublishedAt'
  | 'createdAt' | 'updatedAt'
>;
