/**
 * Posizionamento dei nodi sul canvas.
 *
 * Un workflow generato dall'AI arriva senza coordinate sensate: il modello
 * pensa alla logica, non a dove stanno le cose. Se lo si disegnasse così com'è
 * si vedrebbe un mucchio di rettangoli sovrapposti — e la prima impressione
 * sarebbe che la generazione ha sbagliato, mentre è solo il disegno.
 *
 * Il disegno lo fa dagre, come nell'editor originale: stessa libreria, stessa
 * direzione (da sinistra a destra), stesse distanze. Un workflow riordinato
 * qui e uno riordinato là devono avere lo stesso aspetto.
 */

import dagre from 'dagre';

import type { CanvasNode, WorkflowEdge } from '../types';

export const COLUMN_WIDTH = 280;
export const ROW_HEIGHT = 150;
export const ORIGIN = { x: 80, y: 80 };

/** Le misure del nodo disegnato, e le distanze fra i nodi: sono quelle
 *  dell'editor originale. */
const NODE_WIDTH = 140;
const NODE_HEIGHT = 120;
const LAYOUT = { rankdir: 'LR', nodesep: 80, ranksep: 140, marginx: 40, marginy: 40 };

/**
 * La profondità di ciascun nodo: 0 per chi non ha nessuno a monte, altrimenti
 * uno più del più profondo dei suoi predecessori.
 *
 * Il limite sulle iterazioni serve ai cicli: un grafo con un anello non ha una
 * profondità ben definita, ma deve comunque essere disegnabile.
 */
export function computeDepths(
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
): Map<string, number> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) {
    depth.set(n.id, 0);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    const list = incoming.get(e.to);
    if (list) list.push(e.from);
  }

  let passesLeft = nodes.length;
  while (passesLeft > 0) {
    passesLeft--;
    let changed = false;
    for (const n of nodes) {
      const parents = incoming.get(n.id) ?? [];
      if (parents.length === 0) continue;
      const deepest = Math.max(...parents.map((p) => depth.get(p) ?? 0));
      if (deepest + 1 > (depth.get(n.id) ?? 0)) {
        depth.set(n.id, deepest + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

/** Le nuove coordinate: il flusso scorre da sinistra a destra, i rami si
 *  aprono in verticale. */
export function autoLayout(
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
): CanvasNode[] {
  if (nodes.length === 0) return [...nodes];

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph(LAYOUT);

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const placed = g.node(n.id) as { x?: number; y?: number } | undefined;
    if (placed?.x === undefined || placed.y === undefined) return { ...n };
    // dagre dà il centro del nodo, il canvas vuole l'angolo in alto a
    // sinistra.
    return {
      ...n,
      x: Math.round(placed.x - NODE_WIDTH / 2),
      y: Math.round(placed.y - NODE_HEIGHT / 2),
    };
  });
}

/** Vero quando le posizioni non dicono nulla — tutte a zero o tutte uguali.
 *  È il caso di un workflow appena generato. */
export function needsLayout(nodes: readonly CanvasNode[]): boolean {
  if (nodes.length < 2) return false;
  const first = nodes[0];
  if (!first) return false;
  return nodes.every((n) => (n.x === 0 && n.y === 0) || (n.x === first.x && n.y === first.y));
}

/** Un punto libero dove appoggiare un nodo aggiunto dalla palette, senza
 *  finirci sopra a uno che c'è già. */
export function nextFreeSpot(nodes: readonly CanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { ...ORIGIN };
  const maxX = Math.max(...nodes.map((n) => n.x));
  const onLastColumn = nodes.filter((n) => n.x === maxX);
  const maxY = Math.max(...onLastColumn.map((n) => n.y));
  return onLastColumn.length >= 4
    ? { x: maxX + COLUMN_WIDTH, y: ORIGIN.y }
    : { x: maxX, y: maxY + ROW_HEIGHT };
}
