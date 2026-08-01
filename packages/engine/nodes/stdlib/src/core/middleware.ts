/**
 * Middleware — re-export back-compat.
 *
 * L'implementazione e\` stata splittata in `./middleware/` (v3.0.1):
 *   • compose.ts        — compose / wrap / type Middleware
 *   • telemetry.ts      — withTelemetry
 *   • idempotency.ts    — withIdempotency + withConditionalIdempotency
 *   • host-breaker.ts   — withHostBreaker
 *   • error-handling.ts — withErrorMapping + withAbortGuard
 *   • presets.ts        — httpMiddlewarePreset
 *   • index.ts          — barrel
 *
 * Questo file resta come entry-point storico — i consumer che importano
 * `core/middleware.js` vedono lo stesso API surface (zero breaking changes).
 *
 * Razionale split: la regola CLAUDE.md "no monoliti > 250 LOC" stava
 * violata (281 righe). Split per dominio (telemetry/idempotency/breaker/
 * error-handling/presets) rende il diff-review pulito + ogni file naviga
 * in <100 righe.
 */

export * from './middleware/index.js';
