/**
 * actor.ts — extraction sicura di actorId per audit logging.
 *
 * Background (#194 H4 audit): 19+ endpoint runtime leggevano `actorId` da
 * header HTTP `x-actor-id` settabile dal client. Risultato: attaccante
 * autenticato spoofava l'identità in audit log (attribution forgery).
 *
 * Soluzione: leggere actorId SOLO da `c.get('auth').userId` (JWT/SSO-verified
 * dal authMiddleware). Header `x-actor-id` viene IGNORATO eccetto per chiamate
 * interne S2S (richiede x-internal-token che passa constantTimeEquals).
 *
 * Le route che chiamano sotto-systemi (es. lifecycle sweeper, cron purge)
 * passano `'system'` esplicito tramite `systemActor()` quando non c'e`
 * un utente reale.
 */

import type { Context } from 'hono';

/**
 * Recupera actorId per audit log dal context Hono autenticato.
 *
 * Priority:
 *   1. `auth.userId` (JWT/SSO/session verificata)
 *   2. Se `auth.userId === 'internal'` (S2S token) → accetta header x-actor-id
 *      come "actor delegato" (lo invoker S2S sa chi sta agendo per conto di).
 *   3. Fallback `null` se non autenticato (caller deve gestire).
 *
 * Non legge MAI header x-actor-id da request non-internal.
 */
export function getActorId(c: Context): string | null {
  const auth = c.get('auth');
  if (!auth) return null;
  // S2S internal call: il chiamante e` un service trusted (es. cron del
  // portal che invoca runtime). Può specificare l'actor delegato via header.
  if (auth.userId === 'internal') {
    const delegated = c.req.header('x-actor-id')?.trim();
    return delegated && delegated.length > 0 ? delegated : 'internal';
  }
  return auth.userId;
}

/**
 * Variante che lancia se non c'e` auth — utile per route che richiedono
 * actor sicuramente non-null (audit log mandatory).
 */
export function requireActorId(c: Context): string {
  const id = getActorId(c);
  if (!id) {
    throw new Error('Actor ID not available — caller must authenticate first');
  }
  return id;
}

/**
 * Marker per attribuire azioni a "system" (cron, sweeper, schedulato).
 * Usare invece di `'system'` letterale per grep-ability + cambio futuro.
 */
export const SYSTEM_ACTOR_ID = 'system';

export function systemActor(): string {
  return SYSTEM_ACTOR_ID;
}
