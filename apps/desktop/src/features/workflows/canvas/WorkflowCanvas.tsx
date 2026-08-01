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
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { findNode } from '../catalog';
import { useLastRunOutputs } from '../runs';
import { ResizableColumn } from '../shared';
import type { CanvasNode, NodeDef, Workflow, WorkflowEdge } from '../types';

import { CanvasSearch } from './CanvasSearch';
import { diagnose } from './diagnostics';
import { draggedNode } from './drag-node';
import { dropEdge, dropNode, insertBetween, setMapMode, uniqueNodeId } from './graph-ops';
import { nextFreeSpot } from './layout';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import { PlusEdge, type MapMode } from './PlusEdge';
import { SelectionBar } from './SelectionBar';
import { newNote, StickyNotes } from './StickyNotes';
import { useCanvasHandlers } from './useCanvasHandlers';
import { useCanvasProjection } from './useCanvasProjection';
import { useCanvasShortcuts } from './useCanvasShortcuts';
import styles from './WorkflowCanvas.module.css';
import { WorkflowNode } from './WorkflowNode';

import './xyflow.css';

const NODE_TYPES: NodeTypes = { medea: WorkflowNode };
const EDGE_TYPES: EdgeTypes = { plus: PlusEdge };

interface Props {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
  /** L'esito per nodo dell'esecuzione in corso o appena finita. */
  runByNode?: ReadonlyMap<string, { status: string; durationMs?: number }>;
  /** Vero quando il motore è in piedi: abilita la prova del singolo nodo. */
  runtimeReady?: boolean;
}

