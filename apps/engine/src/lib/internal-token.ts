/**
 * Internal service-to-service (S2S) token — UN SOLO pattern, single source of truth.
 *
 * Storia: convivevano 3 meccanismi (audit MEDIUM "incoerenza"):
 *   1. `auth.ts` validava x-internal-token con un `constantTimeEquals` locale →
 *      settava `auth.userId='internal'`;
 *   2. `internal-runs-active.ts` ripeteva lo STESSO check timing-safe in 5
 *      endpoint (duplicazione + superficie d'errore);
 *   3. outbound runtime→portal leggeva `PORTAL_CALLBACK_TOKEN ?? MEDEA_INTERNAL_TOKEN`
 *      ripetuto in 4 file.
 *
 * Sono in realtà UN secret (`MEDEA_INTERNAL_TOKEN`; `PORTAL_CALLBACK_TOKEN` è
 * lo stesso valore col nome del contract portal-side) con 2 direzioni:
 *   - INBOUND  → `verifyInternalToken` / `requireInternalToken` (middleware);
 *   - OUTBOUND → `getOutboundPortalToken`.
 *
 * Stesso wire-protocol di prima (header `x-internal-token`, stesso secret) →
 * zero breakage, solo de-duplicazione.
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Confronto constant-time. `===` su stringhe fa short-circuit byte-per-byte →
 * timing-oracle per recovery progressivo del secret se l'attaccante misura RTT.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifica un token S2S inbound contro `MEDEA_INTERNAL_TOKEN` (timing-safe).
 * Fail-closed: secret non configurato o input vuoto → false.
 */
export function verifyInternalToken(provided: string): boolean {
  const expected = process.env.MEDEA_INTERNAL_TOKEN ?? '';
  if (expected === '' || provided === '') return false;
  return constantTimeEquals(provided, expected);
}

/**
 * Middleware Hono: richiede header `x-internal-token` valido, altrimenti 401.
 * Per gli endpoint /internal/* (S2S portal→runtime).
 */
export function requireInternalToken(): MiddlewareHandler {
  return async (c, next) => {
    // Fail-closed: secret non configurato (impossibile in prod — il boot genera
    // MEDEA_INTERNAL_TOKEN) o token errato/assente → 401. Nessun logging qui:
    // questo è un primitivo di sicurezza puro, NON deve accoppiare il logger
    // (lo trascinerebbe in mezzo codebase via auth.ts).
    if (!verifyInternalToken(c.req.header('x-internal-token') ?? '')) {
      return c.json({ error: 'invalid or missing internal token' }, 401);
    }
    return next();
  };
}

/**
 * Token che il runtime PRESENTA al portal (outbound: telemetry, metrics,
 * upgrade-info, template-cache). `PORTAL_CALLBACK_TOKEN` è il nome dell'env del
 * contract portal-side; fallback al per-process secret. Stringa vuota se nessuno
 * dei due è settato (il chiamante decide se abortire o loggare).
 */
export function getOutboundPortalToken(): string {
  return process.env.PORTAL_CALLBACK_TOKEN ?? process.env.MEDEA_INTERNAL_TOKEN ?? '';
}

/**
 * Token per il LOOPBACK del runtime verso SE STESSO (db-write executor,
 * workflow-control runWorkflow → POST http://127.0.0.1:3100/api/v1/...).
 *
 * Direzione DIVERSA da getOutboundPortalToken: il destinatario è il PROPRIO
 * auth middleware, che valida con `verifyInternalToken` ⇒ confronta SOLO con
 * `MEDEA_INTERNAL_TOKEN`. Usare PORTAL_CALLBACK_TOKEN (quando settato a un
 * valore diverso) qui darebbe 401 sul proprio endpoint. Per questo NON c'è
 * fallback al token del portal — è deliberatamente l'altro secret.
 */
export function getLoopbackInternalToken(): string {
  return process.env.MEDEA_INTERNAL_TOKEN ?? '';
}
