/**
 * OpenAPI Connector node — assemblaggio NodeDef + executor con il preset HTTP
 * standard (error-mapping, abort-guard, telemetry, host breaker).
 *
 * httpMiddlewarePreset è una factory function (HttpPresetOptions → Middleware).
 * `wrap` invece accetta Middleware[] → bisogna invocare il preset con opts
 * e passare l'array risultante.
 */
import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { openapiNodeDef } from './definition.js';
import { openapiExecutor } from './executor.js';

export const openapiActionNode: NodeModule = {
  def: openapiNodeDef,
  executor: wrap(openapiExecutor, [
    httpMiddlewarePreset({
      urlFrom: (config) => {
        const baseUrl = config.baseUrl;
        return typeof baseUrl === 'string' ? baseUrl : '';
      },
      methodFrom: (config) => {
        const m = config.method;
        return typeof m === 'string' ? m.toUpperCase() : 'GET';
      },
    }),
  ]),
};
