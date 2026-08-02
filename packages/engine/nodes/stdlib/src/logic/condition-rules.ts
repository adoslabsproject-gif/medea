/**
 * Shared evaluator for the `condition-rules` configField type.
 *
 * Value shape (stored as a JSON string in node.config so it survives the
 * generic ConfigField transport):
 *   {
 *     "combinator": "AND" | "OR",
 *     "rules": [
 *       { "left": "input.status", "op": "equals", "right": "active", "type": "string" }
 *     ]
 *   }
 *
 * Each rule is evaluated against an evaluation context (the same shape as
 * the IF node's `condition` expression: input, output, ctx, vars). The
 * `left` is evaluated as an expression; the `right` is the constant the
 * left is compared against (also expression-aware so cross-node references
 * work: `right: "{{$node.Loader.id}}"`).
 *
 * Operators by type:
 *   string  : equals, not-equals, contains, not-contains, starts-with,
 *             ends-with, matches-regex, is-empty, is-not-empty
 *   number  : eq, ne, gt, gte, lt, lte, between
 *   date    : before, after, equals
 *   boolean : is-true, is-false
 *   any     : exists, not-exists, equals, not-equals
 *
 * If parsing fails (malformed JSON, missing fields) the evaluator returns
 * `null` so the caller can fall back to a legacy expression.
 */

import { safeUserRegex } from '../lib/safe-user-regex.js';

export type Combinator = 'AND' | 'OR';
export type RuleType = 'string' | 'number' | 'date' | 'boolean' | 'any';

export interface ConditionRule {
  left: string;
  op: string;
  right?: string;
  rightMax?: string; // for "between" op
  type?: RuleType;
  caseSensitive?: boolean;
}

export interface ConditionRuleset {
  combinator: Combinator;
  rules: ConditionRule[];
}

export interface EvalContext {
  input?: unknown;
  output?: unknown;
  ctx?: unknown;
  vars?: unknown;
  $node?: Record<string, unknown>;
  $run?: Record<string, unknown>;
}

/**
 * Parse the raw config value (string or already-decoded object) into a
 * structured ruleset. Returns null on any error.
 */
export function parseRuleset(raw: unknown): ConditionRuleset | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const combinator = o.combinator === 'OR' ? 'OR' : 'AND';
  const rules = Array.isArray(o.rules)
    ? (o.rules as unknown[]).filter((r): r is ConditionRule => Boolean(r) && typeof r === 'object')
    : [];
  if (rules.length === 0) return null;
  return { combinator, rules };
}

/**
 * Lightweight expression evaluator — supports dotted paths and bare
 * literals. Intentionally narrower than a full sandbox: this is for
 * READING values out of the evaluation context, not running code.
 *
 * Examples:
 *   "input.status"        → ctx.input.status
 *   "input.items.length"  → ctx.input.items.length
 *   "active"              → "active" (bare literal)
 *   "42"                  → 42
 *   "true"                → true
 *   "null"                → null
 */
function evalPath(expr: string, context: EvalContext): unknown {
  const trimmed = expr.trim();
  if (trimmed === '') return undefined;

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  // Boolean / null literals
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;
  // Quoted string literal
  if (/^"[^"]*"$/u.test(trimmed) || /^'[^']*'$/u.test(trimmed)) return trimmed.slice(1, -1);

  // Dotted path resolution
  const parts = trimmed.split('.');
  const root = parts[0]!;
  let cursor: unknown;
  if (root === 'input') cursor = context.input;
  else if (root === 'output') cursor = context.output;
  else if (root === 'ctx') cursor = context.ctx;
  else if (root === 'vars') cursor = context.vars;
  else if (root === '$node') cursor = context.$node;
  else if (root === '$run') cursor = context.$run;
  else return trimmed; // treat as bare string literal

  for (let i = 1; i < parts.length; i += 1) {
    if (cursor === null || cursor === undefined) return undefined;
    const key = parts[i]!;
    if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function toComparableString(v: unknown, caseSensitive: boolean): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
  return caseSensitive ? s : s.toLowerCase();
}

function toComparableNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

function toDate(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}

/**
 * Evaluate a single rule against the context. Returns true/false.
 * Unknown operators return false (fail safe).
 */
export function evaluateRule(rule: ConditionRule, context: EvalContext): boolean {
  const ruleType = rule.type ?? 'any';
  const cs = rule.caseSensitive ?? false;
  const leftVal = evalPath(rule.left, context);
  const rightVal = rule.right !== undefined ? evalPath(rule.right, context) : undefined;
  const op = rule.op;

  // Type-independent
  if (op === 'exists') return leftVal !== undefined && leftVal !== null;
  if (op === 'not-exists') return leftVal === undefined || leftVal === null;

  if (ruleType === 'string' || ruleType === 'any') {
    const l = toComparableString(leftVal, cs);
    const r = toComparableString(rightVal, cs);
    if (op === 'equals') return l === r;
    if (op === 'not-equals') return l !== r;
    if (op === 'contains') return l.includes(r);
    if (op === 'not-contains') return !l.includes(r);
    if (op === 'starts-with') return l.startsWith(r);
    if (op === 'ends-with') return l.endsWith(r);
    if (op === 'matches-regex') {
      // RE2 (safeUserRegex): il pattern è attacker-controlled (output nodi upstream) →
      // `new RegExp` di V8 backtrack-erebbe (ReDoS, es. `(a+)+$`). RE2 = lineare, immune.
      // `catch` → false anche su UnsafeRegexError (pattern non-RE2/troppo lungo).
      try {
        return safeUserRegex(
          typeof rule.right === 'string' ? rule.right : '',
          cs ? 'u' : 'iu',
        ).test(typeof leftVal === 'string' ? leftVal : String(leftVal ?? ''));
      } catch {
        return false;
      }
    }
    if (op === 'is-empty') return l === '';
    if (op === 'is-not-empty') return l !== '';
  }

  if (ruleType === 'number') {
    const l = toComparableNumber(leftVal);
    const r = toComparableNumber(rightVal);
    if (op === 'eq' || op === 'equals') return l === r;
    if (op === 'ne' || op === 'not-equals') return l !== r;
    if (op === 'gt') return l > r;
    if (op === 'gte') return l >= r;
    if (op === 'lt') return l < r;
    if (op === 'lte') return l <= r;
    if (op === 'between') {
      const max =
        rule.rightMax !== undefined ? toComparableNumber(evalPath(rule.rightMax, context)) : NaN;
      return l >= r && l <= max;
    }
  }

  if (ruleType === 'date') {
    const l = toDate(leftVal);
    const r = toDate(rightVal);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
    if (op === 'before') return l < r;
    if (op === 'after') return l > r;
    if (op === 'equals') return l === r;
  }

  if (ruleType === 'boolean') {
    if (op === 'is-true') return leftVal === true || leftVal === 'true' || leftVal === 1;
    if (op === 'is-false') return leftVal === false || leftVal === 'false' || leftVal === 0;
  }

  return false;
}

export function evaluateRuleset(ruleset: ConditionRuleset, context: EvalContext): boolean {
  if (ruleset.combinator === 'OR') {
    return ruleset.rules.some((r) => evaluateRule(r, context));
  }
  return ruleset.rules.every((r) => evaluateRule(r, context));
}
