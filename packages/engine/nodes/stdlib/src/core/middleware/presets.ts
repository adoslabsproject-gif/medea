/**
 * httpMiddlewarePreset — composizione "ready-to-use" per nodi HTTP outbound.
 *
 * Pipeline (outer → inner):
 *   1. withErrorMapping              — ogni throw → NodeError tipato
 *   2. withAbortGuard                — short-circuit cancel
 *   3. withTelemetry                 — OTel span http.* attrs
 *   4. withConditionalIdempotency    — POST/PUT/PATCH/DELETE → lock
 *   5. withHostBreaker               — per-host 5 fail → open 30s
 */

import { compose, type Middleware } from './compose.js';
import { withTelemetry } from './telemetry.js';
import { withConditionalIdempotency, type IdempotencyMiddlewareOptions } from './idempotency.js';
import { withHostBreaker } from './host-breaker.js';
import { withErrorMapping, withAbortGuard } from './error-handling.js';
import { httpSpanAttrs } from '../telemetry.js';
import type { HostBreakerOptions } from '../host-circuit-breaker.js';

export interface HttpPresetOptions {
  urlFrom: (config: Record<string, unknown>) => string | undefined;
  methodFrom?: (config: Record<string, unknown>) => string;
  breaker?: HostBreakerOptions;
  idempotencyStore?: IdempotencyMiddlewareOptions['store'];
  idempotencyTtlMs?: number;
}

export function httpMiddlewarePreset(opts: HttpPresetOptions): Middleware {
  const methodFrom = opts.methodFrom ?? (() => 'GET');
  return compose([
    withErrorMapping(),
    withAbortGuard(),
    withTelemetry({
      spanName: 'node.http.request',
      dynamicAttrs: (config) => {
        const url = opts.urlFrom(config);
        const method = methodFrom(config);
        return url ? httpSpanAttrs(method, url) : {};
      },
    }),
    withConditionalIdempotency({
      methodFrom,
      ...(opts.idempotencyStore ? { store: opts.idempotencyStore } : {}),
      ...(opts.idempotencyTtlMs !== undefined ? { ttlMs: opts.idempotencyTtlMs } : {}),
    }),
    withHostBreaker({ ...(opts.breaker ?? {}), urlFrom: opts.urlFrom }),
  ]);
}
