/**
 * `action_odoo_rpc` — executor.
 *
 * Flow
 * ────
 *   1. parseConfig → typed config (Zod cross-field validation for op-specific fields)
 *   2. Build a safe-fetch backed `OdooHttpTransport`
 *   3. authenticate(...) — returns uid (cached 5min in lib)
 *   4. Dispatch by operation → execute_kw with the right `(model, method, positional, kwargs)`
 *   5. Shape the NodeExecutionResult
 *
 * Error mapping
 * ─────────────
 *   • OdooFaultError (the server raised) → re-thrown as-is so the audit
 *     log shows the user-friendly fault string
 *   • OdooTransportError                 → mapped to HttpError when status
 *     is set, else NetworkError
 *   • TimeoutError / AbortedError        → already typed
 *
 * @module actions/odoo_rpc/executor
 */

import type { NodeExecutor, NodeExecutionResult } from '../../types.js';
import { parseConfig } from '../../core/config-parser.js';
import { HttpError, NetworkError, TimeoutError, AbortedError } from '../../core/node-error.js';
import {
  authenticate,
  executeKw,
  OdooFaultError,
  OdooTransportError,
  type OdooAuth,
  type OdooHttpTransport,
  type OdooValue,
} from '../../lib/odoo/xml-rpc-client.js';
import { makeSafeFetchOdooTransport } from '../../lib/odoo/safe-fetch-transport.js';
import { OdooRpcConfigSchema, type OdooRpcConfig } from './schema.js';

export const odooRpcExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const startedAt = Date.now();

  const parsed = parseConfig(OdooRpcConfigSchema, rawConfig);
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

  const steps: Record<string, unknown>[] = [];

  try {
    // ── Authenticate (cached) ──
    const authStartedAt = Date.now();
    const fetchOpts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: cfg.timeoutMs };
    if (signal) fetchOpts.signal = signal;
    const uid = await authenticate(auth, transport, fetchOpts);
    steps.push({
      name: 'authenticate',
      startedAt: authStartedAt,
      durationMs: Date.now() - authStartedAt,
      ok: true,
      evidence: { uid, cached: Date.now() - authStartedAt < 50 },
    });

    // ── Execute the chosen operation ──
    const execStartedAt = Date.now();
    const execOpts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: cfg.timeoutMs };
    if (signal) execOpts.signal = signal;
    const result = await dispatchOperation(cfg, auth, uid, transport, execOpts);
    steps.push({
      name: 'execute_kw',
      startedAt: execStartedAt,
      durationMs: Date.now() - execStartedAt,
      ok: true,
      evidence: {
        operation: cfg.operation,
        model: cfg.model,
        resultType: describeResultType(result),
      },
    });

    const output: Record<string, unknown> = {
      operation: cfg.operation,
      model: cfg.model,
      body: result,
    };
    if (cfg.operation === 'create' && typeof result === 'number') output.createdId = result;
    if (cfg.operation === 'write' || cfg.operation === 'unlink') output.success = result === true;
    if (cfg.operation === 'search_read' && Array.isArray(result)) output.count = result.length;
    if (cfg.includePipelineLog) output.pipelineSteps = steps;

    return { output, durationMs: Date.now() - startedAt } satisfies NodeExecutionResult;
  } catch (err) {
    if (context.abortSignal?.aborted && !(err instanceof AbortedError)) throw new AbortedError();
    if (err instanceof OdooFaultError) throw err; // surfaces the fault string verbatim
    if (err instanceof OdooTransportError) {
      const status = (err as OdooTransportError & { status?: number }).status;
      if (typeof status === 'number') {
        throw new HttpError({ status, statusText: err.message, url: cfg.baseUrl });
      }
      throw new NetworkError(err.message, { url: cfg.baseUrl, cause: err });
    }
    if (
      err instanceof TimeoutError ||
      err instanceof AbortedError ||
      err instanceof HttpError ||
      err instanceof NetworkError
    ) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NetworkError(msg, {
      url: cfg.baseUrl,
      ...(err instanceof Error ? { cause: err } : {}),
    });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Dispatch — one method per operation, identical inner shape
// ────────────────────────────────────────────────────────────────────────────

async function dispatchOperation(
  cfg: OdooRpcConfig,
  auth: OdooAuth,
  uid: number,
  transport: OdooHttpTransport,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<OdooValue> {
  switch (cfg.operation) {
    case 'search_read': {
      const kwargs: Record<string, OdooValue> = {};
      if (cfg.fieldsJson) kwargs.fields = cfg.fieldsJson;
      if (typeof cfg.limit === 'number') kwargs.limit = cfg.limit;
      if (typeof cfg.offset === 'number' && cfg.offset > 0) kwargs.offset = cfg.offset;
      if (cfg.order && cfg.order.trim() !== '') kwargs.order = cfg.order;
      return executeKw(
        auth,
        uid,
        {
          model: cfg.model,
          method: 'search_read',
          positional: [(cfg.domainJson ?? []) as OdooValue],
          kwargs,
        },
        transport,
        opts,
      );
    }
    case 'create': {
      return executeKw(
        auth,
        uid,
        {
          model: cfg.model,
          method: 'create',
          positional: [cfg.valuesJson as OdooValue],
        },
        transport,
        opts,
      );
    }
    case 'write': {
      return executeKw(
        auth,
        uid,
        {
          model: cfg.model,
          method: 'write',
          positional: [cfg.recordIdsJson as OdooValue, cfg.valuesJson as OdooValue],
        },
        transport,
        opts,
      );
    }
    case 'unlink': {
      return executeKw(
        auth,
        uid,
        {
          model: cfg.model,
          method: 'unlink',
          positional: [cfg.recordIdsJson as OdooValue],
        },
        transport,
        opts,
      );
    }
    case 'call_method': {
      return executeKw(
        auth,
        uid,
        {
          model: cfg.model,
          method: cfg.methodName!,
          // JSON-parsed values are by construction subsets of OdooValue
          // (string|number|boolean|null|array|object). The cast is sound.
          positional: (cfg.positionalJson ?? []) as readonly OdooValue[],
          kwargs: (cfg.kwargsJson ?? {}) as Readonly<Record<string, OdooValue>>,
        },
        transport,
        opts,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Small helper for evidence
// ────────────────────────────────────────────────────────────────────────────

function describeResultType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return `object(${keys.length})`;
  }
  return typeof v;
}
