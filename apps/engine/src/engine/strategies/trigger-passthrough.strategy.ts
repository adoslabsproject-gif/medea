/**
 * TriggerPassthroughStrategy — trigger nodes (manual, webhook, cron,
 * form, IMAP, file_watch, db_change, pec) are *not* executed by the
 * engine. Their job is to carry the external event payload (webhook
 * body, cron tick, form submission, IMAP email, file change, etc.)
 * INTO the workflow. The runtime decides WHEN to fire them; once
 * fired, the payload IS the carried input.
 *
 * This strategy returns that input unchanged so the BFS can continue
 * with the downstream nodes.
 *
 * Identity check is twofold:
 *   • module.def.type === 'trigger'  → the canonical signal
 *   • module.def.id.startsWith('trigger_')  → safety net for legacy
 *     trigger nodes that may not have set `type` correctly
 */

import type { INodeDispatchStrategy, DispatchContext, DispatchResult } from './types.js';

export class TriggerPassthroughStrategy implements INodeDispatchStrategy {
  readonly name = 'trigger-passthrough';

  match(ctx: DispatchContext): boolean {
    return ctx.module.def.type === 'trigger' || ctx.module.def.id.startsWith('trigger_');
  }

   
  execute(ctx: DispatchContext): Promise<DispatchResult> {
    return Promise.resolve({
      output: ctx.carriedInput ?? null,
      chosenBranch: undefined,
      retries: 0,
    });
  }
}
