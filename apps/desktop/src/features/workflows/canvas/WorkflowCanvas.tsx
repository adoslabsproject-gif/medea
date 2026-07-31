/**
 * L'editor: palette a sinistra, canvas al centro, configurazione a destra.
 *
 * Il documento vero è il `Workflow` che arriva dalle props. xyflow però ha
 * bisogno di uno stato suo — ci tiene le dimensioni misurate di ogni nodo e la
 * posizione durante il trascinamento — quindi le due cose convivono: xyflow
 * gestisce l'interazione, il documento registra il risultato.
 *
 * Il confine è netto. Ogni cambiamento strutturale (nodo aggiunto, rimosso,
 * riconfigurato, collegato) passa dal documento e torna giù; la posizione
 * viene scritta solo quando il trascinamento finisce, perché scriverla a ogni
 * pixel rigenererebbe il grafo sessanta volte al secondo.
 */

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { findNode } from '../catalog';
import type { CanvasNode, NodeDef, Workflow, WorkflowEdge } from '../types';

import { diagnose } from './diagnostics';
import { nextFreeSpot } from './layout';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import styles from './WorkflowCanvas.module.css';
import { WorkflowNode, type WorkflowNodeData } from './WorkflowNode';

import './xyflow.css';

const NODE_TYPES: NodeTypes = { medea: WorkflowNode };

/* Array tipizzati invece dei parametri di tipo espliciti: `useNodesState(NO_NODES)`
   inferirebbe `never[]` e `useNodesState<Node>([])` ripete il tipo di
   default. Così il tipo arriva dal valore iniziale. */
const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];

interface Props {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
}

export function WorkflowCanvas({ workflow, onChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(NO_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(NO_EDGES);

  const defsById = useMemo(() => {
    const map = new Map<string, NodeDef>();
    for (const n of workflow.nodes) {
      const def = findNode(n.defId);
      if (def) map.set(n.defId, def);
    }
    return map;
  }, [workflow.nodes]);

  const diag = useMemo(
    () => diagnose(workflow.nodes, workflow.edges, defsById),
    [workflow.nodes, workflow.edges, defsById],
  );

  /**
   * Cosa deve far ridisegnare il canvas: la struttura e i problemi, non le
   * coordinate. Senza questa distinzione ogni trascinamento ricostruirebbe
   * tutti i nodi e xyflow perderebbe le misure.
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
        source: e.from,
        target: e.to,
        ...(e.fromPort ? { sourceHandle: e.fromPort, label: e.fromPort } : {}),
        animated: true,
      })),
    );
    // `signature` riassume tutto ciò che deve provocare un ridisegno.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const patchNodes = useCallback(
    (next: CanvasNode[]) => {
      onChange({ ...workflow, nodes: next });
    },
    [workflow, onChange],
  );

  const removeNode = useCallback(
    (id: string) => {
      onChange({
        ...workflow,
        nodes: workflow.nodes.filter((n) => n.id !== id),
        edges: workflow.edges.filter((e) => e.from !== id && e.to !== id),
      });
      setSelectedId((current) => (current === id ? null : current));
    },
    [workflow, onChange],
  );

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
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const edge: WorkflowEdge = {
        from: conn.source,
        to: conn.target,
        ...(conn.sourceHandle ? { fromPort: conn.sourceHandle } : {}),
      };
      const exists = workflow.edges.some(
        (e) => e.from === edge.from && e.to === edge.to && e.fromPort === edge.fromPort,
      );
      if (exists) return;
      onChange({ ...workflow, edges: [...workflow.edges, edge] });
    },
    [workflow, onChange],
  );

  const addFromPalette = useCallback(
    (def: NodeDef) => {
      const spot = nextFreeSpot(workflow.nodes);
      const id = uniqueId(def.defId, workflow.nodes);
      const config: Record<string, unknown> = {};
      // I valori predefiniti si applicano subito: è ciò che rende un nodo
      // appena messo già quasi pronto invece che tutto da compilare.
      for (const f of def.configFields ?? []) {
        if (f.defaultValue !== undefined) config[f.key] = f.defaultValue;
      }
      onChange({
        ...workflow,
        nodes: [...workflow.nodes, { id, defId: def.defId, x: spot.x, y: spot.y, config }],
      });
      setSelectedId(id);
    },
    [workflow, onChange],
  );

  const selected = workflow.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={styles.root}>
      <NodePalette onAdd={addFromPalette} />

      <div className={styles.canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={(_, __, dragged) => {
            commitPositions(dragged);
          }}
          onNodesDelete={(deleted) => {
            for (const n of deleted) removeNode(n.id);
          }}
          onEdgesDelete={(deleted) => {
            const gone = new Set(deleted.map((e) => e.id));
            onChange({
              ...workflow,
              edges: workflow.edges.filter((e, i) => !gone.has(edgeId(e, i))),
            });
          }}
          onConnect={connect}
          onNodeClick={(_, node) => {
            setSelectedId(node.id);
          }}
          onPaneClick={() => {
            setSelectedId(null);
          }}
          fitView
          /* Senza un tetto allo zoom, un workflow con due nodi riempirebbe
             lo schermo ingigantendoli: `fitView` ingrandisce finché non
             riempie il canvas. */
          fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable maskColor="oklch(0 0 0 / 0.6)" />
        </ReactFlow>

        {workflow.nodes.length === 0 && (
          <div className={styles.hint}>
            <p>Il workflow è vuoto.</p>
            <p>
              Scegli un nodo di avvio dalla colonna a sinistra, oppure descrivi a parole cosa deve
              fare e lascia che sia l’assistente a costruirlo.
            </p>
          </div>
        )}
      </div>

      {selected ? (
        <NodeInspector
          node={selected}
          def={defsById.get(selected.defId)}
          issues={diag.issuesByNode.get(selected.id) ?? []}
          nodes={workflow.nodes}
          edges={workflow.edges}
          defsById={defsById}
          onChange={(config) => {
            patchNodes(workflow.nodes.map((n) => (n.id === selected.id ? { ...n, config } : n)));
          }}
          onRename={(label) => {
            patchNodes(workflow.nodes.map((n) => (n.id === selected.id ? { ...n, label } : n)));
          }}
          onDelete={() => {
            removeNode(selected.id);
          }}
        />
      ) : (
        <aside className={styles.placeholder} aria-label="Configurazione del nodo">
          <p>Seleziona un nodo per configurarlo.</p>
        </aside>
      )}
    </div>
  );
}

/** L'id di un collegamento nel canvas. Include l'indice perché due nodi
 *  possono essere uniti da più rami (le porte di un `logic_if`). */
function edgeId(e: WorkflowEdge, index: number): string {
  return `${e.from}->${e.to}#${String(index)}`;
}

/** Gli stessi id leggibili che assegna l'agente: `action_http`, poi
 *  `action_http_2`. Un workflow costruito a mano e uno generato si leggono
 *  allo stesso modo. */
function uniqueId(defId: string, nodes: readonly CanvasNode[]): string {
  const base = defId.toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'nodo';
  if (!nodes.some((n) => n.id === base)) return base;
  let i = 2;
  while (nodes.some((n) => n.id === `${base}_${String(i)}`)) i++;
  return `${base}_${String(i)}`;
}
