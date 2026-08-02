/**
 * LogicDelayStrategy — pause workflow execution for a bounded amount
 * of time. The delay is capped at 60s to prevent runaway workflows
 * from blocking a worker forever; longer pauses should use the
 * `logic_wait_signal` async-frame node instead.
 *
 * Why this is a Strategy and not a regular executor:
 *   `logic_delay` lives in stdlib but has no NodeModule executor —
 *   the engine itself owns the timer so workers can be reused once
 *   the delay completes without round-tripping through executor
 *   registry lookup.
 */

import type { INodeDispatchStrategy, DispatchContext, DispatchResult } from './types.js';

/** Hard upper bound on delay duration (1 minute). */
const MAX_DELAY_MS = 60_000;

export class LogicDelayStrategy implements INodeDispatchStrategy {
  readonly name = 'logic-delay';

  match(ctx: DispatchContext): boolean {
    return ctx.module.def.id === 'logic_delay';
  }

  async execute(ctx: DispatchContext): Promise<DispatchResult> {
    const requested = Number(ctx.interpolatedConfig.durationMs ?? 0);
    const ms = Math.max(0, Math.min(requested, MAX_DELAY_MS));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    return {
      output: { delayedMs: ms },
      chosenBranch: undefined,
      retries: 0,
    };
  }
}
