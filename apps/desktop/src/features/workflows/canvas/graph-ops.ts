/**
 * Le modifiche al grafo, come funzioni pure.
 *
 * Stanno fuori dal componente perché sono le operazioni che definiscono cosa
 * significa modificare un workflow — inserire un nodo su un collegamento,
 * staccarlo, cambiare il fan-out — e vanno potute leggere e provare senza
 * montare un canvas.
 */

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import type { MapMode } from './PlusEdge';

/** Due collegamenti sono lo stesso se uniscono gli stessi nodi dallo stesso ramo. */
export function sameEdge(a: WorkflowEdge, b: WorkflowEdge): boolean {
  return a.from === b.from && a.to === b.to && (a.fromPort ?? '') === (b.fromPort ?? '');
}

/**
 * Il collegamento sparisce e ne nascono due, con il nuovo nodo in mezzo.
 *
 * Il ramo di partenza resta sul primo tratto: se il collegamento usciva dal
 * ramo «vero» di una condizione, ci esce ancora.
 */
export function insertBetween(wf: Workflow, edge: WorkflowEdge, node: CanvasNode): Workflow {
  return {
    ...wf,
    nodes: [...wf.nodes, node],
    edges: [
      ...wf.edges.filter((e) => !sameEdge(e, edge)),
      { from: edge.from, to: node.id, ...(edge.fromPort ? { fromPort: edge.fromPort } : {}) },
      { from: node.id, to: edge.to },
    ],
  };
}

export function dropEdge(wf: Workflow, edge: WorkflowEdge): Workflow {
  return { ...wf, edges: wf.edges.filter((e) => !sameEdge(e, edge)) };
}

/** Toglie un nodo e tutto ciò che entra o esce da lui. */
export function dropNode(wf: Workflow, id: string): Workflow {
  return {
    ...wf,
    nodes: wf.nodes.filter((n) => n.id !== id),
    edges: wf.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

export function setMapMode(wf: Workflow, edge: WorkflowEdge, mode: MapMode): Workflow {
  return {
    ...wf,
    edges: wf.edges.map((e) => {
      if (!sameEdge(e, edge)) return e;
      // Spento vuol dire assente: un campo `mapMode: undefined` finirebbe nel
      // JSON esportato come rumore.
      const { mapMode: _off, ...rest } = e;
      return mode === 'off' ? rest : { ...rest, mapMode: mode };
    }),
  };
}

/** Aggiunge un collegamento, se non c'è già e se ha senso. */
export function addEdge(wf: Workflow, edge: WorkflowEdge): Workflow {
  if (edge.from === edge.to) return wf;
  if (wf.edges.some((e) => sameEdge(e, edge))) return wf;
  return { ...wf, edges: [...wf.edges, edge] };
}

/**
 * L'id di un nodo nuovo: gli stessi id leggibili che assegna l'agente —
 * `action_http`, poi `action_http_2`. Un workflow costruito a mano e uno
 * generato si leggono allo stesso modo.
 */
export function uniqueNodeId(defId: string, nodes: readonly CanvasNode[]): string {
  // Stessa normalizzazione del builder dell'agente, compreso il taglio dei
  // caratteri iniziali che non sono lettere: un id come `___` sarebbe legale
  // e completamente inutile.
  const base =
    defId
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^[^a-z]+/, '') || 'nodo';
  if (!nodes.some((n) => n.id === base)) return base;
  let i = 2;
  while (nodes.some((n) => n.id === `${base}_${String(i)}`)) i++;
  return `${base}_${String(i)}`;
}

/** L'id di un collegamento nel canvas. Include l'indice perché due nodi
 *  possono essere uniti da più rami. */
export function edgeId(e: WorkflowEdge, index: number): string {
  return `${e.from}->${e.to}#${String(index)}`;
}
