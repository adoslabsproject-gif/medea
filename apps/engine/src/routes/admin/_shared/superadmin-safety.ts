/**
 * superadmin-safety — policy anti-lockout per le azioni admin cross-tenant del
 * RUNTIME (role change + enabled toggle), gemella di `action-guard` del portal.
 *
 * Motivazione (audit 2026-07-02, finding #6): `PATCH /admin/users/:id/role` e
 * `/enabled` non avevano ALCUNA protezione. Un superadmin poteva:
 *   1. SELF-LOCKOUT — declassare o disabilitare SE STESSO → fuori dalla console.
 *   2. LAST-SUPERADMIN — declassare/disabilitare l'ULTIMO superadmin ATTIVO →
 *      console cross-tenant PERMANENTEMENTE inaccessibile (requireSuperAdmin()
 *      richiede role==='superadmin', nessun recovery via UI).
 *
 * Design: decisione PURA (`evaluateSuperadminSafety`) separata dall'I/O DB
 * (`countEnabledSuperadmins`) → testabile al 100% senza database, e il conteggio
 * "attivi" è iniettato dal chiamante (già lo legge per altri motivi).
 *
 * @module routes/admin/_shared/superadmin-safety
 */

export type SuperadminUnsafeReason = 'self_target' | 'last_superadmin';

export interface SuperadminSafetyInput {
  /** 'role' = cambio ruolo · 'enabled' = toggle enabled/disabled. */
  kind: 'role' | 'enabled';
  /** userId dell'attore (da auth). `undefined` = attore ignoto (trattato ≠ target). */
  actorUserId: string | undefined;
  /** Stato ATTUALE del target, letto dal DB PRIMA della mutazione. */
  target: { id: string; role: string; enabled: boolean };
  /** Nuovo ruolo (solo kind='role'). */
  newRole?: string;
  /** Nuovo stato enabled (solo kind='enabled'). */
  newEnabled?: boolean;
  /**
   * Numero di superadmin ATTIVI (role==='superadmin' AND enabled) nel sistema,
   * INCLUSO il target se attivo. Letto dal DB dal chiamante.
   */
  activeSuperadminCount: number;
}

export interface SuperadminSafetyResult {
  allowed: boolean;
  reason?: SuperadminUnsafeReason;
}

const SUPERADMIN = 'superadmin';

/**
 * Decide se la mutazione è consentita. Ritorna `{ allowed:false, reason }` sui
 * due casi di auto-danno; `{ allowed:true }` altrimenti.
 *
 * Un'operazione è "rimuovente" se toglie al target il suo status di superadmin
 * attivo: role → un ruolo ≠ superadmin, oppure enabled → false. Solo le
 * operazioni rimuoventi possono violare la policy; promuovere/abilitare è sempre
 * sicuro rispetto al lockout.
 */
export function evaluateSuperadminSafety(input: SuperadminSafetyInput): SuperadminSafetyResult {
  const { kind, actorUserId, target, newRole, newEnabled, activeSuperadminCount } = input;

  const isRemoving =
    kind === 'role'
      ? newRole !== undefined && newRole !== SUPERADMIN && target.role === SUPERADMIN
      : newEnabled === false && target.enabled && target.role === SUPERADMIN;

  // Nessun impatto sul pool di superadmin attivi → sempre consentito.
  if (!isRemoving) return { allowed: true };

  // 1. SELF — non ci si taglia fuori da soli dal pannello.
  if (actorUserId !== undefined && actorUserId === target.id) {
    return { allowed: false, reason: 'self_target' };
  }

  // 2. LAST — il target contribuisce al pool solo se attualmente attivo.
  const targetContributes = target.role === SUPERADMIN && target.enabled;
  const remainingAfter = targetContributes ? activeSuperadminCount - 1 : activeSuperadminCount;
  if (remainingAfter <= 0) {
    return { allowed: false, reason: 'last_superadmin' };
  }

  return { allowed: true };
}

/** Errore 403 strutturato — la UI/forensics discrimina il motivo. */
export class SuperadminSafetyError extends Error {
  readonly status = 403 as const;
  readonly code = 'SUPERADMIN_SAFETY' as const;
  readonly reason: SuperadminUnsafeReason;
  constructor(reason: SuperadminUnsafeReason) {
    super(
      reason === 'self_target'
        ? 'Operazione non consentita sul proprio account superadmin dal pannello admin (rischio auto-lockout).'
        : 'Operazione bloccata: è l\'ultimo superadmin attivo. Promuovi/abilita prima un altro superadmin.',
    );
    this.name = 'SuperadminSafetyError';
    this.reason = reason;
  }
}

/** Lancia `SuperadminSafetyError` se la policy vieta la mutazione. */
export function assertSuperadminSafe(input: SuperadminSafetyInput): void {
  const res = evaluateSuperadminSafety(input);
  if (!res.allowed && res.reason) throw new SuperadminSafetyError(res.reason);
}

/**
 * Conta i superadmin ATTIVI (role='superadmin' AND enabled=1) via better-sqlite3
 * sincrono. Iniettabile nei test; usato dai route handler admin/users.
 */
export function countEnabledSuperadmins(sqlite: {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
}): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND enabled = 1")
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}
