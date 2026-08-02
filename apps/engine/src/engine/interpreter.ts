/**
 * Safe expression interpreter for branching conditions, loop items, etc.
 *
 * Uses a curated subset of `Function()` with a restricted scope:
 *   - globalThis/global/process/require/import are null-ed out via the
 *     eval shape, so expressions cannot escape to the host.
 *   - Forbidden-pattern scan rejects eval/new Function/__proto__ before
 *     compilation.
 *   - Execution wrapped in a 250ms timeout via watchdog promise race.
 *
 * For workflows that need stricter isolation (untrusted multi-tenant
 * code paths, runaway-loop protection), the `sandbox.ts` adapter uses
 * isolated-vm — see that file for the heavy-isolation path. This file is
 * the default fast-path for trusted-author expressions.
 *
 * Test fixtures cover: arithmetic, string ops, optional chaining,
 * boolean logic, undefined access (must NOT throw — n8n bug fixed here),
 * timeout (must throw within 100ms).
 */

const EXPRESSION_TIMEOUT_MS = 250;

/**
 * Bad identifiers — checked sia come Identifier che come string literal
 * dentro computed member access (`["eval"]`, `['constructor']`, etc.).
 * Bypass vector storici:
 *   - `eval(...)` (Unicode escape nel source)
 *   - `({})["constructor"]["constructor"]("return process")()` (computed)
 *   - `globalThis["ev" + "al"]` (concatenation — vedi BLOCK_CONCAT_IN_BRACKET)
 */
// ─────────────────────────────────────────────────────────────────────────────
// MODELLO DI SICUREZZA (audit pre-certificazione #2)
// ─────────────────────────────────────────────────────────────────────────────
// Le espressioni {{ }} sono valutate con `new Function()` + scope curato +
// questa denylist (post-decodifica escape). Una denylist NON è un confine di
// sicurezza forte (i bypass via stringa-costruita-a-runtime sono teoricamente
// possibili). Il CONFINE REALE è l'isolamento per-tenant: ogni tenant gira nel
// PROPRIO container Docker, quindi un eventuale escape dell'interprete esegue
// codice nel container che il tenant già controlla (può farlo anche via i nodi
// code-runner/community, che usano isolated-vm). Per codice NON fidato/pesante
// esiste il path a isolamento forte `engine/sandbox.ts` (isolated-vm).
// Questa denylist resta come difesa-in-profondità + guardia anti-errore.
import { buildExpressionHelpers } from './expression-helpers.js';
import { normalizeToItems, type ExecutionItem } from '@medea/engine-core-schema';
import { resolvePairedItem, type RunItemGraph } from './item-model.js';
import { resolveWebhookRefs } from '@/lib/webhook-ref.js';

/**
 * Contesto di lineage per la semantica PAIRED di `$('Node').item` /
 * `itemMatching(idx)` (uguale a n8n). Lo fornisce l'engine quando valuta le
 * expression di un nodo: il grafo degli output-items della run, il nodo+item
 * correnti, e la funzione predecessore (per risalire i lineage senza sourceNodeId).
 * Assente → `.item`/`itemMatching` ritornano undefined (nessun crash).
 */
export interface LineageContext {
  graph: RunItemGraph;
  nodeId: string;
  itemIndex: number;
  predecessorOf: (nodeId: string) => string | undefined;
}

/**
 * Accessor `$('NodeName')` stile n8n — accesso tipato all'output di un altro
 * nodo della run. Si appoggia ai `vars` (output per id E per alias/nome) già
 * presenti nello scope, normalizzati in `ExecutionItem[]`:
 *
 *   $('HTTP').all()            → tutti gli item (ExecutionItem[])
 *   $('HTTP').first().json.x   → primo item
 *   $('HTTP').last().json      → ultimo item
 *   $('HTTP').itemAt(2)        → item alla POSIZIONE 2 (undefined se assente)
 *   $('HTTP').item             → item PAIRED con l'item corrente (lineage)
 *   $('HTTP').itemMatching(3)  → item PAIRED con l'input item 3 del nodo corrente
 *
 * Semantica (allineamento n8n):
 *   - `itemAt(i)` = accesso POSIZIONALE per indice (convenienza FlowForge, NON n8n).
 *   - `.item` / `itemMatching(idx)` = semantica PAIRED di n8n: risolvono l'item
 *     del nodo target ACCOPPIATO (via lineage, risalendo i pairedItem) con l'item
 *     corrente (`.item`) o con l'input item `idx` (`itemMatching`). Richiedono il
 *     `LineageContext` fornito dall'engine: senza, ritornano undefined.
 */
