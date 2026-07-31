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

import type { CanvasNode, Workflow } from '../types';

import { addEdge, edgeId } from './graph-ops';

interface Options {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
  patchNodes: (next: CanvasNode[]) => void;
}

export function useCanvasHandlers({ workflow, onChange, patchNodes }: Options) {
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
      onChange(
        addEdge(workflow, {
          from: conn.source,
          to: conn.target,
          ...(conn.sourceHandle ? { fromPort: conn.sourceHandle } : {}),
        }),
      );
    },
    [workflow, onChange],
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

  return { commitPositions, connect, removeEdges };
}
