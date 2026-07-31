/**
 * La cronologia dei passi, mentre accadono.
 *
 * Scorre da sola sull'ultima riga: chi guarda vuole sapere cosa sta facendo
 * *adesso*, e inseguire la lista a mano mentre si allunga è un lavoro che non
 * dovrebbe esistere.
 */

import { useEffect, useRef } from 'react';

import styles from './TraceList.module.css';
import type { TraceEntry } from './types';

interface Props {
  entries: readonly TraceEntry[];
  /** Vero mentre l'agente lavora: l'ultima riga resta «in corso». */
  live: boolean;
}

export function TraceList({ entries, live }: Props) {
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length]);

  return (
    <ol className={styles.list}>
      {entries.map((entry) => (
        <li
          key={`${String(entry.step)}-${entry.tool}`}
          className={entry.ok ? styles.row : `${styles.row} ${styles.failed}`}
        >
          <span className={styles.mark} aria-hidden="true">
            {entry.ok ? '✓' : '✕'}
          </span>
          <div className={styles.body}>
            <span className={styles.label}>{entry.label}</span>
            {entry.detail && <code className={styles.detail}>{entry.detail}</code>}
            {entry.error && <span className={styles.error}>{entry.error}</span>}
          </div>
        </li>
      ))}

      {live && (
        <li className={`${styles.row} ${styles.pending}`}>
          <span className={styles.mark} aria-hidden="true">
            ·
          </span>
          <span className={styles.label}>Sta pensando…</span>
        </li>
      )}
      <div ref={end} />
    </ol>
  );
}
