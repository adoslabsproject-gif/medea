/**
 * Cosa è cambiato fra il workflow di prima e quello proposto.
 *
 * L'assistente non emette una lista di operazioni: costruisce un workflow
 * intero. Il confronto lo facciamo qui, ed è meglio così — una proposta
 * descritta dal modello può mentire, una calcolata dai due documenti no.
 *
 * Funzione pura: nessuno stato, nessuna dipendenza dalla UI.
 */

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import type { FieldChange, NodeUpdate, PatchOps } from './types';

/** La chiave che identifica un collegamento, ramo compreso. */
function edgeKey(e: WorkflowEdge): string {
  return `${e.from}→${e.to}#${e.fromPort ?? ''}`;
}

/** Il valore di un campo in forma leggibile, accorciato se enorme. */
function showValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(vuoto)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function diffConfig(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: FieldChange[] = [];
  for (const key of [...keys].sort()) {
    const b = before[key];
    const a = after[key];
    if (showValue(b) === showValue(a)) continue;
    changes.push({ key, before: showValue(b), after: showValue(a) });
  }
  return changes;
}

function labelOf(node: CanvasNode): string {
  return node.label ?? node.id;
}

export function computePatch(current: Workflow, next: Workflow): PatchOps {
  const beforeNodes = new Map(current.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(next.nodes.map((n) => [n.id, n]));

  const addNodes = next.nodes.filter((n) => !beforeNodes.has(n.id));
  const removeNodes = current.nodes.filter((n) => !afterNodes.has(n.id));

  const updateNodes: NodeUpdate[] = [];
  for (const [id, after] of afterNodes) {
    const before = beforeNodes.get(id);
    if (!before) continue;
    const changes = diffConfig(before.config, after.config);
    // Lo spostamento sul canvas non è una modifica di cui informare: non
    // cambia cosa fa il workflow.
    if (before.label !== after.label) {
      changes.unshift({ key: 'nome', before: labelOf(before), after: labelOf(after) });
    }
    if (changes.length > 0) updateNodes.push({ id, label: labelOf(after), changes });
  }

  const beforeEdges = new Map(current.edges.map((e) => [edgeKey(e), e]));
  const afterEdges = new Map(next.edges.map((e) => [edgeKey(e), e]));
  const addEdges = next.edges.filter((e) => !beforeEdges.has(edgeKey(e)));
  const removeEdges = current.edges.filter((e) => !afterEdges.has(edgeKey(e)));

  return { addNodes, removeNodes, updateNodes, addEdges, removeEdges, next };
}

/** Una riga di riepilogo per la testata della proposta. */
export function summarizePatch(patch: PatchOps): string {
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) =>
    `${String(count)} ${count === 1 ? one : many}`;

  if (patch.addNodes.length) parts.push(`+${n(patch.addNodes.length, 'nodo', 'nodi')}`);
  if (patch.removeNodes.length) parts.push(`−${n(patch.removeNodes.length, 'nodo', 'nodi')}`);
  if (patch.updateNodes.length) {
    parts.push(n(patch.updateNodes.length, 'nodo modificato', 'nodi modificati'));
  }
  if (patch.addEdges.length) {
    parts.push(`+${n(patch.addEdges.length, 'collegamento', 'collegamenti')}`);
  }
  if (patch.removeEdges.length) {
    parts.push(`−${n(patch.removeEdges.length, 'collegamento', 'collegamenti')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'nessuna modifica';
}
