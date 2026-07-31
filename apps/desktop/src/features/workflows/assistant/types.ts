/**
 * I tipi della conversazione con l'assistente dei workflow.
 *
 * La differenza rispetto a una chat qualunque è che qui una risposta non è
 * testo: è una **proposta di modifica** al workflow aperto, che l'utente vede
 * come diff e applica o rifiuta. Il testo accompagna, non decide.
 */

import type { AgentStep } from '../scaffold';
import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Millisecondi epoch: l'ora mostrata accanto al messaggio. */
  at: number;
  /** I passi che l'agente ha compiuto per produrre questa risposta. */
  steps?: AgentStep[];
  /** La proposta collegata, quando c'è. */
  patch?: PatchOps;
  /** Vero quando la proposta è stata applicata al canvas. */
  applied?: boolean;
  /** Il motivo del fallimento, quando l'agente non è arrivato in fondo. */
  error?: string;
}

/** Le operazioni che portano dal workflow di prima a quello proposto. */
export interface PatchOps {
  addNodes: CanvasNode[];
  removeNodes: CanvasNode[];
  updateNodes: NodeUpdate[];
  addEdges: WorkflowEdge[];
  removeEdges: WorkflowEdge[];
  /** Il workflow completo risultante: è quello che si applica. */
  next: Workflow;
}

export interface NodeUpdate {
  id: string;
  label: string;
  /** Un elemento per campo cambiato: chiave, valore prima, valore dopo. */
  changes: FieldChange[];
}

export interface FieldChange {
  key: string;
  before: string;
  after: string;
}

/** Vero quando la proposta non cambia niente: non vale la pena mostrarla. */
export function isEmptyPatch(patch: PatchOps): boolean {
  return (
    patch.addNodes.length === 0 &&
    patch.removeNodes.length === 0 &&
    patch.updateNodes.length === 0 &&
    patch.addEdges.length === 0 &&
    patch.removeEdges.length === 0
  );
}
