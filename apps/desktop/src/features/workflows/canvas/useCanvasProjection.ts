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

/** L'esito di un nodo nella forma che il disegno si aspetta. */
function runData(entry: { status: string; durationMs?: number } | undefined) {
  if (!entry) return {};
  const status =
    entry.status === 'error' || entry.status === 'skipped' || entry.status === 'running'
      ? entry.status
      : ('success' as const);
  return {
    runStatus: status,
    ...(entry.durationMs !== undefined ? { runDurationMs: entry.durationMs } : {}),
  };
}

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
  /** L'esito per nodo dell'esecuzione in corso o appena finita. */
  runByNode?: ReadonlyMap<string, { status: string; durationMs?: number }>;
}

export function useCanvasProjection({
  workflow,
  defsById,
  diag,
  selectedId,
  callbacks,
  runByNode,
}: Options) {
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
        // L'esito cambia mentre gira: fa parte di cosa deve ridisegnarsi.
        r: runByNode ? [...runByNode].map(([id, v]) => [id, v.status]) : null,
      }),
    [workflow.nodes, workflow.edges, diag, selectedId, runByNode],
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
            ...runData(runByNode?.get(n.id)),
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
          // Lo stato di chi sta a monte colora la freccia: durante
          // un'esecuzione si vede dove è arrivato il flusso senza leggere i
          // badge nodo per nodo, e dopo un fallimento si vede da dove in poi
          // non è passato niente.
          ...(runByNode?.get(e.from)?.status ? { runStatus: runByNode.get(e.from)?.status } : {}),
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
