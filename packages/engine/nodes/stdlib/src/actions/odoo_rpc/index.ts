/**
 * `action_odoo_rpc` — NodeModule + middleware wrap.
 *
 * @module actions/odoo_rpc
 */

import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { odooRpcNodeDef } from './definition.js';
import { odooRpcExecutor } from './executor.js';

export const odooRpcActionNode: NodeModule = {
  def: odooRpcNodeDef,
  executor: wrap(odooRpcExecutor, [
    httpMiddlewarePreset({
      urlFrom: (c) => {
        const u = c.baseUrl;
        return typeof u === 'string' && u.length > 0 ? u : undefined;
      },
      methodFrom: () => 'POST',
    }),
  ]),
};

export { odooRpcExecutor, odooRpcNodeDef };
export {
  OdooRpcConfigSchema,
  ODOO_OPERATIONS,
  type OdooRpcConfig,
  type OdooOperation,
} from './schema.js';
