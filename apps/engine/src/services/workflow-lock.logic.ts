/**
 * Workflow editing lock — logica decisionale PURA (Tier 1 multi-user, gap #7).
 *
 * Lock pessimistico: un solo utente edita un workflow per volta; gli altri lo
 * vedono in sola lettura con un banner "X sta editando". Il lock scade se chi
 * lo detiene smette di mandare heartbeat (chiusura tab, crash) → niente lock
 * orfani che bloccano il workflow per sempre.
 *
 * Questa funzione decide SOLO l'esito di una richiesta di acquisizione dato lo
 * stato corrente; il service la usa sopra il DB (persistenza + heartbeat).
 */

export interface LockState {
  userId: string;
  userName: string;
  /** Epoch ms dell'ultimo heartbeat. */
  heartbeatAt: number;
}

export type LockDecision =
  | { ok: true; reason: 'free' | 'reacquired' | 'takeover_expired' }
  | { ok: false; reason: 'held'; by: { userId: string; userName: string } };

/** TTL di default: senza heartbeat per più di questo, il lock è considerato scaduto. */
export const LOCK_TTL_MS = 45_000;

/**
 * Decide se `requester` può acquisire il lock di un workflow.
 *   • nessun lock → ok (free)
 *   • lock dello stesso utente → ok (reacquired, rinnova)
 *   • lock di altro utente ma SCADUTO (no heartbeat oltre TTL) → ok (takeover)
 *   • lock di altro utente ANCORA VIVO → rifiutato (held), con chi lo detiene
 */
export function evaluateLockAcquire(
  current: LockState | null,
  requesterId: string,
  now: number,
  ttlMs: number = LOCK_TTL_MS,
): LockDecision {
  if (!current) return { ok: true, reason: 'free' };
  if (current.userId === requesterId) return { ok: true, reason: 'reacquired' };
  if (now - current.heartbeatAt > ttlMs) return { ok: true, reason: 'takeover_expired' };
  return { ok: false, reason: 'held', by: { userId: current.userId, userName: current.userName } };
}

/** True se il lock corrente è considerato vivo (heartbeat recente). */
export function isLockAlive(
  current: LockState | null,
  now: number,
  ttlMs: number = LOCK_TTL_MS,
): boolean {
  return current !== null && now - current.heartbeatAt <= ttlMs;
}
