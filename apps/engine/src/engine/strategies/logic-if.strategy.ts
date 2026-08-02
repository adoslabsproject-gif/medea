/**
 * LogicIfStrategy — evaluates a `logic_if` node and selects either the
 * `true` or `false` output port for the downstream BFS.
 *
 * v2.0: prefers the new `conditionRules` visual builder (structured JSON)
 * when present. Falls back to the legacy `condition` expression otherwise.
 *
 * Why this lives in the engine (and not in the NodeModule executor):
 *   `logic_if` is structurally a branching node — its outputs are NOT
 *   data, they're routing decisions. The engine itself must know about
 *   the chosen branch to filter outgoing edges in the BFS. Keeping this
 *   logic close to the engine (as a Strategy) is the cleanest split.
 */

import { evaluateExpression } from '@/engine/interpreter.js';
import { parseRuleset, evaluateRuleset } from '@medea/engine-nodes-stdlib';
import type { INodeDispatchStrategy, DispatchContext, DispatchResult } from './types.js';

export class LogicIfStrategy implements INodeDispatchStrategy {
  readonly name = 'logic-if';

  match(ctx: DispatchContext): boolean {
    return ctx.module.def.id === 'logic_if';
  }

   
  execute(ctx: DispatchContext): Promise<DispatchResult> {
    // Priority 1: structured rules from the visual builder.
    const rulesRaw = ctx.interpolatedConfig.conditionRules;
    const ruleset = parseRuleset(rulesRaw);
    let truthy: boolean;
    let conditionRepr: string;

    if (ruleset && ruleset.rules.length > 0) {
      truthy = evaluateRuleset(ruleset, ctx.scope);
      conditionRepr = `[rules:${ruleset.combinator}] ${ruleset.rules.map((r) => `${r.left} ${r.op} ${r.right ?? ''}`).join(` ${ruleset.combinator} `)}`;
    } else {
      // Priority 2: legacy free-text expression.
      const conditionRaw = ctx.interpolatedConfig.condition;
      const cond = typeof conditionRaw === 'string' ? conditionRaw : 'false';
      truthy = Boolean(evaluateExpression(cond, ctx.scope));
      conditionRepr = cond;
    }

    const chosenBranch = truthy ? 'true' : 'false';
    return Promise.resolve({
      output: { branch: chosenBranch, condition: conditionRepr, truthy },
      chosenBranch,
      retries: 0,
    });
  }
}
