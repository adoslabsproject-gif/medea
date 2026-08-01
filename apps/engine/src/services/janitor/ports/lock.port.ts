/**
 * Port — ILockGateway.
 *
 * Lock distribuito named per regola. L'implementazione SqliteLockGateway
 * usa la tabella `janitor_locks` con TTL + DELETE auto. Su Postgres
 * (futuro) si userebbe `pg_advisory_lock` — l'astrazione regge.
 *
 * Contratto:
 *   • `acquire()` ritorna true se acquisito, false se occupato.
 *   • TTL: dopo `ttlMs` ms il lock scade automaticamente — protegge
 *     da processi crashati.
 *   • `release()` filtra per `holderId`: un processo non rilascia
 *     un lock che non ha acquisito.
 *   • `cleanupStale()` al boot per pulizia esplicita (no operational dependency).
 */

export interface ILockGateway {
  acquire(key: string, holderId: string, ttlMs: number): boolean;
  release(key: string, holderId: string): void;
  cleanupStale(): number;
  listActive(): readonly LockEntry[];
}

export interface LockEntry {
  readonly key: string;
  readonly heldBy: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}