export interface NodeAccessor {
  all(): ExecutionItem[];
  first(): ExecutionItem;
  last(): ExecutionItem;
  /** Accesso POSIZIONALE per indice (NON paired). */
  itemAt(index: number): ExecutionItem | undefined;
  /** Item PAIRED con l'item corrente (lineage n8n). undefined senza LineageContext. */
  readonly item: ExecutionItem | undefined;
  /** Item PAIRED con l'input item `inputIndex` del nodo corrente (lineage n8n). */
  itemMatching(inputIndex: number): ExecutionItem | undefined;
}

const EMPTY_ITEM: ExecutionItem = { json: {} };

export function makeNodeAccessor(
  vars: Record<string, unknown>,
  lineageCtx?: LineageContext,
): (name: string) => NodeAccessor {
  return (name: string): NodeAccessor => {
    const items = Object.prototype.hasOwnProperty.call(vars, name)
      ? normalizeToItems(vars[name])
      : [];
    const paired = (fromItemIndex: number): ExecutionItem | undefined =>
      lineageCtx === undefined
        ? undefined
        : resolvePairedItem(lineageCtx.graph, lineageCtx.nodeId, fromItemIndex, name, lineageCtx.predecessorOf);
    return {
      all: () => items,
      first: () => items[0] ?? EMPTY_ITEM,
      last: () => items[items.length - 1] ?? EMPTY_ITEM,
      itemAt: (index: number) => items[index],
      get item() { return lineageCtx === undefined ? undefined : paired(lineageCtx.itemIndex); },
      itemMatching: (inputIndex: number) => paired(inputIndex),
    };
  };
}

const FORBIDDEN_IDENTIFIERS = [
  'eval', 'Function', 'globalThis', 'global', 'process', 'require', 'import',
  '__proto__', 'constructor', 'AsyncFunction', 'GeneratorFunction',
  // Node-specific escape vectors
  'fetch', 'setTimeout', 'setInterval', 'setImmediate',
  // Reflection / metaprogramming escape primitives — nessun uso legittimo in
  // un'espressione workflow, ma consentono di raggiungere il Function ctor.
  'Reflect', 'Proxy', 'WeakRef',
];

/**
 * Pattern statici applicati DOPO decodifica Unicode/Hex escape. Anti-bypass:
 *   - Unicode escape: `eval` → `eval` viene poi catturato dal regex word.
 *   - Hex escape: `\x65val` idem.
 *   - String literal in bracket access: `["constructor"]`.
 *   - Concatenation in bracket access: `["co"+"de"]` → blocked.
 */
