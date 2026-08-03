/**
 * Quanto un nodo corrisponde a quello che si sta cercando.
 *
 * Sta qui, da solo, perché lo usano in due: la palette, dove cerca una
 * persona, e lo strumento `search_nodes`, dove cerca il modello che costruisce
 * i workflow. Erano due funzioni diverse, e la seconda era molto più grezza —
 * ogni parola valeva uno se compariva **ovunque**, nome, etichetta e
 * descrizione appiattiti insieme.
 *
 * Il difetto non è teorico. Un nodo con una descrizione lunga e ricca di
 * parole comuni batteva quello giusto: chiedendo di archiviare delle
 * newsletter, il modello si vedeva proporre *PEC: Archiviazione a Norma* —
 * che contiene «archivia», «email» e «conserva» nella descrizione — e ci
 * costruiva sopra il workflow.
 *
 * L'etichetta pesa il doppio: chi cerca «email» vuole prima i nodi che si
 * chiamano così, non quelli che la nominano di sfuggita. Un alias che combacia
 * in pieno pesa uguale, perché chi scrive «wa» sta cercando WhatsApp.
 *
 * @module features/workflows/catalog/punteggio
 */

import type { NodeDef } from '../types';

/** Le parole di una ricerca, tolte punteggiatura e sillabe troppo corte. */
export function termini(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/** Quanto questo nodo corrisponde ai termini cercati. Zero: non corrisponde. */
export function punteggio(def: NodeDef, terms: readonly string[]): number {
  const alias = (def.searchAliases ?? []).map((a) => a.toLowerCase());
  const tutto = [def.defId, def.label, def.description ?? '', alias.join(' ')]
    .join(' ')
    .toLowerCase();
  const etichetta = def.label.toLowerCase();

  return terms.reduce(
    (somma, t) =>
      somma +
      (etichetta.includes(t) ? 2 : 0) +
      (alias.includes(t) ? 2 : 0) +
      (tutto.includes(t) ? 1 : 0),
    0,
  );
}

/** I nodi che corrispondono, dal più pertinente. */
export function ordinaPerPertinenza(
  catalog: readonly NodeDef[],
  query: string,
  limit: number,
): NodeDef[] {
  const terms = termini(query);
  if (terms.length === 0) return [...catalog].slice(0, limit);

  return catalog
    .map((def) => ({ def, score: punteggio(def, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.def.label.localeCompare(b.def.label))
    .slice(0, limit)
    .map((r) => r.def);
}
