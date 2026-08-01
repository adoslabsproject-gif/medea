/**
 * `action_odoo_create_lead` — NodeModule.
 *
 * @module actions/odoo_create_lead
 */

import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { odooCreateLeadNodeDef } from './definition.js';
import { odooCreateLeadExecutor } from './executor.js';

export const odooCreateLeadActionNode: NodeModule = {
  def: odooCreateLeadNodeDef,
  executor: wrap(odooCreateLeadExecutor, [
    httpMiddlewarePreset({
      urlFrom: (c) => {
        const u = (c).baseUrl;
        return typeof u === 'string' && u.length > 0 ? u : undefined;
      },
      methodFrom: () => 'POST',
    }),
  ]),
};

export { odooCreateLeadExecutor, odooCreateLeadNodeDef };
export {
  OdooCreateLeadConfigSchema,
  type OdooCreateLeadConfig,
} from './schema.js';
