/**
 * Core foundation — barrel.
 *
 * Esporta tutto cio\` che un executor v2 necessita: Result type, NodeError
 * hierarchy, middleware pipeline, idempotency store, telemetry, breaker.
 *
 * Import pattern:
 *
 *   import { wrap, withErrorMapping, httpMiddlewarePreset, parseConfig, ok, err }
 *     from '../core/index.js';
 */

export * from './result.js';
export * from './node-error.js';
export * from './idempotency.js';
export * from './idempotency-migrating.js';
export * from './telemetry.js';
export * from './host-circuit-breaker.js';
export * from './config-parser.js';
export * from './middleware.js';
