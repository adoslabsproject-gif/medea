/**
 * `action_odoo_lookup_partner` — executor.
 *
 * Strategy
 * ────────
 *   1. parseConfig.
 *   2. authenticate (cached).
 *   3. Build a SEARCH domain for the FIRST identifier present
 *      (email → vat → phone → name).
 *   4. search_read with the configured returnFields.
 *      • hit → return found=true.
 *      • miss + createIfMissing → create + return found=false, created=true.
 *      • miss + !createIfMissing → return found=false.
 *
 * @module actions/odoo_lookup_partner/executor
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
import { OdooLookupPartnerConfigSchema, type OdooLookupPartnerConfig } from './schema.js';

export const odooLookupPartnerExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const startedAt = Date.now();
  const parsed = parseConfig(OdooLookupPartnerConfigSchema, rawConfig);
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

  const domain = buildDomain(cfg);
  const returnFields = cfg.returnFields
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const kwargs: Record<string, OdooValue> = { fields: returnFields, limit: 1 };
  const found = (await executeKw(
    auth,
    uid,
    {
      model: 'res.partner',
      method: 'search_read',
      positional: [domain as OdooValue],
      kwargs,
    },
    transport,
    fetchOpts,
  )) as Record<string, OdooValue>[];

  if (found.length > 0) {
    return {
      output: { found: true, created: false, partner: found[0], partnerId: found[0]!.id },
      durationMs: Date.now() - startedAt,
    } satisfies NodeExecutionResult;
  }

  if (!cfg.createIfMissing) {
    return {
      output: { found: false, created: false, partner: null, partnerId: null },
      durationMs: Date.now() - startedAt,
    } satisfies NodeExecutionResult;
  }

  // ── create path ──
  const createValues = buildCreateValues(cfg);
  const newId = (await executeKw(
    auth,
    uid,
    {
      model: 'res.partner',
      method: 'create',
      positional: [createValues],
      kwargs: {},
    },
    transport,
    fetchOpts,
  )) as number;

  // Re-read with returnFields so downstream sees the same shape as the hit case.
  const created = (await executeKw(
    auth,
    uid,
    {
      model: 'res.partner',
      method: 'read',
      positional: [[newId]],
      kwargs: { fields: returnFields },
    },
    transport,
    fetchOpts,
  )) as Record<string, OdooValue>[];

  return {
    output: { found: false, created: true, partner: created[0] ?? { id: newId }, partnerId: newId },
    durationMs: Date.now() - startedAt,
  } satisfies NodeExecutionResult;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

type Domain = readonly OdooValue[];

export function buildDomain(cfg: OdooLookupPartnerConfig): Domain {
  const conds: OdooValue[] = [];
  if (cfg.email) conds.push(['email', '=ilike', cfg.email.trim()]);
  else if (cfg.vat) conds.push(['vat', '=', normaliseVat(cfg.vat)]);
  else if (cfg.phone) conds.push(['phone', '=', normalisePhone(cfg.phone)]);
  else if (cfg.name) conds.push(['name', 'ilike', cfg.name.trim()]);

  if (cfg.companyId) conds.push(['company_id', '=', cfg.companyId]);
  return Object.freeze(conds);
}

function buildCreateValues(cfg: OdooLookupPartnerConfig): Record<string, OdooValue> {
  const v: Record<string, OdooValue> = {};
  if (cfg.name) v.name = cfg.name.trim();
  else if (cfg.email) v.name = cfg.email.trim(); // schema enforces one of these
  if (cfg.email) v.email = cfg.email.trim();
  if (cfg.phone) v.phone = cfg.phone.trim();
  if (cfg.vat) v.vat = normaliseVat(cfg.vat);
  if (cfg.companyId) v.company_id = cfg.companyId;
  return v;
}

export function normaliseVat(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '').replace(/^IT/, '');
}

export function normalisePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}
