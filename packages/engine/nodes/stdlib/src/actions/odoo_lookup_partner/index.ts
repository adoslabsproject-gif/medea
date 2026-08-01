/**
 * `action_odoo_lookup_partner` — NodeModule.
 *
 * @module actions/odoo_lookup_partner
 */

import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { odooLookupPartnerNodeDef } from './definition.js';
import { odooLookupPartnerExecutor } from './executor.js';

export const odooLookupPartnerActionNode: NodeModule = {
  def: odooLookupPartnerNodeDef,
  executor: wrap(odooLookupPartnerExecutor, [
    httpMiddlewarePreset({
      urlFrom: (c) => {
        const u = (c).baseUrl;
        return typeof u === 'string' && u.length > 0 ? u : undefined;
      },
      methodFrom: () => 'POST',
    }),
  ]),
};

export { odooLookupPartnerExecutor, odooLookupPartnerNodeDef };
export {
  OdooLookupPartnerConfigSchema,
  type OdooLookupPartnerConfig,
} from './schema.js';
