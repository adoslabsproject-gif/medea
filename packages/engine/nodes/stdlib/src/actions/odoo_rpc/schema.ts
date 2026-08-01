/**
 * `action_odoo_rpc` — Zod config schema (parse-once).
 *
 * Operations supported (one node, five workflows)
 * ───────────────────────────────────────────────
 *   search_read  — SELECT-like: domain + fields + limit/offset/order
 *   create       — INSERT: model + values → new id
 *   write        — UPDATE: ids + values → boolean
 *   unlink       — DELETE: ids → boolean
 *   call_method  — escape hatch: any model.method with positional + kwargs
 *
 * Why a single polymorphic node (not five separate ones)
 * ──────────────────────────────────────────────────────
 * The auth fields (baseUrl, database, login, password/api-key) are identical
 * across all five. Splitting would push the workflow author to re-enter them
 * five times — terrible UX. The `operation` field gates the rest with
 * `showIf` so the drawer feels like five distinct nodes from the inside.
 *
 * Validation discipline
 * ─────────────────────
 * Cross-field rules:
 *   • mode=search_read → `model` required, optional `domain`/`fields`/`limit`
 *   • mode=create      → `model` + `valuesJson` required (must parse to object)
 *   • mode=write       → `model` + `recordIds` + `valuesJson` required
 *   • mode=unlink      → `model` + `recordIds` required
 *   • mode=call_method → `model` + `methodName` required, `positionalJson`/`kwargsJson` optional
 *
 * @module actions/odoo_rpc/schema
 */

import { z } from 'zod';
import { ValidationError } from '../../core/node-error.js';

const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
]);

export const ODOO_OPERATIONS = ['search_read', 'create', 'write', 'unlink', 'call_method'] as const;
export type OdooOperation = typeof ODOO_OPERATIONS[number];

const httpsUrl = z.string()
  .min(1)
  .refine((s) => /^https?:\/\//i.test(s), { message: 'baseUrl must be http(s)://' });

// `res.partner`, `account.move.line`, `crm.lead` etc — letters + underscores + dots.
const modelName = z.string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_.]*$/i, 'model: lowercase ident with dots, e.g. res.partner');

const methodName = z.string()
  .min(1)
  .max(120)
  .regex(/^[a-z_][a-z0-9_]*$/i, 'method: identifier (letters, digits, underscore)');

// JSON string with parse-validation. We accept both the empty-string and
// `null`/`undefined` shapes that the editor emits for unset fields.
function jsonStringOf<T>(parser: (raw: unknown) => T, requiredShape: string) {
  return z.string().optional().default('').transform((raw, ctx) => {
    if (!raw || raw.trim() === '') return undefined as unknown as T;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parser(parsed);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid JSON for ${requiredShape}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return z.NEVER;
    }
  });
}

const domainArray = jsonStringOf<unknown[]>((p) => {
  if (!Array.isArray(p)) throw new ValidationError(`odoo_rpc: domain must be a JSON array of triples`, { field: "domain" });
  return p;
}, 'domain (array)');

const fieldsArray = jsonStringOf<string[]>((p) => {
  if (!Array.isArray(p)) throw new ValidationError(`odoo_rpc: fields must be a JSON array of strings`, { field: "fields" });
  for (const x of p) if (typeof x !== 'string') throw new ValidationError(`odoo_rpc: every field must be a string`, { field: "fields" });
  return p as string[];
}, 'fields (array of strings)');

const valuesObject = jsonStringOf<Record<string, unknown>>((p) => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new ValidationError(`odoo_rpc: values must be a JSON object`, { field: "values" });
  }
  return p as Record<string, unknown>;
}, 'values (object)');

const idsArray = jsonStringOf<number[]>((p) => {
  if (!Array.isArray(p)) throw new ValidationError(`odoo_rpc: recordIds must be a JSON array of positive integers`, { field: "recordIds" });
  const out: number[] = [];
  for (const x of p) {
    const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? parseInt(x, 10) : NaN;
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`odoo_rpc: every recordId must be a positive integer`, { field: "recordIds" });
    out.push(n);
  }
  return out;
}, 'recordIds (array of positive integers)');

const positionalArray = jsonStringOf<unknown[]>((p) => {
  if (!Array.isArray(p)) throw new ValidationError(`odoo_rpc: positional must be a JSON array`, { field: "positional" });
  return p;
}, 'positional args (array)');

const kwargsObject = jsonStringOf<Record<string, unknown>>((p) => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new ValidationError(`odoo_rpc: kwargs must be a JSON object`, { field: "kwargs" });
  }
  return p as Record<string, unknown>;
}, 'kwargs (object)');

export const OdooRpcConfigSchema = z.object({
  // ── Authentication
  baseUrl: httpsUrl,
  database: z.string().min(1, 'database required').max(120),
  login: z.string().min(1, 'login required').max(200),
  /**
   * Password OR API key. Odoo 14+ supports `user.api-key` records that
   * bypass 2FA and don't expire — strongly recommended for server-to-server.
   */
  password: z.string().min(1, 'password / api key required').max(500),

  // ── What to do
  operation: z.enum(ODOO_OPERATIONS).default('search_read'),
  model: modelName,

  // ── search_read
  domainJson: domainArray.optional(),
  fieldsJson: fieldsArray.optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0).optional(),
  order: z.string().max(200).optional(),

  // ── create / write
  valuesJson: valuesObject.optional(),

  // ── write / unlink
  recordIdsJson: idsArray.optional(),

  // ── call_method
  methodName: methodName.optional(),
  positionalJson: positionalArray.optional(),
  kwargsJson: kwargsObject.optional(),

  // ── HTTP knobs
  timeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  followRedirects: boolish.default(true),

  /** Embed pipelineSteps in the output. */
  includePipelineLog: boolish.default(true),
}).passthrough().superRefine((cfg, ctx) => {
  const addRequired = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };

  switch (cfg.operation) {
    case 'search_read':
      // domain optional (defaults to `[]`), fields optional (defaults to all)
      break;
    case 'create':
      if (!cfg.valuesJson) addRequired(['valuesJson'], 'values is required for operation=create');
      break;
    case 'write':
      if (!cfg.recordIdsJson || cfg.recordIdsJson.length === 0) {
        addRequired(['recordIdsJson'], 'recordIds is required for operation=write');
      }
      if (!cfg.valuesJson) addRequired(['valuesJson'], 'values is required for operation=write');
      break;
    case 'unlink':
      if (!cfg.recordIdsJson || cfg.recordIdsJson.length === 0) {
        addRequired(['recordIdsJson'], 'recordIds is required for operation=unlink');
      }
      break;
    case 'call_method':
      if (!cfg.methodName) addRequired(['methodName'], 'methodName is required for operation=call_method');
      break;
  }
});

export type OdooRpcConfig = z.infer<typeof OdooRpcConfigSchema>;
