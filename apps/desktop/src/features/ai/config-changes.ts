/**
 * L'annuncio che la configurazione dei modelli AI è cambiata.
 *
 * Provider scelto e chiavi si cambiano in due schermate, ma interessano anche
 * a chi ne tiene una copia: il motore dei workflow. Chi cambia annuncia, chi
 * ha una copia ascolta — così questa parte dell'app non deve sapere che il
 * motore esiste.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Si mette in ascolto. Restituisce la funzione per smettere. */
export function onAiConfigChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Da chiamare dopo aver cambiato il provider scelto o una chiave. */
export function notifyAiConfigChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      // Chi ascolta non deve poter rompere il salvataggio di chi annuncia.
      console.warn('[ai] un ascoltatore della configurazione è fallito', e);
    }
  }
}
