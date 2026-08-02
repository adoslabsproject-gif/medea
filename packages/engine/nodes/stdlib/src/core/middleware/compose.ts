/**
 * compose / wrap — pipeline composer Koa-style adattato a NodeExecutor.
 *
 * `compose([a, b, c])(executor)` produce `a(b(c(executor)))`.
 * Execution order onion: `a-before → b-before → c-before → executor → c-after → b-after → a-after`.
 */

import type { NodeExecutor } from '../../types.js';

export type Middleware = (next: NodeExecutor) => NodeExecutor;

/**
 * Compose una lista di middleware. Right-fold per garantire LEFT-TO-RIGHT
 * execution order al runtime.
 */
export function compose(
  middlewares: readonly Middleware[],
): (executor: NodeExecutor) => NodeExecutor {
  return (executor: NodeExecutor): NodeExecutor => {
    let wrapped = executor;
    for (let i = middlewares.length - 1; i >= 0; i -= 1) {
      const mw = middlewares[i];
      if (mw) wrapped = mw(wrapped);
    }
    return wrapped;
  };
}

/**
 * Helper convenience: applica la pipeline ad un executor in una sola call.
 *   wrap(httpExecutor, [withErrorMapping(), withTelemetry({...}), withHostBreaker({...})])
 */
export function wrap(executor: NodeExecutor, middlewares: readonly Middleware[]): NodeExecutor {
  return compose(middlewares)(executor);
}
