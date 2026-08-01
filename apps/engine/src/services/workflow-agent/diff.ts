/**
 * diff — calcola un `WorkflowPatch` dallo snapshot PRIMA → snapshot DOPO della
 * modifica agentica di un workflow (#1 parità chatter↔creazione).
 *
 * L'agente di modifica (modify.ts) seeda il WorkflowBuilder col workflow ESISTENTE
 * (read-before-edit), lascia che il modello lo trasformi coi tool, poi questo
 * modulo PURO confronta i due snapshot e produce esattamente l'`AssistantPatch`
 * che l'editor già sa renderizzare (diff Accept/Reject) e applicare (applyPatch in
 * AiAssistantPanel). Riuso TOTALE della UI esistente: il backend cambia da
 * single-shot ad agentico, il contratto di output resta identico.
 *
 * Contratto verso l'editor (apps/flowforge-editor `AssistantPatch` + `applyPatch`):
 *  - removeNodeIds: id presenti PRIMA e spariti DOPO
 *  - addNodes:      id nuovi DOPO  → { id, defId, config }
 *  - updateNodes:   stesso id, config cambiata → { id, patch: { config } } (REPLACE)
 *  - addEdges:      edge nuovi → { id, from, to, fromPort? }
 *  - removeEdgeIds: edge spariti → id `from->to#fromPort` (parsabile dall'editor)
 *
 * Un nodo con lo STESSO id ma defId DIVERSO non è un update (l'editor sa solo
 * patchare config/x/y, non il defId): si modella come remove + add → l'editor
 * ricrea il nodo col tipo nuovo.
 *
 * Puro, deterministico (output ordinato per id), niente I/O.
 *
 * @module services/workflow-agent/diff
 */
import type { BuildEdge, BuildNode, WorkflowSnapshot } from '@/services/workflow-agent/state.js';

export interface PatchAddNode { id: string; defId: string; config: Record<string, unknown> }
export interface PatchAddEdge { id: string; from: string; to: string; fromPort?: string }
export interface PatchUpdateNode { id: string; patch: { config: Record<string, unknown> } }

export interface WorkflowPatch {
  addNodes?: PatchAddNode[];
  removeNodeIds?: string[];
  addEdges?: PatchAddEdge[];
  removeEdgeIds?: string[];
  updateNodes?: PatchUpdateNode[];
}

/** Id di edge stabile e parsabile dall'editor (regex `^([^>]+)->([^#]+)#`). */
export function edgeId(e: Pick<BuildEdge, 'from' | 'to' | 'fromPort'>): string {
  return `${e.from}->${e.to}#${e.fromPort ?? ''}`;
}

/**
 * Uguaglianza profonda CANONICA (ordine delle chiavi irrilevante) tra due config.
 * Evita falsi `updateNodes` quando il modello riemette le stesse chiavi in ordine
 * diverso. Gestisce primitivi, array (ordine significativo) e oggetti annidati.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Indicizza i nodi per id (l'id è univoco nel builder by-construction). */
function indexNodes(nodes: readonly BuildNode[]): Map<string, BuildNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/**
 * Confronta `before` (workflow esistente seedato) e `after` (post-agente) e
 * produce il patch minimo. Solo le chiavi con almeno un'operazione sono presenti
 * (un patch senza modifiche è `{}` → `patchHasOps` false lato editor).
 */
export function diffSnapshots(before: WorkflowSnapshot, after: WorkflowSnapshot): WorkflowPatch {
  const beforeNodes = indexNodes(before.nodes);
  const afterNodes = indexNodes(after.nodes);

  const addNodes: PatchAddNode[] = [];
  const removeNodeIds: string[] = [];
  const updateNodes: PatchUpdateNode[] = [];

  // Nodi nuovi o ricreati con defId diverso.
  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) {
      addNodes.push({ id: node.id, defId: node.defId, config: node.config });
    } else if (prev.defId !== node.defId) {
      // defId cambiato → remove + add (l'editor non patcha il tipo).
      removeNodeIds.push(node.id);
      addNodes.push({ id: node.id, defId: node.defId, config: node.config });
    } else if (!deepEqual(prev.config, node.config)) {
      updateNodes.push({ id: node.id, patch: { config: node.config } });
    }
  }

  // Nodi spariti (non più nello snapshot finale).
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) removeNodeIds.push(node.id);
  }

  // Edge: identità = from+to+fromPort.
  const beforeEdgeIds = new Set(before.edges.map(edgeId));
  const afterEdgeIds = new Set(after.edges.map(edgeId));
  const addEdges: PatchAddEdge[] = [];
  const removeEdgeIds: string[] = [];
  for (const e of after.edges) {
    if (!beforeEdgeIds.has(edgeId(e))) {
      addEdges.push({ id: edgeId(e), from: e.from, to: e.to, ...(e.fromPort ? { fromPort: e.fromPort } : {}) });
    }
  }
  for (const e of before.edges) {
    if (!afterEdgeIds.has(edgeId(e))) removeEdgeIds.push(edgeId(e));
  }

  // Output deterministico: ordina per id/edge-id.
  const patch: WorkflowPatch = {};
  if (addNodes.length > 0) patch.addNodes = addNodes.sort((a, b) => a.id.localeCompare(b.id));
  if (removeNodeIds.length > 0) patch.removeNodeIds = [...new Set(removeNodeIds)].sort();
  if (updateNodes.length > 0) patch.updateNodes = updateNodes.sort((a, b) => a.id.localeCompare(b.id));
  if (addEdges.length > 0) patch.addEdges = addEdges.sort((a, b) => a.id.localeCompare(b.id));
  if (removeEdgeIds.length > 0) patch.removeEdgeIds = removeEdgeIds.sort();
  return patch;
}

/** True se il patch contiene almeno un'operazione reale (mirror lato editor). */
export function patchHasOps(p: WorkflowPatch): boolean {
  return (
    (p.addNodes?.length ?? 0) > 0 ||
    (p.removeNodeIds?.length ?? 0) > 0 ||
    (p.addEdges?.length ?? 0) > 0 ||
    (p.removeEdgeIds?.length ?? 0) > 0 ||
    (p.updateNodes?.length ?? 0) > 0
  );
}
