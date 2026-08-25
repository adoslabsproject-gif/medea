/**
 * `action_contact_lookup` — NodeModule export.
 *
 * Solo la `NodeDef`: l'executor vero sta in
 * `apps/engine/src/executors/contact-lookup.ts`, dove `better-sqlite3` e il
 * percorso del database di Medea sono già in casa.
 *
 * @module actions/contact_lookup
 */

import type { NodeModule } from '../../types.js';
import { contactLookupNodeDef } from './definition.js';

export const contactLookupNode: NodeModule = {
  def: contactLookupNodeDef,
};

export { contactLookupNodeDef };
export { ContactLookupConfigSchema, type ContactLookupConfig } from './schema.js';
