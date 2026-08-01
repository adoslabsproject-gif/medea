/**
 * Trascinare un nodo dalla palette al disegno.
 *
 * Sembra una riga di codice e invece è il punto in cui l'editor si rompe su
 * macOS. Il trasporto usava un tipo tutto suo — `application/medea-node` — che
 * è la cosa corretta secondo lo standard e **non funziona in WebKit**: Safari,
 * e quindi la WebView di sistema con cui gira Medea sul Mac, trasporta in modo
 * affidabile solo `text/plain`, `text/uri-list` e `text/html`. Gli altri tipi
 * li accetta senza protestare e poi li consegna vuoti.
 *
 * Il risultato è che si trascina un nodo, lo si lascia sul disegno, e non
 * succede niente. Nessun errore: `getData` restituisce stringa vuota e il
 * codice, correttamente, non fa nulla.
 *
 * Qui si scrive in **tutti e due** i modi: il tipo proprio per chi lo
 * supporta, e `text/plain` con un prefisso riconoscibile per tutti gli altri.
 * Il prefisso serve a non confondere un nodo trascinato con del testo
 * qualunque che arriva da fuori — trascinare una parola da un'altra finestra
 * non deve creare niente.
 */

/** Il tipo proprio: preciso, e ignorato da WebKit. */
const TIPO = 'application/medea-node';

/** Il prefisso su `text/plain`, che invece arriva ovunque. */
const PREFISSO = 'medea-node:';

/** Prepara il trasporto di un nodo. */
export function setDraggedNode(dataTransfer: DataTransfer, defId: string): void {
  // L'ordine non conta, ma scriverli entrambi sì: nessuno dei due da solo
  // copre tutti i sistemi su cui Medea gira.
  dataTransfer.setData(TIPO, defId);
  dataTransfer.setData('text/plain', `${PREFISSO}${defId}`);
  dataTransfer.effectAllowed = 'copy';
}

/**
 * Che nodo è stato lasciato, se ne è stato lasciato uno.
 *
 * Restituisce niente quando quello che arriva non è un nodo della palette:
 * un file trascinato dal Finder, del testo da un'altra finestra, un'immagine.
 */
export function draggedNode(dataTransfer: DataTransfer): string | null {
  const proprio = dataTransfer.getData(TIPO);
  if (proprio) return proprio;

  const testo = dataTransfer.getData('text/plain');
  return testo.startsWith(PREFISSO) ? testo.slice(PREFISSO.length) : null;
}
