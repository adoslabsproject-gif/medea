/**
 * Il tetto di tempo che la costruzione ha, comunque vada.
 *
 * I limiti c'erano già, ma erano tutti sul *numero* di passi: tre tentativi per
 * la scrittura in una volta sola, quaranta per l'agente. Nessuno sul tempo. Con
 * tre minuti concessi a ogni chiamata, quaranta passi fanno due ore — ed è
 * esattamente quanto è durato il blocco del 2026-08-04: non un difetto, il
 * limite che funzionava come scritto.
 *
 * Nessun numero di passi è quello giusto, perché quello che l'utente sopporta
 * si misura in minuti, non in passi.
 *
 * @module features/workflows/wizard/scadenza
 */

/**
 * Sei minuti. Erano quattro, e troncavano lavori che stavano per riuscire: se
 * il modello era spento, il server ne impiegava quasi quattro solo per
 * caricarlo, e il tempo per generare non restava. Adesso lo si sveglia
 * all'apertura del wizard, quindi in pratica bastano trenta secondi — ma quando
 * il riscaldamento non fa in tempo, meglio riuscire al quinto minuto che
 * fallire al quarto.
 *
 * Resta un tetto, non una previsione: chi ne chiede venti non sta finendo, sta
 * girando a vuoto, e girare a vuoto davanti a un utente che aspetta è la sola
 * cosa che non deve poter succedere.
 */
export const BUDGET_MS = 6 * 60_000;

/** Cosa si legge quando il tempo finisce: dove si è arrivati, e come fare. */
export function messaggioScaduto(): string {
  const minuti = Math.round(BUDGET_MS / 60_000);
  return `Mi sono fermato dopo ${String(minuti)} minuti: quello che era stato costruito resta, il resto va completato a mano. Un obiettivo più corto, o diviso in due workflow, di solito ci arriva.`;
}

/**
 * Fa scattare la scadenza, e restituisce come disinnescarla.
 *
 * `onScaduto` aggiorna lo schermo **subito**, senza aspettare che il ciclo si
 * accorga dell'annullamento. Annullare è solo un avviso: se la chiamata in
 * corso non onora il segnale — e non tutte lo fanno — quella promessa non si
 * risolve mai, il `catch` non parte, e lo stato resta «in costruzione» per
 * sempre. È lo stesso motivo per cui «Interrompi» sembrava rotto.
 */
export function avviaScadenza(controller: AbortController, onScaduto: () => void): () => void {
  const scadenza = setTimeout(() => {
    controller.abort();
    onScaduto();
  }, BUDGET_MS);
  return () => {
    clearTimeout(scadenza);
  };
}
