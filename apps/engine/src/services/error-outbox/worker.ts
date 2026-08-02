/**
 * error-outbox worker — consuma le righe "dovute" e le dispatcha, con retry/backoff
 * e dead-letter (#2). Per-canale INDIPENDENTE (#5): ogni riga è un singolo canale,
 * il fallimento di una NON ferma le altre.
 *
 * I dispatcher per-canale sono INIETTATI (DI) → il worker è testabile senza I/O
 * reale (webhook/SMTP/fan-out). Ogni dispatcher DEVE throware sul fallimento
 * (→ retry o dead); il successo (return) → 'done'.
 *
 * Idempotenza/at-least-once: un dispatch può ripetersi (es. crash dopo l'invio ma
 * prima del markDone) → i canali devono essere idempotenti dove conta (il fan-out
 * usa l'Idempotency a valle; webhook/email accettano un possibile doppione raro,
 * trade-off classico at-least-once).
 */

import { logger } from '@/lib/logger.js';
import type { SqliteCompatProxy } from '@/storage/db.js';
import type { ErrorOutboxChannel } from '@/storage/schema.js';
import {
  claimDueErrorEvents,
  markErrorEventDone,
  markErrorEventRetry,
  markErrorEventDead,
  type ErrorOutboxRecord,
} from './repository.js';
import { nextRetryDecision } from './retry-policy.js';

/** Un dispatcher consegna l'evento sul suo canale. DEVE throware sul fallimento. */
export type ChannelDispatcher = (ev: ErrorOutboxRecord) => Promise<void>;

export interface OutboxWorkerDeps {
  sqlite: SqliteCompatProxy;
  dispatchers: Record<ErrorOutboxChannel, ChannelDispatcher>;
  /** Iniettabile per i test (tempo deterministico). */
  now?: () => Date;
}

export interface OutboxSweepResult {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

/**
 * Esegue UNA sweep: claim dei dovuti (max `limit`), dispatch indipendente per riga,
 * mark done/retry/dead. Non throwa: un canale che esplode è isolato (catch → retry/dead).
 */
export async function runOutboxSweepOnce(
  deps: OutboxWorkerDeps,
  limit = 50,
): Promise<OutboxSweepResult> {
  const now = deps.now ?? ((): Date => new Date());
  const due = claimDueErrorEvents(deps.sqlite, now().toISOString(), limit);
  const res: OutboxSweepResult = { claimed: due.length, done: 0, retried: 0, dead: 0 };

  for (const ev of due) {
    const dispatcher = deps.dispatchers[ev.channel];
    if (!dispatcher) {
      // Canale ignoto (schema evoluto male / riga corrotta): dead, non ri-claimare in loop.
      markErrorEventDead(deps.sqlite, ev.id, `no dispatcher for channel '${ev.channel}'`);
      res.dead += 1;
      continue;
    }
    try {
      await dispatcher(ev);
      markErrorEventDone(deps.sqlite, ev.id);
      res.done += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const decision = nextRetryDecision(ev.attempts, now());
      if (decision.kind === 'dead') {
        markErrorEventDead(deps.sqlite, ev.id, msg);
        res.dead += 1;
        logger.error(
          {
            outboxId: ev.id,
            channel: ev.channel,
            runId: ev.runId,
            attempts: ev.attempts + 1,
            err: msg,
          },
          '[error-outbox] DEAD-LETTER: dispatch fallito oltre il max — non ritento più',
        );
      } else {
        markErrorEventRetry(deps.sqlite, ev.id, decision.nextAttemptAt, msg);
        res.retried += 1;
      }
    }
  }
  return res;
}
