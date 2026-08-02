/**
 * `action_odoo_update_activity` — NodeModule.
 *
 * @module actions/odoo_update_activity
 */

import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { odooUpdateActivityNodeDef } from './definition.js';
import { odooUpdateActivityExecutor } from './executor.js';

export const odooUpdateActivityActionNode: NodeModule = {
  def: odooUpdateActivityNodeDef,
  executor: wrap(odooUpdateActivityExecutor, [
    httpMiddlewarePreset({
      urlFrom: (c) => {
        const u = c.baseUrl;
        return typeof u === 'string' && u.length > 0 ? u : undefined;
      },
      methodFrom: () => 'POST',
    }),
  ]),
};

export { odooUpdateActivityExecutor, odooUpdateActivityNodeDef };
export { OdooUpdateActivityConfigSchema, type OdooUpdateActivityConfig } from './schema.js';
