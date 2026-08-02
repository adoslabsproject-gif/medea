/**
 * Server-only entry — runtime helpers that touch Node-only APIs.
 *
 * Consumers
 * ─────────
 * Imported by `apps/engine` (and any other Node-only consumer)
 * via the package sub-path:
 *
 *   import { signTrackingToken, injectTracking } from '@medea/engine-nodes-stdlib/server';
 *
 * The browser editor SPA must NOT import this entry — it pulls in
 * `node:crypto` top-level (HMAC + timing-safe compare). The root
 * barrel `@medea/engine-nodes-stdlib` keeps only the browser-safe pieces
 * (NodeDef, Zod schema, pure scheduler, types).
 *
 * @module server
 */

// Email tracking — HMAC token + bot detection (uses node:crypto).
export {
  signTrackingToken,
  verifyTrackingToken,
  isTrackingBot,
  DEFAULT_TOKEN_TTL_SECONDS,
} from './lib/email-tracking-token.js';

// Email tracking — body injection (depends on the HMAC signer).
export {
  injectTracking,
  shouldRewrite,
  newSendId,
  type InjectArgs,
  type InjectResult,
} from './actions/email_send_tracked/body-injector.js';
