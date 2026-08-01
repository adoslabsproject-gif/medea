/**
 * user-revocation — propagazione portal→runtime della revoca identità (F3,
 * 2026-07-06).
 *
 * Problema: quando il portal rimuove/sospende/anonimizza un utente o ne revoca
 * le sessioni, il container tenant NON ne sapeva nulla → il cookie `ff_session`
 * (JWT stateless, TTL fino a 12h/7gg) restava valido e i dati PII dell'utente
 * (email + display_name, provisionati via SSO in `users`) restavano nel SQLite
 * del tenant a tempo indefinito = accesso residuo + violazione right-to-erasure.
 *
 * Fix: il portal chiama best-effort `POST /api/v1/internal/workspace/user-revoked`
 * → qui. Identifichiamo l'utente per EMAIL (chiave naturale cross-system: il
 * portal conosce l'email, non l'id locale nanoid del runtime) e:
 *   - SEMPRE: revochiamo TUTTE le sessioni attive (cutoff → il middleware auth
 *     rifiuta ogni token con iat < cutoff). Riusa session-revocation.
 *   - scrubPii=true (rimozione membro / anonimizzazione GDPR): anonimizziamo
 *     email+display_name e disabilitiamo la riga → niente PII residua, e un
 *     eventuale re-SSO non riattiva l'account (enabled=0).
 */
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { revokeAllUserSessions } from './session-revocation.js';

const log = logger;

export interface RevokeWorkspaceUserInput {
  /** Email dell'utente (chiave naturale portal↔runtime). */
  email: string;
  /** true = anonimizza PII + disabilita la riga (remove/anonymize GDPR). */
  scrubPii?: boolean;
}

export interface RevokeWorkspaceUserResult {
  /** L'utente esisteva nel SQLite tenant (era entrato almeno una volta via SSO). */
  found: boolean;
  /** Sessioni attive revocate (cutoff impostato). */
  sessionsRevoked: boolean;
  /** PII anonimizzata + riga disabilitata. */
  piiScrubbed: boolean;
}

/**
 * Revoca l'accesso di un utente al tenant. Idempotente. Best-effort per design:
 * l'utente potrebbe non aver mai fatto SSO nel container (found=false) — non è
 * un errore, semplicemente non c'è nulla da revocare/scrubbare qui.
 */
export function revokeWorkspaceUser(input: RevokeWorkspaceUserInput): RevokeWorkspaceUserResult {
  const { sqlite } = getDatabase();
  const row = sqlite
    .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
    .get(input.email) as { id: string } | undefined;

  if (!row) {
    return { found: false, sessionsRevoked: false, piiScrubbed: false };
  }

  // SEMPRE: revoca tutte le sessioni (cutoff per-utente). Idempotente.
  revokeAllUserSessions(row.id);

  let piiScrubbed = false;
  if (input.scrubPii === true) {
    // Anonimizzazione deterministica sull'id locale: email univoca (rispetta
    // users_tenant_email_idx) e non-riconducibile all'originale; enabled=0
    // impedisce che un re-SSO riattivi l'account.
    const anonEmail = `revoked-${row.id}@anonymized.flowforge`;
    sqlite
      .prepare('UPDATE users SET email = ?, display_name = ?, enabled = 0, updated_at = ? WHERE id = ?')
      .run(anonEmail, 'Deleted User', new Date().toISOString(), row.id);
    piiScrubbed = true;
  }

  log.info?.({ userId: row.id, scrubbed: piiScrubbed }, '[SECURITY] workspace user revoked (portal→runtime, F3)');
  return { found: true, sessionsRevoked: true, piiScrubbed };
}
