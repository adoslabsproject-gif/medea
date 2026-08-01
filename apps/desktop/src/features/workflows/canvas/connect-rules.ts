/**
 * Quali collegamenti hanno senso, e quali no.
 *
 * Il controllo di qualità li segnala **dopo**, quando il workflow è già
 * disegnato. Impedirli mentre si trascina è meglio: costa un attimo di
 * attrito invece di un errore da leggere e capire più tardi.
 *
 * Ma solo quelli **certamente** sbagliati. Un editor che rifiuta cose
 * plausibili insegna a combatterlo, e chi lo combatte finisce per disegnare
 * peggio, non meglio.
 */

import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

export interface Rifiuto {
  /** Perché non si può, detto a chi sta trascinando. */
  motivo: string;
}

/**
 * Se questo collegamento si può fare.
 *
 * Restituisce niente quando va bene — è il caso normale, e va scritto in modo
 * che si legga così.
 */
export function verificaCollegamento(
  from: string,
  to: string,
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
  defsById: ReadonlyMap<string, NodeDef>,
): Rifiuto | null {
  if (from === to) return { motivo: 'Un nodo non si collega a sé stesso.' };

  const partenza = nodes.find((n) => n.id === from);
  const arrivo = nodes.find((n) => n.id === to);
  if (!partenza || !arrivo) return null;

  const defArrivo = defsById.get(arrivo.defId);
  if (defArrivo?.type === 'trigger') {
    // Un trigger è dove il flusso comincia: qualcosa che ci arriva dentro non
    // verrebbe mai eseguito, e il motore non saprebbe cosa farne.
    return { motivo: 'Un trigger è un punto di partenza: non può ricevere niente.' };
  }

  if (edges.some((e) => e.from === from && e.to === to)) {
    return { motivo: 'Questi due nodi sono già collegati.' };
  }

  if (creaCiclo(from, to, edges)) {
    // Un anello non è un flusso: il motore girerebbe all'infinito, o si
    // fermerebbe per un motivo che dal disegno non si capisce.
    return { motivo: 'Questo collegamento chiuderebbe un anello.' };
  }

  return null;
}

/** Vero se aggiungere `from → to` chiuderebbe un ciclo. */
function creaCiclo(from: string, to: string, edges: readonly WorkflowEdge[]): boolean {
  // Si parte da `to` e si guarda se si riesce a tornare a `from`: se sì, il
  // collegamento nuovo chiuderebbe il giro.
  const visti = new Set<string>();
  const coda = [to];

  while (coda.length > 0) {
    const corrente = coda.pop();
    if (corrente === undefined || visti.has(corrente)) continue;
    if (corrente === from) return true;
    visti.add(corrente);
    for (const e of edges) if (e.from === corrente) coda.push(e.to);
  }
  return false;
}
