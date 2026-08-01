/**
 * PinnedOutputStrategy — when a node has a pinned output, skip its
 * executor entirely and forward the pinned value.
 *
 * Two callers feed pinned outputs into the engine:
 *   • The "pin data" feature in the editor (n8n-style iterative dev).
 *   • The Replay-from-step-N feature (steps 0..N-1 are pinned to their
 *     historical output, the engine re-executes from N onward).
 *
 * MUST be first in the strategy chain — a pinned value is a global
 * override and must shadow every other special-case node behavior.
 */

import type { INodeDispatchStrategy, DispatchContext, DispatchResult } from './types.js';

export class PinnedOutputStrategy implements INodeDispatchStrategy {
  readonly name = 'pinned-output';

  match(ctx: DispatchContext): boolean {
    return ctx.pinnedOutputs?.get(ctx.node.id) !== undefined;
  }

   
  execute(ctx: DispatchContext): Promise<DispatchResult> {
    return Promise.resolve({
      output: ctx.pinnedOutputs?.get(ctx.node.id),
      chosenBranch: undefined,
      retries: 0,
    });
  }
}
