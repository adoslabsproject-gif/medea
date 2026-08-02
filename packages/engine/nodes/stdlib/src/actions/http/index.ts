/**
 * HTTP node v3.0 — assemblaggio definitivo (NodeDef + wrapped executor).
 *
 * Wrappa l'executor con il preset HTTP standard:
 *   • withErrorMapping  — converte throw legacy in NodeError
 *   • withAbortGuard    — short-circuit su cancel utente
 *   • withTelemetry     — span OTel con http.* attrs
 *   • withHostBreaker   — per-host circuit breaker (5 failures → open 30s)
 *
 * I middleware sono OUTERMOST: telemetry registra anche errori di parse config,
 * breaker conta failure verso lo stesso host anche se il config era invalido
 * (utile per detect attacchi).
 */

import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { httpNodeDef } from './definition.js';
import { httpExecutor } from './executor.js';

export const httpActionNode: NodeModule = {
  def: httpNodeDef,
  executor: wrap(httpExecutor, [
    httpMiddlewarePreset({
      urlFrom: (c) => {
        const u = c.url;
        return typeof u === 'string' && u.length > 0 ? u : undefined;
      },
      methodFrom: (c) => {
        const m = c.method;
        return typeof m === 'string' ? m.toUpperCase() : 'GET';
      },
    }),
  ]),
};

export { httpExecutor, httpNodeDef };
export { HttpConfigSchema, type HttpConfig } from './schema.js';
