/**
 * Il documento proiettato in ciò che xyflow sa disegnare.
 *
 * Il confine è netto: il `Workflow` è la fonte di verità, xyflow ha uno stato
 * suo dove tiene le misure prese e la posizione durante il trascinamento.
 * Questo modulo tiene i due allineati **senza far perdere le misure**: si
 * ridisegna quando cambia la struttura o la diagnosi, non quando cambia una
 * coordinata — altrimenti ogni pixel di trascinamento ricostruirebbe tutto.
 */

import { useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react';
import { useEffect, useMemo } from 'react';

import type { NodeDef, Workflow, WorkflowEdge } from '../types';

import type { Diagnostics } from './diagnostics';
import { edgeId } from './graph-ops';
import type { MapMode, PlusEdgeData } from './PlusEdge';
import type { WorkflowNodeData } from './WorkflowNode';

/* Array tipizzati invece dei parametri di tipo espliciti: `useNodesState([])`
   inferirebbe `never[]`. Così il tipo arriva dal valore iniziale. */
const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];

export interface EdgeCallbacks {
  onInsert: (edge: WorkflowEdge) => void;
  onDelete: (edge: WorkflowEdge) => void;
  onCycleMapMode: (edge: WorkflowEdge, next: MapMode) => void;
}

interface Options {
  workflow: Workflow;
  defsById: ReadonlyMap<string, NodeDef>;
  diag: Diagnostics;
  selectedId: string | null;
  callbacks: EdgeCallbacks;
}

export function useCanvasProjection({ workflow, defsById, diag, selectedId, callbacks }: Options) {
  const [nodes, setNodes, onNodesChange] = useNodesState(NO_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(NO_EDGES);

  /**
   * Cosa deve far ridisegnare il canvas: la struttura e i problemi, non le
   * coordinate.
   */
  const signature = useMemo(
    () =>
      JSON.stringify({
        n: workflow.nodes.map((n) => [
          n.id,
          n.defId,
          n.label,
          n.config,
          diag.missingByNode.get(n.id) ?? 0,
          (diag.issuesByNode.get(n.id) ?? []).length,
        ]),
        e: workflow.edges,
        s: selectedId,
      }),
    [workflow.nodes, workflow.edges, diag, selectedId],
  );

  useEffect(() => {
    setNodes((previous) => {
      const measured = new Map(previous.map((p) => [p.id, p]));
      return workflow.nodes.map((n) => {
        const def = defsById.get(n.defId);
        const before = measured.get(n.id);
        return {
          // Le misure che xyflow ha già preso si conservano: ricalcolarle
          // farebbe sfarfallare i collegamenti a ogni modifica.
          ...before,
          id: n.id,
          type: 'medea',
          position: before?.position ?? { x: n.x, y: n.y },
          selected: n.id === selectedId,
          data: {
            ...(def ? { def } : {}),
            defId: n.defId,
            ...(n.label ? { label: n.label } : {}),
            missing: diag.missingByNode.get(n.id) ?? 0,
            issues: (diag.issuesByNode.get(n.id) ?? []).length,
          } satisfies WorkflowNodeData,
        };
      });
    });

    setEdges(
      workflow.edges.map((e, i) => ({
        id: edgeId(e, i),
        type: 'plus',
        source: e.from,
        target: e.to,
        ...(e.fromPort ? { sourceHandle: e.fromPort, label: e.fromPort } : {}),
        animated: true,
        data: {
          edge: e,
          ...(e.mapMode ? { mapMode: e.mapMode } : {}),
          onInsert: callbacks.onInsert,
          onDelete: callbacks.onDelete,
          onCycleMapMode: callbacks.onCycleMapMode,
        } satisfies PlusEdgeData,
      })),
    );
    // `signature` riassume tutto ciò che deve provocare un ridisegno; i
    // callback sono stabili per costruzione (leggono il documento da un ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { nodes, edges, onNodesChange, onEdgesChange };
}
