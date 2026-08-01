/**
 * Dispatch strategies — barrel export + default chain.
 *
 * The order of DEFAULT_DISPATCH_STRATEGIES is the authoritative dispatch
 * order at run time. DO NOT REORDER unless you understand the implications:
 *
 *   1. PinnedOutputStrategy        ─ MUST be first (global override)
 *   2. LogicIfStrategy             ─ before NodeExecutor (logic_if has no
 *                                     real executor; it's a routing node)
 *   3. LogicDelayStrategy          ─ same reason
 *   4. TriggerPassthroughStrategy  ─ same reason
 *   5. NodeExecutorStrategy        ─ MUST be last (catch-all)
 *
 * Adding a new special-case node:
 *   • create a `<my-case>.strategy.ts` file in this folder
 *   • implement INodeDispatchStrategy
 *   • append it to DEFAULT_DISPATCH_STRATEGIES *before* NodeExecutorStrategy
 *
 * Tests:
 *   • Each strategy is independently instantiable and testable.
 *   • The engine accepts a custom strategies array via constructor options.
 */

import type { INodeDispatchStrategy } from './types.js';
import { PinnedOutputStrategy } from './pinned-output.strategy.js';
import { LogicIfStrategy } from './logic-if.strategy.js';
import { LogicSwitchStrategy } from './logic-switch.strategy.js';
import { LogicDelayStrategy } from './logic-delay.strategy.js';
import { TriggerPassthroughStrategy } from './trigger-passthrough.strategy.js';
import { NodeExecutorStrategy } from './node-executor.strategy.js';

export type { INodeDispatchStrategy, DispatchContext, DispatchResult } from './types.js';
export { PinnedOutputStrategy } from './pinned-output.strategy.js';
export { LogicIfStrategy } from './logic-if.strategy.js';
export { LogicSwitchStrategy } from './logic-switch.strategy.js';
export { LogicDelayStrategy } from './logic-delay.strategy.js';
export { TriggerPassthroughStrategy } from './trigger-passthrough.strategy.js';
export { NodeExecutorStrategy } from './node-executor.strategy.js';

/**
 * The default dispatch chain used by WorkflowEngine when no custom chain
 * is injected. Single source of truth for production execution order.
 */
export const DEFAULT_DISPATCH_STRATEGIES: readonly INodeDispatchStrategy[] = [
  new PinnedOutputStrategy(),
  new LogicIfStrategy(),
  new LogicSwitchStrategy(),
  new LogicDelayStrategy(),
  new TriggerPassthroughStrategy(),
  new NodeExecutorStrategy(),
];
