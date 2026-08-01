/**
 * I nodi aggiuntivi, quelli che non erano preinstallati.
 *
 * I 193 nodi del catalogo arrivano compilati dentro l'app: sono un file JSON,
 * disponibili subito e anche senza motore acceso. I nodi di comunità no —
 * vivono nel motore, che li installa da un pacchetto `.ffnode` firmato — e
 * quindi si sanno solo quando il motore risponde.
 *
 * Da qui l'unico pezzo mutevole del catalogo: un elenco che parte vuoto, si
 * riempie all'avvio del motore e avvisa chi lo sta guardando. Senza l'avviso,
 * un nodo appena installato comparirebbe nella palette solo riaprendo l'app.
 */

import { useSyncExternalStore } from 'react';

import type { NodeDef } from '../types';

let extra: readonly NodeDef[] = [];
const listeners = new Set<() => void>();

/** Quelli che ci sono adesso. */
export function communityNodes(): readonly NodeDef[] {
  return extra;
}

/**
 * Sostituisce l'elenco. È una sostituzione, non un'aggiunta: chi lo chiama ha
 * appena chiesto al motore la lista completa, e un nodo disinstallato deve
 * sparire davvero.
 */
export function setCommunityNodes(defs: readonly NodeDef[]): void {
  extra = defs;
  for (const listener of listeners) listener();
}

/** Si mette in ascolto dei cambiamenti. Restituisce come smettere. */
export function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * L'elenco, in modo che un componente si ridisegni quando cambia.
 *
 * Serve alla palette: senza, un pacchetto appena installato comparirebbe solo
 * riaprendo l'app — che è il modo migliore per far credere che l'installazione
 * non abbia funzionato.
 */
export function useCommunityNodes(): readonly NodeDef[] {
  return useSyncExternalStore(subscribeCatalog, communityNodes, communityNodes);
}
