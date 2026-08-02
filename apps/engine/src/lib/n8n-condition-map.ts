/**
 * Mapping condizioni n8n (IF) → conditionRules FlowForge (logic_if).
 *
 * Supporta le DUE forme n8n:
 *   v2 (attuale): parameters.conditions = { combinator, conditions: [
 *                   { leftValue, rightValue, operator: { type, operation } } ] }
 *   v1 (legacy):  parameters.conditions = { string|number|boolean: [
 *                   { value1, operation, value2 } ] }
 *
 * Produce il config FlowForge `conditionRules` = JSON
 *   { combinator: 'AND'|'OR', rules: [ { left, op, right?, type? } ] }
 * dove `left`/`right` sono path/letterali (es. `input.status`, `"active"`) leggibili
 * dall'evalPath di condition-rules, NON espressioni `{{ }}`.
 *
 * Operatori senza mapping o left/right non risolvibili → warning (no silenzio).
 */

import { coerceString } from '@/lib/coerce.js';

type Raw = Record<string, unknown>;

export interface ConditionMapResult {
  config: Record<string, string>;
  warnings: string[];
}

/** Normalizza un operatore n8n a chiave canonica (lowercase, solo alfanumerici). */
function normOp(op: unknown): string {
  return typeof op === 'string' ? op.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/** n8n operation → op FlowForge (vocabolario reale di condition-rules.ts). */
const OP_MAP: Readonly<Record<string, string>> = {
  equals: 'equals',
  equal: 'equals',
  eq: 'equals',
  notequals: 'not-equals',
  notequal: 'not-equals',
  ne: 'not-equals',
  contains: 'contains',
  notcontains: 'not-contains',
  startswith: 'starts-with',
  endswith: 'ends-with',
  regex: 'matches-regex',
  matchesregex: 'matches-regex',
  gt: 'gt',
  larger: 'gt',
  gte: 'gte',
  largerequal: 'gte',
  lt: 'lt',
  smaller: 'lt',
  lte: 'lte',
  smallerequal: 'lte',
  after: 'after',
  before: 'before',
  exists: 'exists',
  notexists: 'not-exists',
  empty: 'is-empty',
  isempty: 'is-empty',
  notempty: 'is-not-empty',
  isnotempty: 'is-not-empty',
  true: 'is-true',
  false: 'is-false',
};

/** Op unari (non hanno `right`). */
const UNARY_OPS = new Set([
  'exists',
  'not-exists',
  'is-empty',
  'is-not-empty',
  'is-true',
  'is-false',
]);

function mapType(t: unknown): 'string' | 'number' | 'date' | 'boolean' | 'any' {
  const s = typeof t === 'string' ? t.toLowerCase() : '';
  if (s === 'number') return 'number';
  if (s === 'boolean') return 'boolean';
  if (s === 'datetime' || s === 'date') return 'date';
  if (s === 'string') return 'string';
  return 'any';
}

/**
 * Converte un valore-operando n8n (leftValue/rightValue/value1/value2) in
 * path/letterale FlowForge. `={{ $json.x }}` → `input.x`; letterale → invariato.
 */
function operand(v: unknown): { value: string; warning?: string } {
  if (typeof v === 'number' || typeof v === 'boolean') return { value: String(v) };
  if (typeof v !== 'string')
    return { value: v === null || v === undefined ? '' : JSON.stringify(v) };

  const s = v.startsWith('=') ? v.slice(1) : v;
  const m = /^\s*\{\{\s*([\s\S]*?)\s*\}\}\s*$/u.exec(s);
  if (!m) return { value: s }; // letterale puro

  let e = (m[1] ?? '').trim();
  e = e.replace(/\[\s*['"`]([a-zA-Z_$][\w$]*)['"`]\s*\]/gu, '.$1'); // ["k"] → .k
  if (/^\$json\b/u.test(e)) return { value: e.replace(/^\$json/u, 'input') };
  if (/^\$node\b/u.test(e))
    return { value: e, warning: `condizione: riferimento "${e}" ad altro nodo — verifica il path` };
  return { value: e, warning: `condizione: espressione "${e}" — verifica a mano` };
}

interface OutRule {
  left: string;
  op: string;
  right?: string;
  type: string;
}

function buildRule(
  rawLeft: unknown,
  rawOp: unknown,
  rawRight: unknown,
  type: string,
  warnings: string[],
): OutRule | null {
  const op = OP_MAP[normOp(rawOp)];
  if (!op) {
    warnings.push(`operatore IF "${String(rawOp)}" non mappato — rivedi la condizione`);
    return null;
  }
  const left = operand(rawLeft);
  if (left.warning) warnings.push(left.warning);
  const rule: OutRule = { left: left.value, op, type };
  if (!UNARY_OPS.has(op)) {
    const right = operand(rawRight);
    if (right.warning) warnings.push(right.warning);
    rule.right = right.value;
  }
  return rule;
}

/** Mappa parameters n8n di un nodo IF → config FlowForge (conditionRules). */
export function mapN8nIfConditions(p: Raw): ConditionMapResult {
  const warnings: string[] = [];
  const conditions = p.conditions;
  const rules: OutRule[] = [];
  let combinator: 'AND' | 'OR' = 'AND';

  if (conditions && typeof conditions === 'object') {
    const c = conditions as Record<string, unknown>;
    if (Array.isArray(c.conditions)) {
      // v2
      combinator = coerceString(c.combinator ?? 'and').toUpperCase() === 'OR' ? 'OR' : 'AND';
      for (const condU of c.conditions) {
        const cond = condU as {
          leftValue?: unknown;
          rightValue?: unknown;
          operator?: { type?: unknown; operation?: unknown };
        };
        const r = buildRule(
          cond.leftValue,
          cond.operator?.operation,
          cond.rightValue,
          mapType(cond.operator?.type),
          warnings,
        );
        if (r) rules.push(r);
      }
    } else {
      // v1: { string: [...], number: [...], boolean: [...] }
      for (const [typeKey, arr] of Object.entries(c)) {
        if (!Array.isArray(arr)) continue;
        for (const condU of arr) {
          const cond = condU as { value1?: unknown; operation?: unknown; value2?: unknown };
          const r = buildRule(cond.value1, cond.operation, cond.value2, mapType(typeKey), warnings);
          if (r) rules.push(r);
        }
      }
    }
  }

  if (rules.length === 0) {
    // Preserva i warning accumulati (es. "operatore non mappato"); aggiungi la nota
    // generica solo se non c'è già un motivo specifico.
    if (warnings.length === 0)
      warnings.push('IF: condizioni n8n non riconosciute — imposta la condizione a mano nel nodo');
    return { config: {}, warnings };
  }
  return { config: { conditionRules: JSON.stringify({ combinator, rules }) }, warnings };
}
