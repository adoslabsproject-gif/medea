/**
 * Le esecuzioni programmate che sono passate mentre nessuno ascoltava.
 *
 * Lo scheduler valuta le espressioni cron una volta al minuto, sull'istante
 * presente: se il minuto giusto passa mentre il processo non c'è — Medea
 * chiusa, computer sospeso, riavvio — quell'esecuzione non avviene, e nessuno
 * se ne accorge. Per un cron delle otto del mattino su un portatile che di
 * notte dorme, «nessuno se ne accorge» significa che il workflow non è mai
 * partito e l'utente lo scopre dal risultato mancante.
 *
 * Qui si guarda indietro: dall'ultima esecuzione registrata a ora, si cercano
 * i minuti in cui il cron sarebbe scattato.
 *
 * **Si recupera una volta sola.** Un cron orario dopo tre giorni di
 * spegnimento ha settantadue scadenze mancate: eseguirle tutte vorrebbe dire
 * settantadue esecuzioni in fila — settantadue email, settantadue chiamate a
 * un'API a pagamento. Il senso del recupero è «questo lavoro non è stato
 * fatto, fallo», non «rifai tutta la storia».
 *
 * @module services/scheduler/missed-runs
 */

import { and, desc, eq } from 'drizzle-orm';

import { getDatabase } from '@/storage/db.js';
import { runs } from '@/storage/schema.js';

/**
 * Quanto indietro ha senso guardare. Oltre una settimana di inattività il
 * recupero non è più tale: è un'esecuzione che arriva senza contesto, per un
 * lavoro che nel frattempo qualcuno avrà fatto in altro modo.
 */
export const MAX_CATCHUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Un minuto in millisecondi: il passo con cui si cammina indietro nel tempo. */
const ONE_MINUTE_MS = 60_000;

/**
 * L'istante dell'ultima esecuzione da cron registrata per un workflow.
 *
 * `null` se non ce n'è mai stata una: un workflow appena attivato non ha
 * scadenze mancate: le sue cominciano adesso.
 */
export async function lastCronRunAt(workflowId: string): Promise<Date | null> {
  const { db } = getDatabase();
  const rows = await db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.workflowId, workflowId), eq(runs.triggerType, 'cron')))
    .orderBy(desc(runs.startedAt))
    .limit(1);

  const startedAt = rows[0]?.startedAt;
  if (!startedAt) return null;
  const parsed = new Date(startedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * L'ultima scadenza mancata fra due istanti, se ce n'è una.
 *
 * Si cammina minuto per minuto da `from` escluso fino a `to` escluso — `to` è
 * il minuto corrente, che lo scheduler valuta comunque per conto suo, e
 * contarlo qui vorrebbe dire eseguire due volte. Si restituisce l'ultima
 * scadenza trovata, non la prima: se il workflow doveva girare alle 8, alle 9
 * e alle 10, quella che conta è le 10.
 *
 * @param matches predicato che dice se a quell'istante il cron sarebbe scattato
 */
export function findLastMissedFiring(
  from: Date,
  to: Date,
  matches: (instant: Date) => boolean,
): Date | null {
  const start = Math.max(from.getTime(), to.getTime() - MAX_CATCHUP_WINDOW_MS);
  // Si parte dal minuto pieno successivo a `from`: il minuto di `from` è
  // quello in cui il workflow è già stato eseguito.
  let cursor = Math.floor(start / ONE_MINUTE_MS) * ONE_MINUTE_MS + ONE_MINUTE_MS;
  const limit = Math.floor(to.getTime() / ONE_MINUTE_MS) * ONE_MINUTE_MS;

  let last: Date | null = null;
  while (cursor < limit) {
    const instant = new Date(cursor);
    if (matches(instant)) last = instant;
    cursor += ONE_MINUTE_MS;
  }
  return last;
}
