/**
 * Middleware barrel — re-export di compose/wrap + 6 built-in.
 *
 * Pattern Koa-style adattato a `NodeExecutor`:
 *   type Middleware = (next: NodeExecutor) => NodeExecutor
 *
 * Built-in (vedi singoli file per dettagli):
 *   • withErrorMapping            — throw → NodeError
 *   • withAbortGuard              — abortSignal short-circuit
 *   • withTelemetry               — OTel span flowforge.*
 *   • withIdempotency             — lock runId+nodeId TTL run-aware
 *   • withConditionalIdempotency  — RFC 7231 safe-methods skip
 *   • withHostBreaker             — per-host CircuitBreaker
 *
 * Preset:
 *   • httpMiddlewarePreset        — compose ottimale per nodi HTTP outbound
 *
 * I file singoli sono < 100 righe ognuno (sotto la regola soft 250) per
 * navigazione + diff-review piu\` rapidi vs un monolite 260+ righe.
 */

export type { Middleware } from './compose.js';
export { compose, wrap } from './compose.js';
export { withTelemetry, type TelemetryOptions } from './telemetry.js';
export {
  withIdempotency,
  withConditionalIdempotency,
  type IdempotencyMiddlewareOptions,
} from './idempotency.js';
export { withHostBreaker, type HostBreakerMiddlewareOptions } from './host-breaker.js';
export { withErrorMapping, withAbortGuard } from './error-handling.js';
export { httpMiddlewarePreset, type HttpPresetOptions } from './presets.js';

// Re-export degli type comuni (back-compat con import legacy
// `from '../core/middleware.js'`).
export type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from '../../types.js';
