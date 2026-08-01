/**
 * semantic-rules-shared — helper comuni ai validatori semantici (grafo +
 * accesso config), condivisi da semantic-rules.ts (logica di flusso) e
 * semantic-rules-config.ts (struttura/config) per non duplicare e restare
 * sotto la soglia no-monoliti.
 *
 * @module services/ai-scaffold/semantic-rules-shared
 */
import type { QualityGateInput } from '@/services/ai-scaffold/quality-gate.js';

export type SemNode = QualityGateInput['nodes'][number];

/** Stringa di un campo config solo se è davvero una stringa (mai '[object Object]'). */
export function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface SemGraph {
  byId: Map<string, SemNode>;
  outByPort: Map<string, { to: string; fromPort?: string }[]>;
}

export function buildGraph(input: QualityGateInput): SemGraph {
  const byId = new Map(input.nodes.map((n) => [n.id, n] as const));
  const outByPort = new Map<string, { to: string; fromPort?: string }[]>();
  for (const e of input.edges) {
    const port = (e as { fromPort?: string }).fromPort;
    const list = outByPort.get(e.from) ?? [];
    list.push({ to: e.to, ...(port ? { fromPort: port } : {}) });
    outByPort.set(e.from, list);
  }
  return { byId, outByPort };
}

/** Forward-reachability bounded: esiste un nodo a valle (incluso lo start) che soddisfa `pred`? */
export function reachesForward(g: SemGraph, startId: string, pred: (n: SemNode) => boolean): boolean {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = g.byId.get(id);
    if (node && pred(node)) return true;
    for (const e of g.outByPort.get(id) ?? []) stack.push(e.to);
  }
  return false;
}
