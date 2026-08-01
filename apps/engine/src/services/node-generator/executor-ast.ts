/**
 * executor-ast — analisi STATICA (acorn) del codice executor generato per un nodo
 * custom. È il "leggo e verifico il codice prima di accettarlo" che farebbe un
 * senior: invece di una blacklist regex (bypassabile con bracket-access, spazi,
 * newline), parsiamo l'AST ESTree e ragioniamo sulla STRUTTURA.
 *
 * Perché acorn e non il compilatore TypeScript: il runtime è un bundle ESM (tsup)
 * e `typescript` è CJS che usa `__filename` a load-time → ReferenceError in scope
 * ESM (crash all'avvio del container, incidente 2026-06-16). acorn è ESM-native,
 * minuscolo e pensato esattamente per parsare JS non fidato.
 *
 * Produce fatti GREZZI (il giudizio sta in executor-validator):
 *  - errori di sintassi (acorn lancia → li raccogliamo)
 *  - la funzione `execute` (presenza, async, nomi dei parametri posizionali)
 *  - riferimenti a global VIETATI (process/require/eval/Function/fs/…), riconosciuti
 *    anche come `globalThis['process']` perché flagghiamo l'IDENTIFIER, non la stringa
 *  - import statici e `import()` dinamici
 *  - chiavi di `config` lette (`config.x` / `config['x']`) e secret usati
 *    (`context.secrets[...]`) — posizionali, indipendenti dai nomi dei parametri
 *  - se esiste un `return <espressione>`
 *
 * Puro, niente I/O, niente esecuzione del codice analizzato.
 *
 * @module services/node-generator/executor-ast
 */
import { parse } from 'acorn';

/** Identificatori che un executor sandboxed non deve MAI referenziare. */
export const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
  'require', 'eval', 'process', 'globalThis', 'Function',
  'child_process', 'fs', '__dirname', '__filename', 'Deno', 'Bun', 'module',
]);

export interface ExecuteFnInfo {
  found: boolean;
  isAsync: boolean;
  /** Nomi dei parametri in ordine: [config, input, context] per contratto. */
  paramNames: string[];
}

export interface ExecutorAstFacts {
  /** Messaggi di errore di sintassi (vuoto = parseable). */
  syntaxErrors: string[];
  execute: ExecuteFnInfo;
  /** Identificatori vietati referenziati (deduplicati, ordinati). */
  forbiddenRefs: string[];
  /** True se c'è almeno un `import` statico o un `import()` dinamico. */
  hasImport: boolean;
  /** Chiavi lette da config (primo parametro di execute). */
  configKeysUsed: string[];
  /** Nomi dei secret letti da context.secrets[...] (terzo parametro). */
  secretsUsed: string[];
  /** True se l'executor ha almeno un `return <espressione>`. */
  hasReturnValue: boolean;
}

/**
 * Nodo ESTree minimale. Boundary di tipo UNICO verso acorn (che ritorna nodi
 * tipizzati in modo lasco): incapsulato qui, non sparso nel codice.
 */
interface EsNode {
  type: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  async?: boolean;
  id?: EsNode | null;
  init?: EsNode | null;
  argument?: EsNode | null;
  object?: EsNode;
  property?: EsNode;
  key?: EsNode;
  callee?: EsNode;
  params?: EsNode[];
  declarations?: EsNode[];
  body?: EsNode[] | EsNode;
  [k: string]: unknown;
}

function isNode(v: unknown): v is EsNode {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** Visita ricorsiva generica dell'AST: (nodo, genitore) per ogni nodo. */
function walk(node: EsNode, parent: EsNode | null, visit: (n: EsNode, p: EsNode | null) => void): void {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) walk(c, node, visit);
    } else if (isNode(v)) {
      walk(v, node, visit);
    }
  }
}

const paramName = (p: EsNode): string => (p.type === 'Identifier' && p.name ? p.name : '_');

function findExecute(program: EsNode): ExecuteFnInfo {
  const body = Array.isArray(program.body) ? program.body : [];
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name === 'execute') {
      return { found: true, isAsync: stmt.async === true, paramNames: (stmt.params ?? []).map(paramName) };
    }
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations ?? []) {
        const init = d.init;
        if (d.id?.name === 'execute' && init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          return { found: true, isAsync: init.async === true, paramNames: (init.params ?? []).map(paramName) };
        }
      }
    }
  }
  return { found: false, isAsync: false, paramNames: [] };
}

/** True se l'Identifier è un NOME di proprietà (`a.process`, `{process:1}`) → non un riferimento al global. */
function isPropertyName(node: EsNode, parent: EsNode | null): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.computed === false && parent.property === node) return true;
  if (parent.type === 'Property' && parent.computed === false && parent.key === node) return true;
  return false;
}

/** Da `x.key` o `x['key']` con x===rootName ritorna la chiave, altrimenti null. */
function memberKeyOf(node: EsNode, rootName: string): string | null {
  if (node.type !== 'MemberExpression' || node.object?.type !== 'Identifier' || node.object.name !== rootName) return null;
  const prop = node.property;
  if (!prop) return null;
  if (node.computed === false && prop.type === 'Identifier' && prop.name) return prop.name;
  if (node.computed === true && prop.type === 'Literal' && typeof prop.value === 'string') return prop.value;
  return null;
}

export function analyzeExecutor(source: string): ExecutorAstFacts {
  let program: EsNode | null = null;
  const syntaxErrors: string[] = [];
  try {
    // Boundary di tipo unico verso acorn (nodi tipizzati in modo lasco).
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as EsNode;
  } catch (err) {
    syntaxErrors.push(err instanceof Error ? err.message : String(err));
  }

  if (!program) {
    return {
      syntaxErrors, execute: { found: false, isAsync: false, paramNames: [] },
      forbiddenRefs: [], hasImport: false, configKeysUsed: [], secretsUsed: [], hasReturnValue: false,
    };
  }

  const execute = findExecute(program);
  const configParam = execute.paramNames[0];
  const contextParam = execute.paramNames[2];

  const forbidden = new Set<string>();
  const configKeys = new Set<string>();
  const secrets = new Set<string>();
  let hasImport = false;
  let hasReturnValue = false;

  walk(program, null, (node, parent) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') hasImport = true;
    if (node.type === 'Identifier' && node.name && FORBIDDEN_GLOBALS.has(node.name) && !isPropertyName(node, parent)) {
      forbidden.add(node.name);
    }
    if (node.type === 'ReturnStatement' && node.argument) hasReturnValue = true;
    if (configParam) {
      const k = memberKeyOf(node, configParam);
      if (k) configKeys.add(k);
    }
    // context.secrets['NAME']: MemberExpression computed con object = <ctx>.secrets
    if (contextParam && node.type === 'MemberExpression' && node.computed === true &&
        node.property?.type === 'Literal' && typeof node.property.value === 'string') {
      const inner = node.object;
      if (inner?.type === 'MemberExpression' && inner.property?.type === 'Identifier' && inner.property.name === 'secrets' &&
          inner.object?.type === 'Identifier' && inner.object.name === contextParam) {
        secrets.add(node.property.value);
      }
    }
  });

  return {
    syntaxErrors,
    execute,
    forbiddenRefs: [...forbidden].sort(),
    hasImport,
    configKeysUsed: [...configKeys].sort(),
    secretsUsed: [...secrets].sort(),
    hasReturnValue,
  };
}
