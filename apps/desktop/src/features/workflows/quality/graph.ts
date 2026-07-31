/**
 * Attraversamenti del grafo condivisi dalle regole.
 *
 * Quasi ogni regola ha bisogno di sapere «chi viene prima di chi»: se un nodo
 * può leggere l'output di un altro dipende solo da questo. Sta qui una volta
 * sola, così le regole restano corte e leggibili.
 */

import type { QualityEdge, QualityGateInput, QualityNode } from './types';

/** Il valore di un campo come stringa, senza mai produrre "[object Object]". */
export function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Il campo serializzato per le ricerche testuali: le stringhe restano tali,
 *  il resto diventa JSON. */
export function asSearchable(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * I nodi che vengono eseguiti PRIMA di questo. Se un nodo referenzia
 * l'output di un altro, quell'altro deve essere qui dentro.
 */
export function buildAncestors(nodeId: string, edges: readonly QualityEdge[]): Set<string> {
  const ancestors = new Set<string>();
  const stack: string[] = [];
  for (const e of edges) if (e.to === nodeId) stack.push(e.from);
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || ancestors.has(cur)) continue;
    ancestors.add(cur);
    for (const e of edges) if (e.to === cur) stack.push(e.from);
  }
  return ancestors;
}

/** Tutti i nodi raggiungibili seguendo le frecce in avanti. */
export function findDownstreamNodes(
  startNodeId: string,
  edges: readonly QualityEdge[],
): Set<string> {
  const out = new Set<string>();
  const stack = [startNodeId];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const e of edges) {
      if (e.from === cur && !out.has(e.to)) {
        out.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return out;
}

export interface QualityGraph {
  byId: Map<string, QualityNode>;
  outByPort: Map<string, { to: string; fromPort?: string }[]>;
}

export function buildGraph(input: QualityGateInput): QualityGraph {
  const byId = new Map(input.nodes.map((n) => [n.id, n] as const));
  const outByPort = new Map<string, { to: string; fromPort?: string }[]>();
  for (const e of input.edges) {
    const list = outByPort.get(e.from) ?? [];
    list.push({ to: e.to, ...(e.fromPort ? { fromPort: e.fromPort } : {}) });
    outByPort.set(e.from, list);
  }
  return { byId, outByPort };
}

/** Esiste, da `startId` in avanti (incluso), un nodo che soddisfa `pred`? */
export function reachesForward(
  g: QualityGraph,
  startId: string,
  pred: (n: QualityNode) => boolean,
): boolean {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = g.byId.get(id);
    if (node && pred(node)) return true;
    for (const e of g.outByPort.get(id) ?? []) stack.push(e.to);
  }
  return false;
}

/** Quanti archi entrano in ciascun nodo. */
export function inDegree(edges: readonly QualityEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(e.to, (counts.get(e.to) ?? 0) + 1);
  return counts;
}

/** Quanti archi escono da ciascun nodo. */
export function outDegree(edges: readonly QualityEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) counts.set(e.from, (counts.get(e.from) ?? 0) + 1);
  return counts;
}