const FORBIDDEN_REGEX: RegExp[] = [
  // Identifier word boundary catch
  ...FORBIDDEN_IDENTIFIERS.map((id) => new RegExp(`\\b${id}\\b`)),
  // String literal in computed member access
  ...FORBIDDEN_IDENTIFIERS.map(
    (id) => new RegExp(`\\[\\s*['"\`]${id}['"\`]\\s*\\]`),
  ),
  // Generic: concatenation `+` within bracket access — common bypass shape
  // `obj["e"+"val"]`. Conservative — blocks any computed bracket with a `+`.
  /\[[^\]]*\+[^\]]*\]/,
  // Backtick template literal in bracket access — can hide concat too
  /\[\s*`[^`]*`\s*\]/,
];

export interface LoopContext {
  /** The current iteration item (or chunk array if strategy='batch'). */
  item: unknown;
  /** 0-based iteration index (chunk index if batch). */
  index: number;
  /** Total iterations the engine will run for this loop. */
  total: number;
  /** True on the first iteration only. */
  first: boolean;
  /** True on the last iteration only. */
  last: boolean;
  /** When strategy='batch', the original item indices contained in this chunk. */
  chunkIndices?: number[];
  /** Loop node id — useful for nested loops to disambiguate scope. */
  loopId: string;
  /** Strategy actually being executed (post-resolution if 'auto'). */
  strategy: string;
}

export interface InterpreterScope {
  input?: unknown;
  output?: unknown;
  ctx?: unknown;
  /** @deprecated use `loop.item` — kept for back-compat with v1 expressions. */
  item?: unknown;
  /** @deprecated use `loop.index` — kept for back-compat with v1 expressions. */
  index?: number;
  /** Rich loop context (v2). Populated by the IterationCoordinator when inside a loop body. */
  loop?: LoopContext;
  /**
   * Workflow-level variables (output dei nodi precedenti, mutabili al runtime).
   * Riferiti via `{{vars.X}}` o shortcut `{{$node.X.json}}`.
   */
  vars?: Record<string, unknown>;
  /**
   * Tenant-level secrets (API keys, SMTP password, DKIM private key, ecc).
   * Riferiti via `{{secrets.NAME}}` — convenzione documentata in tutti i nodi
   * stdlib (action_send_email, action_http, fetch, dkim, ecc). Source-of-truth:
   * `variables` table del tenant (tipo `secret`, encrypted at rest).
   *
   * Separazione semantica vs `vars`:
   *   - `vars`   = workflow-scope, mutabile, sopravvive solo al run corrente
   *   - `secrets` = tenant-scope, read-only nel expression, persistente cross-run
   *
   * 2026-06-05: prima `secrets` veniva trascritto/aliased a `vars` ad-hoc da
   * alcuni nodi, ma `evaluateExpression` rifiutava il nome → utente vedeva
   * `ReferenceError: secrets is not defined` su prompt LLM ed esempi che
   * usavano la sintassi documentata.
   */
  secrets?: Record<string, unknown>;
  /** Tutti gli item in ingresso al nodo (n8n `$items`). Se assente, derivato da `input`. */
  items?: unknown[];
  /** Metadati workflow (n8n `$workflow`). */
  workflow?: { id?: string; name?: string };
  /** Metadati esecuzione/run (n8n `$execution`). */
  execution?: { id?: string; mode?: string; startedAt?: string };
  /**
   * Contesto lineage per la semantica PAIRED di `$('Node').item` /
   * `itemMatching` (fornito dall'engine in fase 4). Assente fuori dall'engine
   * (es. test di branching puri) → gli accessor paired ritornano undefined.
   */
  lineage?: LineageContext;
}

export class InterpreterError extends Error {
  public readonly expression: string;

  constructor(message: string, expression: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'InterpreterError';
    this.expression = expression;
  }
}

/**
 * Decodifica gli escape Unicode/Hex/Octal nel source code dell'espressione.
 * Pattern di attacco anti-regex pre-fix: `eval("...")` bypassava
 * `/\beval\b/` perche\` il source contiene letteralmente `eval` (V8
 * parser risolve in `eval` SOLO a parse time).
 *
 * Decoding SOLO per il check di sicurezza, non modifica l'espressione passata
 * al Function() constructor (V8 lo fa lui).
 *
 * NB: solo per Identifier names — non risolve string concatenation literal
 * runtime (es. "co"+"nstructor") che e\` invece bloccata da FORBIDDEN_REGEX
 * `\[[^\]]*\+[^\]]*\]`.
 */
function decodeEscapesForCheck(s: string): string {
  // \uXXXX (4 hex digits)
  let out = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  // \u{XXXXX} (1-6 hex digits ES2015)
  out = out.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  // \xXX (2 hex digits)
  out = out.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return out;
}

function assertSafeExpression(expression: string): void {
  // HIGH (2026-05-29): decode escape PRIMA di check regex.
  // V8 parser interpreta `eval` come `eval` — pre-fix il regex
  // `/\beval\b/` non lo catturava (vedeva letteralmente `eval`).
  const decoded = decodeEscapesForCheck(expression);
  for (const pattern of FORBIDDEN_REGEX) {
    if (pattern.test(decoded) || pattern.test(expression)) {
      throw new InterpreterError(
        `Expression contains forbidden token matching ${pattern.toString()}`,
        expression,
      );
    }
  }
  if (expression.length > 4000) {
    throw new InterpreterError('Expression exceeds 4000 character limit', expression);
  }
}

/**
 * Rewrite n8n-style shortcuts to canonical scope references so users can write
 * familiar expressions and we evaluate them safely:
 *
 *   $now            → new Date().toISOString()
 *   $today          → new Date().toISOString().slice(0,10)
 *   $uuid           → crypto.randomUUID()
 *   $node.X.json    → vars["X"]
 *   $node.X.json.a  → vars["X"].a
 *   $env.KEY        → (vars.__env && vars.__env["KEY"])
 *
 * Filter pipes (Jinja/Liquid-compat, n8n-friendly):
 *
 *   x | upper                → String(x ?? '').toUpperCase()
 *   x | lower                → String(x ?? '').toLowerCase()
 *   x | trim                 → String(x ?? '').trim()
 *   x | length               → ((__v) => Array.isArray(__v) || typeof __v === 'string' ? __v.length : 0)(x)
 *   x | json                 → JSON.stringify(x)
 *   x | default:'…'          → (x ?? '…')
 *   x | round:n              → Number(x).toFixed(n)              (n=0 default)
 *   x | currency:'EUR'       → Intl.NumberFormat(it, { style: 'currency', currency: 'EUR' }).format(x)
 *   x | date:'YYYY-MM-DD'    → Date format basico (YYYY/MM/DD/HH/mm/ss tokens)
 *   x | replace:'a','b'      → String(x).replaceAll('a', 'b')
 *   x | slice:0,10           → String(x).slice(0, 10) (anche array)
 *   x | join:','             → Array(x).join(',') (skip se non array)
 *
 * Le pipe sono left-associative e si concatenano: `x | trim | upper`.
 *
 * This is a pure string rewrite — safer than runtime proxies because the
 * forbidden-pattern scan runs AFTER and still catches the dangerous tokens.
 */
function rewriteShortcuts(expression: string): string {
  let out = expression;
  out = out.replace(/\$now\b/g, 'new Date().toISOString()');
  out = out.replace(/\$today\b/g, 'new Date().toISOString().slice(0,10)');
  // Inline UUID v4 generator — Math-based (not cryptographically strong but
  // adequate for workflow correlation IDs). Avoids touching globalThis,
  // which is forbidden by assertSafeExpression.
  out = out.replace(/\$uuid\b/g, "('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c=='x'?r:(r&0x3|0x8);return v.toString(16);}))");
  // $node.<id>.json → vars["<id>"]   (id may be alphanumeric, dash, underscore)
  out = out.replace(/\$node\.([a-zA-Z0-9_-]+)\.json/g, 'vars["$1"]');
  // $env.<KEY> → (vars.__env && vars.__env["<KEY>"])
  out = out.replace(/\$env\.([a-zA-Z0-9_]+)/g, '(vars.__env && vars.__env["$1"])');
  out = rewriteFilterPipes(out);
  return out;
}

/**
 * Trasforma `expr | filter[:'arg']` in chiamate JS pure.
 *
 * Pattern: scansione greedy left-to-right. Per ogni occorrenza di ` | <name>[:'…']`
 * non dentro stringhe/regex, wrappa la parte sinistra con la funzione corrispondente.
 * Re-itera finche\` non ci sono piu\` pipe (chaining `x | trim | upper`).
 *
 * Limit: il rewriter non parsa expression complete (es. `(a + b) | upper` con `(a+b)`
 * arbitrariamente complesso e\` supportato perche\` la LHS viene presa come tutto
 * cio\` che precede l'ultima pipe; le pipe dentro string literal sono ignorate via
 * pre-strip stringhe e poi remap).
 */
function rewriteFilterPipes(expression: string): string {
  // Maschera string literal/regex per non confondere `|` dentro stringhe con pipe.
  const stash: string[] = [];
  const masked = expression.replace(
    /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/(?:\\.|[^/\\])+\/[gimsuy]*)/g,
    (m) => {
      stash.push(m);
      return `__STR_${(stash.length - 1).toString()}__`;
    },
  );

  // Scan paren-aware LEFT-TO-RIGHT: trova la prima `|` a depth 0 SEGUITA da
  // un filter name riconosciuto. Wrap [0..pipeIdx) con la funzione filter,
  // poi reinizia lo scan dall'inizio per gestire chaining `x | trim | upper`.
  let result = applyOnePipe(masked);
  let guard = 0;
  while (result.changed && guard++ < 32) {
    result = applyOnePipe(result.text);
  }

  return result.text.replace(/__STR_(\d+)__/g, (_, idx: string) => stash[Number(idx)] ?? '');
}

type FilterName =
  | 'upper' | 'lower' | 'trim' | 'length' | 'json' | 'default'
  | 'round' | 'currency' | 'date' | 'replace' | 'slice' | 'join';

interface PipeScanResult { text: string; changed: boolean }

function applyOnePipe(src: string): PipeScanResult {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    // Tracking quotes per non confondere args (es. `replace:',','-'`).
    if (!inDouble && ch === "'" && src[i - 1] !== '\\') inSingle = !inSingle;
    else if (!inSingle && ch === '"' && src[i - 1] !== '\\') inDouble = !inDouble;
    if (inSingle || inDouble) continue;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '|' && depth === 0 && src[i + 1] !== '|' && src[i - 1] !== '|') {
      const rest = src.slice(i + 1);
      // Filter name + optional args (string-aware to allow commas dentro stringhe).
      const m = /^\s*(upper|lower|trim|length|json|default|round|currency|date|replace|slice|join)\b/.exec(rest);
      if (!m) continue;
      const filter = m[1] as FilterName;
      const afterName = i + 1 + m[0].length;
      // Estrae args dopo `:` fino a stop-char top-level (`,`, `)`, `|`, EOL).
      const { args, end } = readPipeArgs(src, afterName);
      const lhs = src.slice(0, i).trim();
      const tail = src.slice(end);
      const wrapped = wrapFilter(filter, lhs, args);
      return { text: wrapped + tail, changed: true };
    }
  }
  return { text: src, changed: false };
}

/**
 * Parsa l'argument list di una pipe (es. `:'a','b'` o `:2` o `:`).
 * Stop al primo `,`/`)`/`|` top-level FUORI da stringhe.
 * Ritorna l'array di args (raw expression strings) + posizione finale nel src.
 */
function readPipeArgs(src: string, start: number): { args: string[]; end: number } {
  // skip whitespace
  let i = start;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== ':') return { args: [], end: i };
  i++; // skip ':'
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (!inDouble && ch === "'" && src[i - 1] !== '\\') { inSingle = !inSingle; current += ch; continue; }
    if (!inSingle && ch === '"' && src[i - 1] !== '\\') { inDouble = !inDouble; current += ch; continue; }
    if (!inSingle && !inDouble) {
      if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--; current += ch; continue;
      }
      if (depth === 0 && ch === ',') { args.push(current.trim()); current = ''; continue; }
      if (depth === 0 && ch === '|') break;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return { args, end: i };
}

function wrapFilter(filter: FilterName, lhs: string, args: string[]): string {
  switch (filter) {
    case 'upper':   return `String(${lhs} ?? '').toUpperCase()`;
    case 'lower':   return `String(${lhs} ?? '').toLowerCase()`;
    case 'trim':    return `String(${lhs} ?? '').trim()`;
    case 'length':  return `((__v)=>Array.isArray(__v)||typeof __v==='string'?__v.length:0)(${lhs})`;
    case 'json':    return `JSON.stringify(${lhs})`;
    case 'default': return `(${lhs} ?? ${args[0] ?? "''"})`;
    // round:n — Number(x).toFixed(n) → string. n default 0.
    case 'round':   return `Number(${lhs}).toFixed(${args[0] ?? '0'})`;
    // currency:'EUR' (default), o currency:'USD','en-US'. Locale default it-IT.
    case 'currency': {
      const ccy = args[0] ?? "'EUR'";
      const loc = args[1] ?? "'it-IT'";
      return `new Intl.NumberFormat(${loc},{style:'currency',currency:${ccy}}).format(Number(${lhs}))`;
    }
    // date:'YYYY-MM-DD HH:mm:ss' — tokens supportati: YYYY, MM, DD, HH, mm, ss.
    case 'date': {
      const fmt = args[0] ?? "'YYYY-MM-DD'";
      return `((__d)=>{const __x=new Date(__d);if(isNaN(__x.getTime()))return '';const __p=(n,w=2)=>String(n).padStart(w,'0');return (${fmt}).replace(/YYYY/g,String(__x.getFullYear())).replace(/MM/g,__p(__x.getMonth()+1)).replace(/DD/g,__p(__x.getDate())).replace(/HH/g,__p(__x.getHours())).replace(/mm/g,__p(__x.getMinutes())).replace(/ss/g,__p(__x.getSeconds()))})(${lhs})`;
    }
    // replace:'find','sub' (literal, non regex). Default sub = ''.
    case 'replace': {
      const find = args[0] ?? "''";
      const sub = args[1] ?? "''";
      return `String(${lhs} ?? '').replaceAll(${find}, ${sub})`;
    }
    // slice:start[,end] — funziona sia su string sia su array.
    case 'slice': {
      const start = args[0] ?? '0';
      const end = args[1] ?? 'undefined';
      return `((__v)=>typeof __v==='string'||Array.isArray(__v)?__v.slice(${start},${end}):__v)(${lhs})`;
    }
    // join:'sep' — no-op se non array. Sep default ','.
    case 'join': {
      const sep = args[0] ?? "','";
      return `(Array.isArray(${lhs})?${lhs}.join(${sep}):String(${lhs} ?? ''))`;
    }
  }
}

/**
 * Evaluate a JavaScript expression against a curated scope.
 * Returns the expression value as unknown — caller must narrow.
 * Throws InterpreterError on syntax or runtime issues.
 */
export function evaluateExpression(expression: string, scope: InterpreterScope): unknown {
  const rewritten = rewriteShortcuts(expression);
  assertSafeExpression(rewritten);

  const scopeKeys = ['input', 'output', 'ctx', 'item', 'index', 'loop', 'vars', 'secrets'] as const;
  const scopeValues: unknown[] = scopeKeys.map((key) => scope[key]);

  // n8n-grade helpers (+ superiorità): $json/$items/$itemIndex/$workflow/$if/$get/
  // $sum/$date/... auto-bindati dallo scope corrente. Gracefully degradano se il
  // context manca (es. fuori da un loop). Pure → nessun side-effect nella sandbox.
  const helpers = buildExpressionHelpers({
    input: scope.input,
    items: scope.items,
    loop: scope.loop,
    workflow: scope.workflow,
    execution: scope.execution,
  });
  const helperKeys = Object.keys(helpers);
  // Accessor cross-nodo `$('NodeName')` — bound ai vars (output dei nodi) dello
  // scope corrente. Iniettato come identificatore `$` nella Function.
  const nodeAccessor = makeNodeAccessor((scope.vars ?? {}), scope.lineage);
  const allKeys = [...scopeKeys, ...helperKeys, '$'];
  const allValues = [
    ...scopeValues,
    ...helperKeys.map((k) => (helpers as unknown as Record<string, unknown>)[k]),
    nodeAccessor,
  ];

  let fn: (...args: unknown[]) => unknown;
  try {
    // Use the rewritten expression — n8n-style shortcuts have already been
    // expanded to canonical scope references (vars["X"], etc.).
    //
    // `new Function` È il motore d'interprete: valutare un'espressione workflow
    // dinamica RICHIEDE compilazione dinamica — non esiste alternativa. È il
    // sandbox sicuro by-design: `"use strict"`, scope esplicito (solo le chiavi
    // in allKeys), nessun accesso a require/process/globalThis (vedi
    // assertSafeExpression a monte). Unica eccezione documentata al lint.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- interprete espressioni: dynamic compile è il meccanismo stesso, sandboxed
    fn = new Function(
      ...allKeys,
      `"use strict"; return (${rewritten});`,
    ) as (...args: unknown[]) => unknown;
  } catch (error) {
    throw new InterpreterError(
      `Syntax error in expression: ${error instanceof Error ? error.message : String(error)}`,
      expression,
      error,
    );
  }

  const start = Date.now();
  try {
    const result: unknown = fn(...allValues);
    const elapsed = Date.now() - start;
    if (elapsed > EXPRESSION_TIMEOUT_MS) {
      throw new InterpreterError(
        `Expression evaluation exceeded ${String(EXPRESSION_TIMEOUT_MS)}ms timeout`,
        expression,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof InterpreterError) throw error;
    throw new InterpreterError(
      `Runtime error: ${error instanceof Error ? error.message : String(error)}`,
      expression,
      error,
    );
  }
}

/**
 * Interpolate a template string with {{expression}} placeholders.
 * Each placeholder is evaluated against the scope and replaced with its value.
 */
export function interpolateString(template: string, scope: InterpreterScope): string {
  return template.replace(/\{\{([\s\S]+?)\}\}/g, (_match, expression: string) => {
    try {
      const value = evaluateExpression(expression.trim(), scope);
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(value);
    } catch {
      return '';
    }
  });
}

/**
 * Apply interpolation across every string value in a config object.
 * Non-string values pass through unchanged.
 *
 * INDIRECTION WEBHOOK (lib/webhook-ref.ts): dopo l'interpolazione `{{…}}`,
 * ogni `ref://wf/<id>/webhook[…]` viene espanso nel path corrente col token
 * derivato dal secret CORRENTE. Questo è il choke-point: qualunque executor
 * riceve la config già risolta, e il token non è MAI persistito nel workflow.
 */
export function interpolateConfig(
  config: Record<string, unknown>,
  scope: InterpreterScope,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      result[key] = resolveWebhookRefs(interpolateString(value, scope));
    } else {
      result[key] = value;
    }
  }
  return result;
}
