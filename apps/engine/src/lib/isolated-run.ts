/**
 * runInIsolate — sandbox condivisa isolated-vm per l'esecuzione di codice
 * JavaScript user-provided.
 *
 * Estratta da executors/run-js.ts (2026-07-03) per essere condivisa tra
 * `action_run_js` (JS diretto) e `action_run_ts` (TypeScript → transpilato a
 * JS e poi eseguito qui). Zero divergenze di sicurezza tra i due nodi: la
 * stessa isola V8, gli stessi cap di memoria/timeout, le stesse garanzie di
 * assenza di host API.
 *
 * Garanzie sandbox (identiche a prima del refactor — vedi run-js.test.ts):
 *  - isola V8 separata (nessun heap condiviso con l'host)
 *  - niente require/import/fetch/process/eval (nessuna host API)
 *  - memory limit e wall-clock timeout applicati dall'isola
 *  - `script.run()` ASYNC su thread del pool libuv → l'event-loop del container
 *    non viene mai bloccato (AUDIT FIX RUNJS-1 2026-06-09), nemmeno da un
 *    busy-loop fino al timeout.
 *  - lo script DEVE `return <value>` JSON-serializable
 *
 * Globali esposti nello script: `input`, `vars`, `ctx` (deep-clone via
 * ExternalCopy). `ctx` è metadata-only (tenantId/runId/nodeId).
 */
import ivm from 'isolated-vm';

export interface IsolatedRunArgs {
  /** JS pronto all'esecuzione. Per il nodo TS è l'output della transpilazione. */
  code: string;
  input: unknown;
  tenantId: string;
  runId?: string | null;
  nodeId?: string | null;
  vars?: unknown;
  /** Già clampato dal chiamante. */
  timeoutMs: number;
  /** Già clampato dal chiamante. */
  memoryLimitMb: number;
  /**
   * Prefisso dei messaggi d'errore (es. `action_run_js` / `action_run_ts`) —
   * così l'utente sa QUALE nodo ha fallito senza perdere il testo storico.
   */
  nodeLabel: string;
}

export interface IsolatedRunResult {
  result: unknown;
  durationMs: number;
}

function copyIn(jail: ivm.Reference<Record<string, unknown>>, name: string, value: unknown): void {
  try {
    if (value === undefined) {
      jail.setSync(name, new ivm.ExternalCopy(null).copyInto());
    } else {
      jail.setSync(name, new ivm.ExternalCopy(value).copyInto());
    }
  } catch {
    jail.setSync(name, new ivm.ExternalCopy(null).copyInto());
  }
}

export async function runInIsolate(args: IsolatedRunArgs): Promise<IsolatedRunResult> {
  const start = Date.now();
  const isolate = new ivm.Isolate({ memoryLimit: args.memoryLimitMb });
  try {
    const ctx = isolate.createContextSync();
    const jail = ctx.global;

    copyIn(jail, 'input', args.input ?? null);
    const safeCtx = {
      tenantId: args.tenantId,
      runId: args.runId ?? null,
      nodeId: args.nodeId ?? null,
    };
    copyIn(jail, 'ctx', safeCtx);
    copyIn(jail, 'vars', args.vars ?? {});

    const wrapped = `(function(){ "use strict"; return (function(input, vars, ctx){ ${args.code} })(input, vars, ctx); })()`;

    let script: ivm.Script;
    try {
      script = isolate.compileScriptSync(wrapped);
    } catch (e) {
      throw new Error(
        `${args.nodeLabel}: errore sintassi — ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let result: unknown;
    try {
      result = await script.run(ctx, { timeout: args.timeoutMs, copy: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|timed out/i.test(msg)) {
        throw new Error(
          `${args.nodeLabel}: timeout — script ha superato ${String(args.timeoutMs)}ms`,
        );
      }
      if (/hit memory limit|memory/i.test(msg)) {
        throw new Error(`${args.nodeLabel}: memory limit ${String(args.memoryLimitMb)}MB superato`);
      }
      throw new Error(`${args.nodeLabel}: runtime error — ${msg}`);
    }

    return { result, durationMs: Date.now() - start };
  } finally {
    isolate.dispose();
  }
}

/** Clamp numerico riusabile (min/max/default) — condiviso da run-js e run-ts. */
export function clampNumber(raw: unknown, min: number, max: number, def: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}
