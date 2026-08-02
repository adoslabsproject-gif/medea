/**
 * `action_odoo_update_activity` — executor.
 *
 * Flow
 * ────
 *   1. authenticate.
 *   2. Resolve activity_type_id:
 *        • when numeric set → use as-is
 *        • when name set    → search mail.activity.type for matching name
 *   3. Resolve res_model_id from ir.model (mail.activity needs both
 *      `res_model` STRING and `res_model_id` INT for proper linking).
 *   4. create on mail.activity with the values dict.
 *
 * @module actions/odoo_update_activity/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { AbortedError, ValidationError } from '../../core/node-error.js';
import {
  authenticate,
  executeKw,
  type OdooAuth,
  type OdooValue,
} from '../../lib/odoo/xml-rpc-client.js';
import { makeSafeFetchOdooTransport } from '../../lib/odoo/safe-fetch-transport.js';
import { OdooUpdateActivityConfigSchema } from './schema.js';

export const odooUpdateActivityExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const startedAt = Date.now();
  const parsed = parseConfig(OdooUpdateActivityConfigSchema, rawConfig);
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

  // Resolve activity_type_id.
  let activityTypeId = cfg.activityTypeId ?? null;
  if (activityTypeId === null && cfg.activityTypeName) {
    const found = (await executeKw(
      auth,
      uid,
      {
        model: 'mail.activity.type',
        method: 'search_read',
        positional: [[['name', '=', cfg.activityTypeName]]],
        kwargs: { fields: ['id'], limit: 1 },
      },
      transport,
      fetchOpts,
    )) as { id: number }[];
    if (found.length === 0) {
      throw new ValidationError(
        `ODOO_ACTIVITY_TYPE_NOT_FOUND: "${cfg.activityTypeName}" — pass activityTypeId numeric instead`,
      );
    }
    activityTypeId = found[0]!.id;
  }
  if (activityTypeId === null) {
    // Schema cross-field already enforces one is present — defensive.
    throw new ValidationError('ODOO_ACTIVITY_TYPE_MISSING');
  }

  // Resolve res_model_id (mail.activity needs both res_model and res_model_id).
  const irModel = (await executeKw(
    auth,
    uid,
    {
      model: 'ir.model',
      method: 'search_read',
      positional: [[['model', '=', cfg.resModel]]],
      kwargs: { fields: ['id'], limit: 1 },
    },
    transport,
    fetchOpts,
  )) as { id: number }[];
  if (irModel.length === 0) {
    throw new ValidationError(`ODOO_MODEL_NOT_FOUND: "${cfg.resModel}"`);
  }
  const resModelId = irModel[0]!.id;

  const values: Record<string, OdooValue> = {
    res_model: cfg.resModel,
    res_model_id: resModelId,
    res_id: cfg.resId,
    activity_type_id: activityTypeId,
    summary: cfg.summary,
  };
  if (cfg.noteHtml) values.note = cfg.noteHtml;
  if (cfg.dateDeadline) values.date_deadline = cfg.dateDeadline;
  if (cfg.userId) values.user_id = cfg.userId;

  const newId = (await executeKw(
    auth,
    uid,
    {
      model: 'mail.activity',
      method: 'create',
      positional: [values],
      kwargs: {},
    },
    transport,
    fetchOpts,
  )) as number;

  return {
    output: {
      success: true,
      activityId: newId,
      activityTypeId,
      resModel: cfg.resModel,
      resId: cfg.resId,
    },
    durationMs: Date.now() - startedAt,
  } satisfies NodeExecutionResult;
};
