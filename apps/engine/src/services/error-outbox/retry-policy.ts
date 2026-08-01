/**
 * Politica di retry/dead-letter dell'outbox (PURA → bug-bounty testabile).
 *
 * #2 (review): at-least-once + backoff, MA con CAPOLINEA. Un evento poison che
 * fallisce sempre deve finire in dead-letter dopo OUTBOX_MAX_ATTEMPTS, non
 * ritentare in eterno né bloccare la coda. Backoff esponenziale con cap, così un
 * ricevitore lento non si mangia tutti i tentativi a raffica.
 */

/** Tentativi totali massimi prima del dead-letter (incluso il 1°). */
export const OUTBOX_MAX_ATTEMPTS = 6;
/** Ritardo base del backoff (primo retry). */
export const OUTBOX_BASE_DELAY_MS = 30_000; // 30s
/** Cap del ritardo (un poison non aspetta giorni tra un tentativo e l'altro). */
export const OUTBOX_MAX_DELAY_MS = 3_600_000; // 1h

export type RetryDecision =
  | { kind: 'retry'; nextAttemptAt: string }
  | { kind: 'dead' };

/**
 * Decide il destino di un evento dopo un fallimento di dispatch.
 *
 * @param attemptsBefore  `attempts` della riga PRIMA di questo fallimento
 *                        (markRetry/markDead poi lo incrementano di 1).
 */
export function nextRetryDecision(attemptsBefore: number, now: Date): RetryDecision {
  const attemptsAfter = attemptsBefore + 1;
  if (attemptsAfter >= OUTBOX_MAX_ATTEMPTS) {
    return { kind: 'dead' };
  }
  const delay = Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_BASE_DELAY_MS * 2 ** attemptsBefore);
  return { kind: 'retry', nextAttemptAt: new Date(now.getTime() + delay).toISOString() };
}
