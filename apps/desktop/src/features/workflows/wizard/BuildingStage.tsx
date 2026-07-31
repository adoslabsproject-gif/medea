/**
 * Mentre costruisce.
 *
 * Due informazioni e basta: da quanto ci sta lavorando, e cosa ha montato
 * finora. Il resto — la cronologia dei passi — sta sotto, per chi vuole
 * guardare dentro.
 */

import { iconNameFor, resolveLucideIcon } from '../canvas/icon-registry';
import { findNode } from '../catalog';

import styles from './BuildingStage.module.css';
import { TraceList } from './TraceList';
import type { TraceEntry } from './types';

interface Props {
  elapsedMs: number;
  built: readonly { id: string; defId: string }[];
  trace: readonly TraceEntry[];
}

/** Il tempo trascorso, come lo direbbe una persona. */
function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)} secondi`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)} min ${String(rest).padStart(2, '0')} s`;
}

export function BuildingStage({ elapsedMs, built, trace }: Props) {
  return (
    <div className={styles.root}>
      <div className={styles.hero}>
        <span className={styles.spinner} aria-hidden="true" />
        <div>
          <p className={styles.title}>Sta costruendo il workflow</p>
          <p className={styles.time}>
            {elapsed(elapsedMs)} · {String(trace.length)} passi
          </p>
        </div>
      </div>

      {built.length > 0 && (
        <div className={styles.built}>
          {built.map((node) => {
            const def = findNode(node.defId);
            // La stessa icona che il nodo avrà sul disegno: chi guarda deve
            // riconoscere subito quello che vedrà fra un momento sul canvas.
            const Icon = resolveLucideIcon(iconNameFor(node.defId, def?.icon));
            return (
              <span key={node.id} className={styles.node} title={node.defId}>
                {Icon && <Icon size={14} aria-hidden="true" />}
                {def?.label ?? node.defId}
              </span>
            );
          })}
        </div>
      )}

      <div className={styles.trace}>
        <TraceList entries={trace} live />
      </div>
    </div>
  );
}
