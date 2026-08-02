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

/**
 * Che nodo si sta trascinando, tenuto da parte qui.
 *
 * Il trasporto del browser resta la via principale — è l'unica che funziona
 * quando il trascinamento arriva da fuori. Ma su WebKit capita che il
 * `dataTransfer` arrivi al rilascio senza più niente dentro: il trascinamento
 * parte, il canvas mostra il segno di aggiunta, si lascia il nodo e non
 * succede niente, perché `getData` risponde stringa vuota.
 *
 * Per un trascinamento che nasce e muore dentro Medea non serve il trasporto
 * del browser: basta ricordarsi cosa si è preso in mano.
 */
let inMano: string | null = null;

/** Prepara il trasporto di un nodo. */
export function setDraggedNode(dataTransfer: DataTransfer, defId: string): void {
  // L'ordine non conta, ma scriverli entrambi sì: nessuno dei due da solo
  // copre tutti i sistemi su cui Medea gira.
  dataTransfer.setData(TIPO, defId);
  dataTransfer.setData('text/plain', `${PREFISSO}${defId}`);
  dataTransfer.effectAllowed = 'copy';
  inMano = defId;
}

/**
 * Il trascinamento è finito, comunque sia finito.
 *
 * Va chiamato sempre — anche quando si lascia il nodo fuori dal disegno o si
 * annulla con Esc. Senza, il nodo resterebbe «in mano» e il trascinamento
 * successivo di tutt'altro (una parola da un'altra finestra, un file dal
 * Finder) lo farebbe comparire dal nulla.
 */
export function endDraggedNode(): void {
  inMano = null;
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
  if (testo.startsWith(PREFISSO)) return testo.slice(PREFISSO.length);

  // Il trasporto non ha consegnato niente. Se però un nodo è ancora in mano,
  // il trascinamento è partito da qui e sappiamo comunque quale sia: è il
  // caso di WebKit, dove il `dataTransfer` arriva vuoto al rilascio.
  //
  // Quando invece arriva davvero da fuori — testo, un file — `inMano` è nullo
  // e non si crea niente, che è il comportamento giusto.
  if (inMano) return inMano;

  return null;
}
