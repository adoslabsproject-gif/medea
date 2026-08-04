/**
 * Cosa dire a chi aspetta, mentre aspetta.
 *
 * «Sta pensando…» è onesto per dieci secondi. A tre minuti è una bugia per
 * omissione: non sta pensando, sta aspettando un modello che si accende — e
 * chi guarda non ha modo di distinguerlo da un blocco. Il 2026-08-04 il primo
 * tentativo ha consumato 180 secondi prima di fallire, il secondo è tornato in
 * dodici, e in mezzo l'unica cosa a schermo era un puntino.
 *
 * Un'attesa spiegata è un'attesa che si sopporta. Una taciuta diventa un
 * guasto, anche quando non lo è.
 *
 * @module features/workflows/wizard/attesa-testo
 */

/** Dopo quanto vale la pena spiegare che il ritardo ha un motivo noto. */
const SOGLIA_AVVIO_MS = 15_000;
/** Dopo quanto conviene dire cosa succederà, invece che cosa sta succedendo. */
const SOGLIA_LUNGA_MS = 45_000;

export function testoAttesa(elapsedMs: number): string {
  if (elapsedMs < SOGLIA_AVVIO_MS) return 'Sta pensando…';
  if (elapsedMs < SOGLIA_LUNGA_MS) {
    return 'Sta pensando… se il modello era fermo, il primo avvio richiede più tempo.';
  }
  return 'Il modello si sta avviando: la prima richiesta lo sveglia e non riceve risposta, la successiva parte subito. Ci sto riprovando.';
}
