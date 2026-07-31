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
  type Connection,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { findNode } from '../catalog';
import { ResizableColumn } from '../shared';
import type { CanvasNode, NodeDef, Workflow, WorkflowEdge } from '../types';

import { CanvasSearch } from './CanvasSearch';
import { copySelection, duplicateNodes, paste, type Clipboard } from './clipboard';
import { diagnose } from './diagnostics';
import {
  addEdge,
  dropEdge,
  dropNode,
  edgeId,
  insertBetween,
  setMapMode,
  uniqueNodeId,
} from './graph-ops';
import { nextFreeSpot } from './layout';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import { PlusEdge, type MapMode } from './PlusEdge';
import { useCanvasProjection } from './useCanvasProjection';
import styles from './WorkflowCanvas.module.css';
import { WorkflowNode } from './WorkflowNode';

import './xyflow.css';

const NODE_TYPES: NodeTypes = { medea: WorkflowNode };
const EDGE_TYPES: EdgeTypes = { plus: PlusEdge };

interface Props {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
}

export function WorkflowCanvas({ workflow, onChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Il collegamento su cui si sta inserendo un nodo, se l'utente ha
   *  premuto il «+». La palette cambia modo finché non sceglie. */
  const [insertOn, setInsertOn] = useState<WorkflowEdge | null>(null);
  const [searching, setSearching] = useState(false);
  /** Gli appunti vivono qui: incollare in un altro workflow non ha senso,
   *  i nodi si porterebbero dietro riferimenti che là non esistono. */
  const clipboard = useRef<Clipboard | null>(null);

  // I callback degli edge vivono dentro lo stato di xyflow e sopravvivono
  // ai ridisegni: devono vedere il documento di adesso, non quello di
  // quando sono stati creati.
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

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

  // I callback dei collegamenti vivono dentro lo stato di xyflow e
  // sopravvivono ai ridisegni: leggono il documento dal ref, quindi vedono
  // sempre quello di adesso.
  const edgeCallbacks = useMemo(
    () => ({
      onInsert: (edge: WorkflowEdge) => {
        setInsertOn(edge);
      },
      onDelete: (edge: WorkflowEdge) => {
        onChangeRef.current(dropEdge(workflowRef.current, edge));
      },
      onCycleMapMode: (edge: WorkflowEdge, next: MapMode) => {
        onChangeRef.current(setMapMode(workflowRef.current, edge, next));
      },
    }),
    [],
  );

  const { nodes, edges, onNodesChange, onEdgesChange } = useCanvasProjection({
    workflow,
    defsById,
    diag,
    selectedId,
    callbacks: edgeCallbacks,
  });

  const patchNodes = useCallback(
    (next: CanvasNode[]) => {
      onChange({ ...workflow, nodes: next });
    },
    [workflow, onChange],
  );

  const removeNode = useCallback(
    (id: string) => {
      onChange(dropNode(workflow, id));
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

  const addFromPalette = useCallback(
    (def: NodeDef) => {
      const spot = nextFreeSpot(workflow.nodes);
      const id = uniqueNodeId(def.defId, workflow.nodes);
      const config: Record<string, unknown> = {};
      // I valori predefiniti si applicano subito: è ciò che rende un nodo
      // appena messo già quasi pronto invece che tutto da compilare.
      for (const f of def.configFields ?? []) {
        if (f.defaultValue !== undefined) config[f.key] = f.defaultValue;
      }
      const node: CanvasNode = { id, defId: def.defId, x: spot.x, y: spot.y, config };

      if (insertOn) {
        // Inserire in mezzo significa spezzare il collegamento in due, non
        // aggiungere un nodo scollegato accanto.
        onChange(insertBetween(workflow, insertOn, node));
        setInsertOn(null);
      } else {
        onChange({ ...workflow, nodes: [...workflow.nodes, node] });
      }
      setSelectedId(id);
    },
    [workflow, onChange, insertOn],
  );

  // Le scorciatoie sui nodi. Valgono sul canvas, non mentre si scrive in un
  // campo: copiare il testo di una configurazione deve copiare il testo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;

      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (meta && key === 'f') {
        e.preventDefault();
        setSearching(true);
        return;
      }
      if (typing) return;

      const wf = workflowRef.current;
      const current = selectedIdRef.current;

      if (meta && key === 'c' && current) {
        clipboard.current = copySelection(wf, [current]);
      } else if (meta && key === 'v' && clipboard.current) {
        e.preventDefault();
        const result = paste(wf, clipboard.current);
        onChangeRef.current(result.workflow);
        setSelectedId(result.newIds[0] ?? null);
      } else if (meta && key === 'd' && current) {
        e.preventDefault();
        const result = duplicateNodes(wf, [current]);
        if (result) {
          onChangeRef.current(result.workflow);
          setSelectedId(result.newIds[0] ?? null);
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && current) {
        e.preventDefault();
        onChangeRef.current(dropNode(wf, current));
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const selected = workflow.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={styles.root}>
      <ResizableColumn storageKey="medea.workflows.paletteWidth" defaultWidth={240} handle="end">
        <NodePalette
          onAdd={addFromPalette}
          {...(insertOn
            ? {
                insertMode: {
                  label: `Scegli il nodo da inserire fra "${insertOn.from}" e "${insertOn.to}"`,
                  onCancel: () => {
                    setInsertOn(null);
                  },
                },
              }
            : {})}
        />
      </ResizableColumn>

      <div className={styles.canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
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
          /* Il tetto allo zoom sta sotto 1: `fitView` ingrandisce finché non
             riempie il canvas, e con due nodi li mostrerebbe enormi. Meglio
             partire un po' più larghi — si vede il contesto e si zooma se
             serve, invece del contrario. */
          fitViewOptions={{ maxZoom: 0.75, padding: 0.3 }}
          defaultViewport={{ x: 0, y: 0, zoom: 0.75 }}
          minZoom={0.2}
          maxZoom={2}
        >
          {searching && (
            <CanvasSearch
              nodes={workflow.nodes}
              defsById={defsById}
              onClose={() => {
                setSearching(false);
              }}
              onSelect={setSelectedId}
            />
          )}

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

      {/* Il pannello del nodo compare quando serve. Tenere una colonna vuota
          con scritto «seleziona un nodo» ruba spazio al canvas per dire una
          cosa che si capisce da sola. */}
      {selected && (
        <ResizableColumn
          storageKey="medea.workflows.inspectorWidth"
          defaultWidth={336}
          minWidth={260}
          handle="start"
        >
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
        </ResizableColumn>
      )}
    </div>
  );
}
