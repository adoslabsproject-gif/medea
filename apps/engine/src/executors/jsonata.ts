import jsonata from 'jsonata';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';

/** Tetto di esecuzione (wall-clock) di un'espressione JSONata (override via env nei test). */
const JSONATA_TIMEOUT_MS_DEFAULT = 5_000;
function jsonataTimeoutMs(): number {
  const raw = Number(process.env.FLOWFORGE_JSONATA_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : JSONATA_TIMEOUT_MS_DEFAULT;
}
/** Profondità massima di valutazione (anti ricorsione non-terminante / stack overflow). */
const JSONATA_MAX_DEPTH = 500;

type JsonataExpr = ReturnType<typeof jsonata>;

/**
 * jsonata 2.x cerca i callback di timeboxing sotto chiavi **Symbol**
 * (`Symbol.for('jsonata.__evaluate_{entry,exit}')`, vedi jsonata.js). Il tipo pubblico
 * di `assign()` dichiara `name: string`, ma il `bind()` interno usa `Object.create(null)`
 * e accetta qualsiasi chiave (anche Symbol). Cast TIPIZZATO (no `any`) per registrarli.
 */
function assignSymbolCallback(expr: JsonataExpr, sym: symbol, cb: () => void): void {
  (expr.assign as unknown as (name: symbol, value: () => void) => void)(sym, cb);
}

/**
 * Timeboxing UFFICIALE JSONata (README "Timeboxing expression evaluation"): i callback
 * `__evaluate_entry`/`__evaluate_exit` sono invocati dall'interprete a OGNI passo di
 * valutazione → impongono un limite di TEMPO e di PROFONDITÀ. Senza, un'espressione
 * autore (ricorsione/loop o map su dati enormi) occuperebbe la CPU del container tenant
 * a tempo indefinito = DoS.
 */
function timeboxExpression(expr: JsonataExpr, timeoutMs: number, maxDepth: number): void {
  let depth = 0;
  const time = Date.now();
  const checkRunaway = (): void => {
    if (depth > maxDepth) {
      throw new Error(`JSONata: profondità massima superata (${maxDepth}) — possibile ricorsione non-terminante`);
    }
    if (Date.now() - time > timeoutMs) {
      throw new Error(`JSONata: timeout di valutazione (${timeoutMs}ms) — possibile loop infinito o espressione troppo costosa`);
    }
  };
  assignSymbolCallback(expr, Symbol.for('jsonata.__evaluate_entry'), () => { depth++; checkRunaway(); });
  assignSymbolCallback(expr, Symbol.for('jsonata.__evaluate_exit'), () => { depth--; checkRunaway(); });
}

export const jsonataExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const expression = typeof config.expression === 'string' ? config.expression : '';
  if (!expression) throw new Error('logic_transform: missing required "expression" config');

  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(expression);
  } catch (err) {
    throw new Error(`JSONata compile error: ${err instanceof Error ? err.message : String(err)}`);
  }
  timeboxExpression(compiled, jsonataTimeoutMs(), JSONATA_MAX_DEPTH);

  const evalInput = typeof input === 'string' ? safeParse(input) : input;

  // Espongo $node come bindings JSONata in modo che espressioni tipo
  // `$node.contact_discovery.json.domain` funzionino. Stessa convenzione
  // dei template `{{$node.<id>.json.field}}` (interpreter li riscrive a
  // `vars["<id>"]`), ma per JSONata dobbiamo passare le bindings esplicite.
  //
  // Shape: `{ <nodeId>: { json: <output> } }` — il `.json` wrapper è
  // intenzionale: corrisponde alla "JSON view" del payload del nodo
  // (uso storico nei template) e permette future estensioni come
  // `$node.X.binary`, `$node.X.headers`, ecc.
  //
  // Pre-fix (commit 25 mag 2026): le bindings erano vuote → ogni
  // riferimento a $node ritornava undefined → un workflow reale
  // detect_lang cadeva sempre al fallback "en" anche per .it.
  const nodeBindings: Record<string, { json: unknown }> = {};
  if (context.nodeOutputs) {
    for (const [id, output] of Object.entries(context.nodeOutputs)) {
      nodeBindings[id] = { json: output };
    }
  }

  let output: unknown;
  try {
    output = await compiled.evaluate(evalInput, { node: nodeBindings });
  } catch (err) {
    throw new Error(`JSONata eval error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { output, durationMs: Date.now() - start };
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