export function WorkflowCanvas({ workflow, onChange, runByNode, runtimeReady = false }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Tutti i nodi presi insieme, quando se ne prende più d'uno. */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** Il collegamento su cui si sta inserendo un nodo, se l'utente ha
   *  premuto il «+». La palette cambia modo finché non sceglie. */
  const [insertOn, setInsertOn] = useState<WorkflowEdge | null>(null);
  const [searching, setSearching] = useState(false);
  /** Perché l'ultimo collegamento è stato rifiutato. Sparisce da solo. */
  const [rifiuto, setRifiuto] = useState<string | null>(null);
  /** L'istanza di React Flow, presa all'avvio: serve a tradurre le coordinate
   *  del puntatore in quelle del disegno. `useReactFlow` non si può usare qui
   *  — vorrebbe un provider attorno al componente che disegna il canvas. */
  const flow = useRef<ReactFlowInstance | null>(null);
  /** Cosa ha prodotto ogni nodo l'ultima volta: i suggerimenti di espressione
   *  che ne nascono sono quelli veri, non quelli dichiarati. */
  const lastOutputs = useLastRunOutputs(workflow.id ? Number(workflow.id) : null);

  // I callback degli edge vivono dentro lo stato di xyflow e sopravvivono
  // ai ridisegni: devono vedere il documento di adesso, non quello di
  // quando sono stati creati.
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
    ...(runByNode ? { runByNode } : {}),
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

  const { commitPositions, connect, reconnect, removeEdges } = useCanvasHandlers({
    workflow,
    onChange,
    patchNodes,
    defsById,
    onRefused: setRifiuto,
  });

  /**
   * Mette un nodo sul disegno, eventualmente in un punto preciso.
   *
   * Senza coordinate lo si mette dove c'è posto — è quello che serve al
   * click sulla palette. Con le coordinate lo si mette dove è stato
   * lasciato cadere, che è la sola cosa che rende utile il trascinamento.
   */
  const addFromPalette = useCallback(
    (def: NodeDef, at?: { x: number; y: number }) => {
      const spot = at ?? nextFreeSpot(workflow.nodes);
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

  /**
   * Il nodo lasciato cadere dalla palette.
   *
   * Le coordinate del puntatore sono quelle dello schermo: vanno riportate
   * nel sistema del disegno, altrimenti il nodo compare a metri di distanza
   * da dove lo si è lasciato.
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const defId = draggedNode(event.dataTransfer);
      if (!defId) return;
      const def = findNode(defId);
      if (!def) return;

      const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (!point) return;
      // Il puntatore sta al centro di quello che si trascina: il nodo va
      // spostato di mezza carta, o risulta sempre in basso a destra.
      addFromPalette(def, { x: point.x - 70, y: point.y - 60 });
    },
    [addFromPalette],
  );

  /**
   * Copia più nodi insieme, con i loro collegamenti interni.
   *
   * Le copie nascono spostate: sovrapposte all'originale sembrerebbero non
   * essere state create. E i collegamenti si portano dietro solo quelli fra
   * nodi copiati — un collegamento verso l'esterno finirebbe su un nodo che
   * la copia non ha.
   */
  const duplicateNodes = useCallback(
    (ids: readonly string[]) => {
      const insieme = new Set(ids);
      const daCopiare = workflow.nodes.filter((n) => insieme.has(n.id));
      if (daCopiare.length === 0) return;

      const rinomina = new Map<string, string>();
      const copie: CanvasNode[] = [];
      let esistenti = workflow.nodes;

      for (const node of daCopiare) {
        const id = uniqueNodeId(node.defId, esistenti);
        rinomina.set(node.id, id);
        const copia: CanvasNode = { ...node, id, x: node.x + 40, y: node.y + 40 };
        copie.push(copia);
        esistenti = [...esistenti, copia];
      }

      const collegamenti = workflow.edges
        .filter((e) => insieme.has(e.from) && insieme.has(e.to))
        .map((e) => ({
          ...e,
          from: rinomina.get(e.from) ?? e.from,
          to: rinomina.get(e.to) ?? e.to,
        }));

      onChange({
        ...workflow,
        nodes: [...workflow.nodes, ...copie],
        edges: [...workflow.edges, ...collegamenti],
      });
    },
    [workflow, onChange],
  );

  // Il motivo del rifiuto si legge e se ne va: è un'informazione di un
  // istante, non un errore da chiudere.
  useEffect(() => {
    if (!rifiuto) return;
    const timer = setTimeout(() => {
      setRifiuto(null);
    }, 3500);
    return () => {
      clearTimeout(timer);
    };
  }, [rifiuto]);

  useCanvasShortcuts({
    workflow,
    selectedId,
    onChange,
    onSelect: setSelectedId,
    onSearch: () => {
      setSearching(true);
    },
  });

  const selected = workflow.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={styles.root}>
      <ResizableColumn storageKey="medea.workflows.paletteWidth" defaultWidth={240} handle="end">
        <button
          type="button"
          className={styles.addNote}
          title="Una nota spiega PERCHÉ, che nessun nome di nodo può dire"
          onClick={() => {
            onChange({
              ...workflow,
              notes: [...(workflow.notes ?? []), newNote(workflow.notes ?? [])],
            });
          }}
        >
          + Nota
        </button>

        {rifiuto && (
          <div className={styles.refused} role="status">
            {rifiuto}
          </div>
        )}

        <SelectionBar
          count={selectedIds.length}
          onClear={() => {
            setSelectedIds([]);
            setSelectedId(null);
          }}
          onDelete={() => {
            for (const id of selectedIds) removeNode(id);
            setSelectedIds([]);
            setSelectedId(null);
          }}
          onDuplicate={() => {
            duplicateNodes(selectedIds);
          }}
        />

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
          onEdgesDelete={removeEdges}
          onConnect={connect}
          onReconnect={reconnect}
          /* Alla griglia: un disegno con i nodi allineati si legge, uno con
             i nodi a due pixel di scarto sembra sciatto senza che si capisca
             perché. Venti pixel è abbastanza fine da non combattere. */
          snapToGrid
          snapGrid={[20, 20]}
          onNodeClick={(_, node) => {
            setSelectedId(node.id);
          }}
          onSelectionChange={({ nodes: selezionati }) => {
            setSelectedIds(selezionati.map((n) => n.id));
          }}
          onPaneClick={() => {
            setSelectedId(null);
          }}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onDrop={onDrop}
          onDragOver={(event) => {
            // Senza questo il browser rifiuta il rilascio e non arriva mai
            // un `drop`: è la riga che fa la differenza fra un trascinamento
            // che funziona e uno che sembra rotto.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          /* Tenendo Maiusc si tira un rettangolo e si prendono più nodi
             insieme; con Cmd/Ctrl si aggiunge un nodo alla volta. Sono le
             stesse dita di qualunque editor grafico: non c'è niente da
             imparare. */
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Meta', 'Control']}
          deleteKeyCode={['Backspace', 'Delete']}
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

          {/* Le note stanno DENTRO il riquadro del canvas ma fuori dal
              grafo: non partecipano all'esecuzione, e il motore non le vede. */}
          <StickyNotes workflow={workflow} onChange={onChange} />

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
            onNodeChange={(patch) => {
              patchNodes(
                workflow.nodes.map((n) => (n.id === selected.id ? { ...n, ...patch } : n)),
              );
            }}
            runtimeReady={runtimeReady}
            lastOutputs={lastOutputs}
            {...(workflow.runtimeId ? { runtimeId: workflow.runtimeId } : {})}
            onDelete={() => {
              removeNode(selected.id);
            }}
          />
        </ResizableColumn>
      )}
    </div>
  );
}
