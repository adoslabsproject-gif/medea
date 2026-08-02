/**
 * withHostBreaker — per-host circuit breaker wrapper.
 *
 * Estrae l'URL via `urlFrom(config)` → bucket per-host via @medea/engine-shared CB.
 * Se l'URL non e\` derivabile (URL dinamico runtime-only), passa attraverso.
 */

import type { NodeExecutor } from '../../types.js';
import { executeWithHostBreaker, type HostBreakerOptions } from '../host-circuit-breaker.js';
import type { Middleware } from './compose.js';

export interface HostBreakerMiddlewareOptions extends HostBreakerOptions {
  urlFrom: (config: Record<string, unknown>) => string | undefined;
}

export function withHostBreaker(opts: HostBreakerMiddlewareOptions): Middleware {
  return (next: NodeExecutor) => async (config, input, ctx) => {
    const url = opts.urlFrom(config);
    if (!url) return next(config, input, ctx);
    return executeWithHostBreaker(url, () => next(config, input, ctx), opts);
  };
}
