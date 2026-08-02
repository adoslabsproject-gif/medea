/**
 * La domanda che precede un'eliminazione.
 *
 * Un workflow eliminato non torna: non c'è cestino e non c'è annulla. La
 * conferma è l'unica cosa fra un clic sbagliato e il lavoro perso, quindi deve
 * dire esattamente cosa si sta per perdere.
 *
 * @module features/workflows/elimina-workflow
 */

/** Quel poco che serve sapere del workflow per formulare la domanda. */
export interface BersaglioEliminazione {
  name: string;
  enabled: boolean;
}

/**
 * Il testo della richiesta di conferma.
 *
 * Nomina il workflow — «questo workflow» in una finestra che ha appena coperto
 * l'elenco non dice quale — e se è attivo lo dichiara, perché eliminarlo
 * significa anche spegnere un'automazione che in quel momento sta girando.
 */
export function messaggioEliminazione(bersaglio: BersaglioEliminazione | undefined): string {
  const nome = bersaglio?.name.trim() ? bersaglio.name.trim() : 'questo workflow';
  const avviso = bersaglio?.enabled
    ? '\n\nÈ attivo: le sue automazioni smetteranno di girare.'
    : '';
  return `Eliminare «${nome}»?${avviso}\n\nNon si può annullare.`;
}
