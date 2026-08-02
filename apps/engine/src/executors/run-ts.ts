/**
 * action_run_ts — TypeScript execution.
 *
 * Il TypeScript è un superset di JavaScript: lo eseguiamo **transpilando** il
 * sorgente a JS (strip dei soli tipi, nessun type-check a runtime) e poi
 * riusando ESATTAMENTE la sandbox isolated-vm di `action_run_js`
 * (`runInIsolate`) — stesse identiche garanzie di sicurezza, zero divergenze.
 *
 * Perché transpile-only (no type-check):
 *  - il type-check richiede l'intero program + lib.d.ts → lento e con
 *    dipendenze pesanti; qui vogliamo eseguire, non validare i tipi.
 *  - `ts.transpileModule` fa lo strip dei tipi in <50ms anche su 50KB, senza
 *    caricare il compilatore completo.
 *  - `typescript` è importato LAZY (`await import`) — MAI eager: un import
 *    statico di `typescript` fece crashare il bundle a boot (ERR_AMBIGUOUS_
 *    MODULE_SYNTAX, incident 2026-06-21). Vedi ast-security-scan.ts.
 *
 * Globali esposti nello script (identici a run_js): `input`, `vars`, `ctx`.
 * Lo script DEVE `return <value>` JSON-serializable.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { runInIsolate, clampNumber } from '@/lib/isolated-run.js';

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_MEM_MB = 16;
const MAX_MEM_MB = 512;
const MAX_CODE_BYTES = 50_000;

/**
 * Transpila TS → JS (solo strip dei tipi). Ritorna il JS o lancia un errore
 * `action_run_ts: errore sintassi TypeScript — …` sui diagnostics di parsing.
 */
async function transpileTs(code: string): Promise<string> {
  const ts = (await import('typescript')).default;
  const out = ts.transpileModule(code, {
    compilerOptions: {
      // ES2020: async/await, optional chaining, nullish — coerente col target
      // dell'isola V8. `module: None` → nessun wrapping CommonJS/ESM: l'output
      // resta un blocco di statement che runInIsolate avvolge in una funzione.
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      removeComments: false,
      // isolatedModules-style: nessun cross-file check, solo emit.
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });

  // Segnaliamo SOLO i diagnostics di parsing (categoria Error) — così un TS
  // sintatticamente rotto fallisce con un messaggio chiaro invece di produrre
  // JS spazzatura che poi esplode nell'isola. I diagnostics puramente di tipo
  // NON compaiono qui (transpileModule non fa type-check).
  const fatal = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    const msg = fatal
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join(' · ');
    throw new Error(`action_run_ts: errore sintassi TypeScript — ${msg}`);
  }
  return out.outputText;
}

export const runTsExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const cfg = rawConfig;
  const code = coerceString(cfg.code ?? '').trim();
  if (!code) throw new Error('action_run_ts: campo "code" obbligatorio.');
  if (code.length > MAX_CODE_BYTES) throw new Error('action_run_ts: codice troppo lungo (max 50KB).');

  const timeoutMs = clampNumber(cfg.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 5000);
  const memoryLimitMb = clampNumber(cfg.memoryLimitMb, MIN_MEM_MB, MAX_MEM_MB, 128);
  const vars = (context as unknown as { scope?: { vars?: unknown } }).scope?.vars ?? {};

  const jsCode = await transpileTs(code);

  const { result, durationMs } = await runInIsolate({
    code: jsCode,
    input: input ?? null,
    tenantId: context.tenantId,
    runId: context.runId ?? null,
    nodeId: context.nodeId ?? null,
    vars,
    timeoutMs,
    memoryLimitMb,
    nodeLabel: 'action_run_ts',
  });

  return { output: { result, durationMs }, durationMs };
};
