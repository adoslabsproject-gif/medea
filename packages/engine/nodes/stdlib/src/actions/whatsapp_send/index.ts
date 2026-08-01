/**
 * `action_whatsapp_send` — NodeModule + middleware wrap.
 *
 * @module actions/whatsapp_send
 */

import type { NodeModule } from '../../types.js';
import { wrap, httpMiddlewarePreset } from '../../core/middleware.js';
import { whatsAppSendNodeDef } from './definition.js';
import { whatsAppSendExecutor } from './executor.js';

export const whatsAppSendActionNode: NodeModule = {
  def: whatsAppSendNodeDef,
  executor: wrap(whatsAppSendExecutor, [
    httpMiddlewarePreset({
      urlFrom: () => 'https://graph.facebook.com',
      methodFrom: () => 'POST',
    }),
  ]),
};

export { whatsAppSendExecutor, whatsAppSendNodeDef };
export { WhatsAppSendConfigSchema, type WhatsAppSendConfig } from './schema.js';
