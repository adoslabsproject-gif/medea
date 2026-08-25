/**
 * `action_email_move` — NodeModule export.
 *
 * Stesso schema di `action_email_send_tracked`: qui c'è **solo** la `NodeDef`
 * (metadati per l'interfaccia e per il modello). L'executor vero vive in
 * `apps/engine/src/executors/email-move.ts`, dove `imapflow` e gli account
 * email del tenant sono già in casa — questo pacchetto resta senza dipendenze
 * pesanti e continua a compilarsi ovunque.
 *
 * @module actions/email_move
 */

import type { NodeModule } from '../../types.js';
import { emailMoveNodeDef } from './definition.js';

export const emailMoveNode: NodeModule = {
  def: emailMoveNodeDef,
};

export { emailMoveNodeDef };
export { EmailMoveConfigSchema, type EmailMoveConfig } from './schema.js';
