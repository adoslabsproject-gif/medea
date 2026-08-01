/**
 * Il collegamento fra due nodi, con i comandi che compaiono sopra.
 *
 * Passandoci sopra si vedono due pulsanti: **+** inserisce un nodo *in mezzo*
 * — il collegamento si spezza e ne nascono due — e **×** lo elimina. Senza,
 * per mettere un passaggio fra due nodi bisognerebbe cancellare il
 * collegamento, aggiungere il nodo, ricollegare due volte.
 *
 * Il badge al centro mostra la modalità di fan-out quando è attiva: se a monte
 * arriva un elenco, dice se il nodo a valle gira una volta sola o una volta
 * per elemento. Nell'originale è una scelta esplicita e visibile apposta —
 * l'implicito è la debolezza degli altri editor.
 */

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { useState } from 'react';

import type { WorkflowEdge } from '../types';

import styles from './PlusEdge.module.css';

/** Il giro delle modalità: spento → automatico → per elemento → spento. */
const MAP_MODE_CYCLE = { off: 'auto', auto: 'each', each: 'off' } as const;

export type MapMode = keyof typeof MAP_MODE_CYCLE;

export const MAP_MODE_HINT: Record<MapMode, string> = {
  off: 'Fan-out spento: l’elenco passa intero. Click per attivarlo.',
  auto: 'Fan-out automatico: se arriva un elenco, il nodo a valle gira una volta per elemento.',
  each: 'Una esecuzione per elemento: a monte deve arrivare un elenco.',
};

const MAP_MODE_LABEL: Record<MapMode, string> = {
  off: '',
  auto: 'auto',
  each: 'ognuno',
};

export interface PlusEdgeData extends Record<string, unknown> {
  mapMode?: MapMode;
  onInsert?: (edge: WorkflowEdge) => void;
  onDelete?: (edge: WorkflowEdge) => void;
  onCycleMapMode?: (edge: WorkflowEdge, next: MapMode) => void;
  edge?: WorkflowEdge;
}

export function PlusEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const d = (data ?? {}) as PlusEdgeData;
  const mapMode: MapMode = d.mapMode ?? 'off';
  const edge = d.edge;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        className={styles.path}
        // Lo stato di chi sta a monte: durante un'esecuzione si vede dove è
        // arrivato il flusso senza leggere i badge nodo per nodo.
        data-run={data?.runStatus ?? undefined}
      />

      {/* Una traccia larga e invisibile: prendere al volo una linea di due
          pixel è un esercizio di mira, non un'interazione. */}
      <path
        d={path}
        className={styles.hitArea}
        onPointerEnter={() => {
          setHovered(true);
        }}
        onPointerLeave={() => {
          setHovered(false);
        }}
      />

      <EdgeLabelRenderer>
        <div
          className={styles.tools}
          data-visible={hovered || mapMode !== 'off' ? 'true' : 'false'}
          style={{
            transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
          }}
          onPointerEnter={() => {
            setHovered(true);
          }}
          onPointerLeave={() => {
            setHovered(false);
          }}
        >
          {mapMode !== 'off' && (
            <button
              type="button"
              className={styles.mapBadge}
              title={MAP_MODE_HINT[mapMode]}
              onClick={() => {
                if (edge) d.onCycleMapMode?.(edge, MAP_MODE_CYCLE[mapMode]);
              }}
            >
              {MAP_MODE_LABEL[mapMode]}
            </button>
          )}

          {hovered && (
            <>
              <button
                type="button"
                className={styles.action}
                title="Inserisci un nodo qui in mezzo"
                aria-label="Inserisci un nodo"
                onClick={() => {
                  if (edge) d.onInsert?.(edge);
                }}
              >
                +
              </button>
              <button
                type="button"
                className={styles.action}
                title={MAP_MODE_HINT[mapMode]}
                aria-label="Cambia la modalità di fan-out"
                onClick={() => {
                  if (edge) d.onCycleMapMode?.(edge, MAP_MODE_CYCLE[mapMode]);
                }}
              >
                ⋮⋮
              </button>
              <button
                type="button"
                className={`${styles.action} ${styles.danger}`}
                title="Elimina il collegamento"
                aria-label="Elimina il collegamento"
                onClick={() => {
                  if (edge) d.onDelete?.(edge);
                }}
              >
                ✕
              </button>
            </>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
