/**
 * action_run_js — JavaScript execution via isolated-vm in-process.
 *
 * No Docker overhead: sub-millisecond startup, suitable for hot-path data
 * transformations. Memory & timeout enforced by V8 isolate.
 *
 * Sandbox guarantees:
 *  - separate V8 isolate (no shared heap with host)
 *  - no require/import/fetch/process/eval (no host APIs at all)
 *  - memory limit (16-512 MB, default 128)
 *  - wall-clock timeout (100-30000 ms, default 5000)
 *  - script must `return <value>` (JSON-serializable)
 *
 * Exposed globals: input, vars, ctx (deep-cloned via ExternalCopy).
 *
 * AUDIT FIX RUNJS-1 (2026-06-09): esecuzione via `script.run()` ASYNC, non
 * `runSync()`. isolated-vm esegue l'isolate su un thread separato del pool
 * libuv → l'event-loop del container resta libero per tutta la durata dello
 * script (anche un busy-loop fino a 30s). Pre-fix `runSync` bloccava il main
 * thread: in un container per-tenant questo congelava SSE, health-check Docker
 * e run concorrenti dello stesso tenant — un workflow CPU-bound poteva far
 * fallire l'healthcheck e provocare un restart del container a metà esecuzione.
 * Stesso pattern già in uso nel community-node sandbox (`await script.run`).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { runInIsolate, clampNumber } from '@/lib/isolated-run.js';

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_MEM_MB = 16;
const MAX_MEM_MB = 512;

export const runJsExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const cfg = rawConfig;
  const code = coerceString(cfg.code ?? '').trim();
  if (!code) throw new Error('action_run_js: campo "code" obbligatorio.');
  if (code.length > 50_000) throw new Error('action_run_js: codice troppo lungo (max 50KB).');

  const timeoutMs = clampNumber(cfg.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 5000);
  const memoryLimitMb = clampNumber(cfg.memoryLimitMb, MIN_MEM_MB, MAX_MEM_MB, 128);
  const vars = (context as unknown as { scope?: { vars?: unknown } }).scope?.vars ?? {};

  const { result, durationMs } = await runInIsolate({
    code,
    input: input ?? null,
    tenantId: context.tenantId,
    runId: context.runId ?? null,
    nodeId: context.nodeId ?? null,
    vars,
    timeoutMs,
    memoryLimitMb,
    nodeLabel: 'action_run_js',
  });

  return { output: { result, durationMs }, durationMs };
};
