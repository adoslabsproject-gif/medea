/**
 * Le risposte del canvas alle interazioni di xyflow.
 *
 * Stanno fuori dal componente perché sono la traduzione fra due mondi: xyflow
 * parla di nodi trascinati e connessioni, il documento parla di posizioni e
 * collegamenti. Tenere la traduzione in un posto solo evita che il componente
 * diventi un elenco di funzioni.
 */

import type { Connection, Edge, Node } from '@xyflow/react';
import { useCallback } from 'react';

import type { CanvasNode, NodeDef, Workflow } from '../types';

import { verificaCollegamento } from './connect-rules';
import { addEdge, edgeId } from './graph-ops';

interface Options {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
  patchNodes: (next: CanvasNode[]) => void;
  /** Serve a sapere quali nodi sono trigger: non possono ricevere niente. */
  defsById: ReadonlyMap<string, NodeDef>;
  /** Chiamata quando un collegamento viene rifiutato, per dirne il motivo. */
  onRefused?: (motivo: string) => void;
}

export function useCanvasHandlers({
  workflow,
  onChange,
  patchNodes,
  defsById,
  onRefused,
}: Options) {
  /** Finito il trascinamento la posizione diventa parte del documento: è
   *  quella che verrà salvata e ritrovata alla riapertura. */
  const commitPositions = useCallback(
    (moved: Node[]) => {
      const byId = new Map(moved.map((m) => [m.id, m.position]));
      patchNodes(
        workflow.nodes.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n;
        }),
      );
    },
    [workflow.nodes, patchNodes],
  );

  const connect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      // I collegamenti certamente sbagliati si fermano qui, mentre si
      // trascina: costa un attimo di attrito invece di un errore da leggere
      // e capire più tardi.
      const rifiuto = verificaCollegamento(
        conn.source,
        conn.target,
        workflow.nodes,
        workflow.edges,
        defsById,
      );
      if (rifiuto) {
        onRefused?.(rifiuto.motivo);
        return;
      }
      onChange(
        addEdge(workflow, {
          from: conn.source,
          to: conn.target,
          ...(conn.sourceHandle ? { fromPort: conn.sourceHandle } : {}),
        }),
      );
    },
    [workflow, onChange, defsById, onRefused],
  );

  /**
   * Il capo di un collegamento trascinato altrove.
   *
   * Senza, per spostare la fine di una freccia bisogna cancellarla e
   * rifarla — due gesti per una correzione che ne vale uno.
   */
  const reconnect = useCallback(
    (vecchio: Edge, conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const rifiuto = verificaCollegamento(
        conn.source,
        conn.target,
        workflow.nodes,
        workflow.edges.filter((e, i) => edgeId(e, i) !== vecchio.id),
        defsById,
      );
      if (rifiuto) {
        onRefused?.(rifiuto.motivo);
        return;
      }
      onChange({
        ...workflow,
        edges: [
          ...workflow.edges.filter((e, i) => edgeId(e, i) !== vecchio.id),
          {
            from: conn.source,
            to: conn.target,
            ...(conn.sourceHandle ? { fromPort: conn.sourceHandle } : {}),
          },
        ],
      });
    },
    [workflow, onChange, defsById, onRefused],
  );

  const removeEdges = useCallback(
    (deleted: Edge[]) => {
      const gone = new Set(deleted.map((e) => e.id));
      onChange({
        ...workflow,
        edges: workflow.edges.filter((e, i) => !gone.has(edgeId(e, i))),
      });
    },
    [workflow, onChange],
  );

  return { commitPositions, connect, reconnect, removeEdges };
}
