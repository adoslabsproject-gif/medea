/**
 * LogicSwitchStrategy — routes execution to one of N named branches.
 *
 * v2.0 behavior:
 *   1. Evaluate the `expression` field against the scope. The value is the
 *      "subject" we're matching against.
 *   2. Walk the `cases` array (configured via the switch-cases UI). Each
 *      case is `{ match: <literal>, branch: <output port name> }`.
 *   3. If a case's `match` equals the subject (string equality, optionally
 *      case-insensitive), the corresponding branch is chosen.
 *   4. If no case matches, emit the `fallbackBranch` (default "default").
 *
 * Federico parity gap closed: v1.0 had no fallback. v2.0 always emits a
 * branch, so a workflow can safely wire a "no match" path.
 */

import { evaluateExpression } from '@/engine/interpreter.js';
import { parseRuleset, evaluateRuleset } from '@medea/engine-nodes-stdlib';
import type { INodeDispatchStrategy, DispatchContext, DispatchResult } from './types.js';

interface SwitchCase {
  match: string | number | boolean;
  branch: string;
  /** Opzionale: ruleset condition-rules (AND/OR) che OVERRIDE il literal match. */
  rules?: unknown;
}

function parseCases(raw: unknown): SwitchCase[] {
  if (Array.isArray(raw))
    return raw.filter(
      (c): c is SwitchCase => Boolean(c) && typeof c === 'object' && 'branch' in (c as object),
    );
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed.filter(
          (c): c is SwitchCase => Boolean(c) && typeof c === 'object' && 'branch' in (c as object),
        );
    } catch {
      /* fall through */
    }
  }
  return [];
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

export class LogicSwitchStrategy implements INodeDispatchStrategy {
  readonly name = 'logic-switch';

  match(ctx: DispatchContext): boolean {
    return ctx.module.def.id === 'logic_switch';
  }

  execute(ctx: DispatchContext): Promise<DispatchResult> {
    const exprRaw = ctx.interpolatedConfig.expression;
    const expr = typeof exprRaw === 'string' ? exprRaw : '';
    const subject = expr ? evaluateExpression(expr, ctx.scope) : undefined;

    const cases = parseCases(ctx.interpolatedConfig.cases);
    const caseSensitive =
      ctx.interpolatedConfig.caseSensitive === undefined
        ? true
        : asBool(ctx.interpolatedConfig.caseSensitive);

    const normalize = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      return caseSensitive ? s : s.toLowerCase();
    };
    const subjectNorm = normalize(subject);
    const strictMode = asBool(ctx.interpolatedConfig.strictMode);

    let chosenBranch: string | undefined;
    let matchedCase: SwitchCase | null = null;
    for (const c of cases) {
      // Un case può avere un ruleset condition-rules (AND/OR) che SOSTITUISCE il
      // literal match: utile per "case se amount>1000 AND country in [...]".
      const ruleset = c.rules !== undefined ? parseRuleset(c.rules) : null;
      const isMatch =
        ruleset && ruleset.rules.length > 0
          ? evaluateRuleset(ruleset, ctx.scope)
          : normalize(c.match) === subjectNorm;
      if (isMatch) {
        chosenBranch = c.branch;
        matchedCase = c;
        break;
      }
    }
    if (!chosenBranch) {
      // strictMode: un fallthrough su input inatteso è un BUG → errore esplicito
      // (workflow critici) invece dell'instradamento silenzioso al default. Rejected
      // promise (non throw sincrono): execute() ritorna Promise, l'engine fa await.
      if (strictMode) {
        return Promise.reject(
          new Error(
            `logic_switch: nessun case corrisponde al valore "${subjectNorm}" e strictMode è attivo`,
          ),
        );
      }
      const fallback = ctx.interpolatedConfig.fallbackBranch;
      chosenBranch =
        typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : 'default';
    }
    return Promise.resolve({
      output: {
        subject: subject ?? null,
        chosenBranch,
        matched: Boolean(matchedCase),
        ...(matchedCase ? { matchedCase: matchedCase.match } : {}),
      },
      chosenBranch,
      retries: 0,
    });
  }
}
