/**
 * Constants browser-safe per la suite tracking — separati dal lib token
 * principale, che importa `node:crypto` top-level (server-only).
 *
 * Esposti dal barrel root (`@flowforge/nodes-stdlib`) cosi\` l'editor SPA
 * puo\` usarli senza pullare il modulo crypto.
 *
 * @module lib/email-tracking-token-constants
 */

/** Default TTL: 60 days. Emails get opened long after they arrive. */
export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60;
