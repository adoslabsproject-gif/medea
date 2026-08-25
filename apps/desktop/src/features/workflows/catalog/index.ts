/**
 * Il catalogo dei nodi disponibili.
 *
 * `stdlib-nodes.json` è **generato**, non scritto a mano: lo produce
 * `scripts/extract-flowforge-nodes.mjs` leggendo i pacchetti compilati di
 * questo repository. È l'unico modo per tenere allineate 194 definizioni senza
 * ricopiarle — e senza ricopiarle significa che non possono divergere.
 *
 * 194 è lo stesso numero che il runtime dichiara su `/api/v1/nodes`: se le
 * due cifre si separano, la palette offre nodi che nessuno sa eseguire (o
 * nasconde nodi che funzionano). `catalog.guard.test.ts` lo verifica.
 *
 * Quando arriverà il registry `.ffnode` questi diventeranno i nodi
 * preinstallati e gli altri si aggiungeranno accanto: `allNodes()` resta il
 * punto unico da cui palette, scaffold e validazione leggono.
 */

import type { NodeDef } from '../types';

import { communityNodes } from './community';
import { ordinaPerPertinenza } from './punteggio';
import raw from './stdlib-nodes.json';

/** Le famiglie in cui la palette raggruppa i nodi. L'ordine è quello in cui
 *  compaiono: prima come si parte, poi cosa si fa, poi come si decide. */
export const NODE_GROUPS = [
  { id: 'trigger', label: 'Quando parte' },
  { id: 'action', label: 'Cosa fa' },
  { id: 'logic', label: 'Come decide' },
  { id: 'ai', label: 'Intelligenza artificiale' },
] as const;

export type NodeGroupId = (typeof NODE_GROUPS)[number]['id'];

/** Le definizioni preinstallate, già nella forma che usa il resto dell'app. */
export const STDLIB_NODES: readonly NodeDef[] = raw as NodeDef[];

/**
 * Tutti i nodi: i preinstallati più quelli aggiunti dopo.
 *
 * I preinstallati vengono prima, e in caso di stesso `defId` vincono: un
 * pacchetto di comunità non deve poter sostituire in silenzio un nodo su cui
 * qualcuno ha già costruito dei workflow.
 */
export function allNodes(): readonly NodeDef[] {
  const extra = communityNodes();
  if (extra.length === 0) return STDLIB_NODES;
  const known = new Set(STDLIB_NODES.map((n) => n.defId));
  return [...STDLIB_NODES, ...extra.filter((n) => !known.has(n.defId))];
}

export function findNode(defId: string): NodeDef | undefined {
  return allNodes().find((n) => n.defId === defId);
}

export function nodesByGroup(group: NodeGroupId): NodeDef[] {
  return allNodes().filter((n) => n.type === group);
}

/**
 * Ricerca per la palette: stessa logica lessicale del `search_nodes`
 * dell'agente, così l'utente e il modello trovano le stesse cose scrivendo
 * le stesse parole.
 */
export function searchNodes(query: string, limit = 40): NodeDef[] {
  return ordinaPerPertinenza(allNodes(), query, limit);
}

export {
  communityNodes,
  setCommunityNodes,
  subscribeCatalog,
  useCommunityNodes,
} from './community';
