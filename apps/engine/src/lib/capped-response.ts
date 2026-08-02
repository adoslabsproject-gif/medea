/**
 * Lettura CAPPATA del body di una `Response` — anti-OOM.
 *
 * ⚠️ Il primitivo REALE ora vive in `@medea/engine-safe-fetch` (sorgente UNICA),
 * così che ANCHE i package dei nodi (llm, ai-agents, integrations-italia, db…)
 * — che non possono importare da `apps/` — usino lo stesso cap. Prima stava qui
 * (app-only) e quei nodi restavano scoperti → OOM. Questo modulo è un semplice
 * re-export per non rompere i ~49 import esistenti `@/lib/capped-response.js`.
 *
 * @module lib/capped-response
 */
export {
  DEFAULT_RESPONSE_CAP_BYTES,
  readTextCapped,
  readJsonCapped,
  readTextTruncated,
  readBytesCapped,
} from '@medea/engine-safe-fetch';
