/**
 * Una colonna che si ridimensiona trascinandone il bordo.
 *
 * Su un editor con quattro colonne — elenco, palette, canvas, pannello — la
 * larghezza giusta dipende da cosa si sta facendo: mentre si configura un
 * nodo serve spazio a destra, mentre si disegna serve al centro. Una misura
 * fissa va bene per nessuno dei due.
 *
 * La misura scelta resta fra una sessione e l'altra, per chiave: chi allarga
 * il pannello dei nodi non se lo ritrova stretto il giorno dopo.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import styles from './ResizableColumn.module.css';

interface Props {
  /** Dove salvare la misura. Deve essere unica per colonna. */
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  /** Da che lato sta la maniglia: `start` per le colonne di destra. */
  handle: 'start' | 'end';
  children: ReactNode;
}

function readStored(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ResizableColumn({
  storageKey,
  defaultWidth,
  minWidth = 180,
  maxWidth = 720,
  handle,
  children,
}: Props) {
  const [width, setWidth] = useState(() => readStored(storageKey, defaultWidth));
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, value)),
    [minWidth, maxWidth],
  );

  useEffect(() => {
    if (!dragging.current) return;
    const onMove = (e: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      // La maniglia sta dal lato opposto al bordo da cui si misura: a destra
      // la larghezza cresce trascinando verso sinistra.
      const next = handle === 'start' ? box.right - e.clientX : e.clientX - box.left;
      setWidth(clamp(next));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.classList.remove(styles.resizing ?? '');
      localStorage.setItem(storageKey, String(width));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  });

  return (
    <div ref={ref} className={styles.column} style={{ inlineSize: `${String(width)}px` }}>
      <div
        className={styles.handle}
        data-side={handle}
        role="separator"
        aria-orientation="vertical"
        aria-label="Ridimensiona la colonna"
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          document.body.classList.add(styles.resizing ?? '');
        }}
        onKeyDown={(e) => {
          // Anche da tastiera: chi non usa il mouse deve poter allargare.
          const step = e.shiftKey ? 40 : 10;
          if (e.key === 'ArrowLeft') {
            setWidth((w) => clamp(handle === 'start' ? w + step : w - step));
          } else if (e.key === 'ArrowRight') {
            setWidth((w) => clamp(handle === 'start' ? w - step : w + step));
          } else {
            return;
          }
          e.preventDefault();
        }}
      />
      {children}
    </div>
  );
}
