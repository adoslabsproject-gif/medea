/**
 * `action_odoo_create_lead` — executor.
 *
 * Pipeline
 * ────────
 *   1. parseConfig.
 *   2. authenticate (cached).
 *   3. Resolve tag many2many command (one `crm.tag.name_create` per tag).
 *   4. Build values dict + create on `<model>` (default `crm.lead`).
 *   5. read() with sensible default fields → return lead object.
 *
 * @module actions/odoo_create_lead/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { AbortedError } from '../../core/node-error.js';
import {
  authenticate,
  executeKw,
  type OdooAuth,
  type OdooValue,
} from '../../lib/odoo/xml-rpc-client.js';
import { makeSafeFetchOdooTransport } from '../../lib/odoo/safe-fetch-transport.js';
import { OdooCreateLeadConfigSchema, type OdooCreateLeadConfig } from './schema.js';

const RETURN_FIELDS = [
  'id',
  'name',
  'email_from',
  'phone',
  'partner_id',
  'tag_ids',
  'user_id',
  'team_id',
  'expected_revenue',
  'probability',
  'stage_id',
  'create_date',
];

export const odooCreateLeadExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const startedAt = Date.now();
  const parsed = parseConfig(OdooCreateLeadConfigSchema, rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;
  if (context.abortSignal?.aborted) throw new AbortedError();

  const auth: OdooAuth = {
    baseUrl: cfg.baseUrl,
    database: cfg.database,
    login: cfg.login,
    password: cfg.password,
  };
  const transport = makeSafeFetchOdooTransport(cfg.followRedirects);
  const signal = context.abortSignal;
  const fetchOpts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: cfg.timeoutMs };
  if (signal) fetchOpts.signal = signal;

  const uid = await authenticate(auth, transport, fetchOpts);

  // Resolve tag ids — search-then-create per name. Odoo's `name_create`
  // is NOT idempotent: it THROWS "Tag name already exists" on duplicate
  // (validated against Odoo 17 E2E 2026-06-04). We have to scan
  // `crm.tag` first and only call name_create when the tag truly doesn't
  // exist. Each tag is bounded by a single search_read with limit=1, so
  // the extra round-trip is cheap.
  const tagIds: number[] = [];
  if (cfg.tagNames && cfg.tagNames.length > 0) {
    for (const name of cfg.tagNames) {
      const existing = (await executeKw(
        auth,
        uid,
        {
          model: 'crm.tag',
          method: 'search_read',
          positional: [[['name', '=', name]]],
          kwargs: { fields: ['id'], limit: 1 },
        },
        transport,
        fetchOpts,
      )) as { id: number }[];
      if (existing.length > 0) {
        tagIds.push(existing[0]!.id);
        continue;
      }
      const created = (await executeKw(
        auth,
        uid,
        {
          model: 'crm.tag',
          method: 'name_create',
          positional: [name],
          kwargs: {},
        },
        transport,
        fetchOpts,
      )) as [number, string];
      if (Array.isArray(created) && typeof created[0] === 'number') {
        tagIds.push(created[0]);
      }
    }
  }

  const values = buildValues(cfg, tagIds);

  const newId = (await executeKw(
    auth,
    uid,
    {
      model: cfg.model,
      method: 'create',
      positional: [values],
      kwargs: {},
    },
    transport,
    fetchOpts,
  )) as number;

  const created = (await executeKw(
    auth,
    uid,
    {
      model: cfg.model,
      method: 'read',
      positional: [[newId]],
      kwargs: { fields: RETURN_FIELDS },
    },
    transport,
    fetchOpts,
  )) as Record<string, OdooValue>[];

  return {
    output: {
      success: true,
      leadId: newId,
      lead: created[0] ?? { id: newId },
      tagIds: Object.freeze(tagIds),
    },
    durationMs: Date.now() - startedAt,
  } satisfies NodeExecutionResult;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

export function buildValues(
  cfg: OdooCreateLeadConfig,
  tagIds: number[],
): Record<string, OdooValue> {
  const v: Record<string, OdooValue> = { name: cfg.name };
  if (cfg.emailFrom) v.email_from = cfg.emailFrom;
  if (cfg.phone) v.phone = cfg.phone;
  if (cfg.partnerName) v.partner_name = cfg.partnerName;
  if (cfg.description) v.description = cfg.description;
  if (cfg.partnerId) v.partner_id = cfg.partnerId;
  if (cfg.userId) v.user_id = cfg.userId;
  if (cfg.teamId) v.team_id = cfg.teamId;
  if (cfg.expectedRevenue !== undefined) v.expected_revenue = cfg.expectedRevenue;
  if (cfg.probability !== undefined) v.probability = cfg.probability;
  if (tagIds.length > 0) v.tag_ids = [[6, 0, tagIds]];
  return v;
}
