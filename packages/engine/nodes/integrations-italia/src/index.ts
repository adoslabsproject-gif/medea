/**
 * @flowforge/nodes-integrations-italia
 *
 * Italian-market connectors. These are the moat: n8n doesn't ship them
 * and won't, because the IT market is too small for them to prioritise.
 *
 * STATUS: all nodes below are SCAFFOLDS. Each NodeDef is correct + complete
 * (palette renders cleanly). Executors call the documented endpoint shape
 * but real customers will need:
 *   - PEC Aruba: SOAP credentials + their test environment access
 *   - Fatture in Cloud: OAuth2 app registration on developers.fattureincloud.it
 *   - SDI/AdE: certificato qualificato di firma + accesso al canale SDICoop
 *   - Aruba PEC standalone: account PEC attivo
 *   - Zucchetti HR: contract IDP/HRGO + token API negotiated per customer
 *
 * Documentation links in each connector point to the vendor's official API docs.
 */

import type { NodeModule } from '@flowforge/nodes-stdlib';
import { pecArubaSend, pecArubaReceive } from './pec-aruba/index.js';
import { fattureInCloudInvoice, fattureInCloudClient } from './fatture-in-cloud/index.js';
import { sdiSendInvoice, sdiCheckStatus } from './sdi-adel/index.js';
import { p7mExtract, fatturapaParse } from './sdi-adel/inbound.js';
import { zucchettiPayroll } from './zucchetti/index.js';
import { registerItDomain } from './register-it/index.js';
import { odooNode } from './odoo/index.js';
import { wordpressNode } from './wordpress/index.js';
import { woocommerceNode } from './woocommerce/index.js';

export const italianConnectors: readonly NodeModule[] = [
  pecArubaSend,
  pecArubaReceive,
  fattureInCloudInvoice,
  fattureInCloudClient,
  sdiSendInvoice,
  sdiCheckStatus,
  p7mExtract,
  fatturapaParse,
  zucchettiPayroll,
  registerItDomain,
  odooNode,
  wordpressNode,
  woocommerceNode,
] as const;

export {
  pecArubaSend,
  pecArubaReceive,
  fattureInCloudInvoice,
  fattureInCloudClient,
  sdiSendInvoice,
  sdiCheckStatus,
  p7mExtract,
  fatturapaParse,
  zucchettiPayroll,
  registerItDomain,
  odooNode,
  wordpressNode,
  woocommerceNode,
};
