/**
 * Una colonna che si ridimensiona trascinandone il bordo.
 *
 * Su un editor con quattro colonne — elenco, palette, canvas, pannello — la
 * larghezza giusta dipende da cosa si sta facendo: mentre si configura un
 * nodo serve spazio a destra, mentre si disegna serve al centro.
 *
 * Tre modi di rimetterla a posto, perché una colonna allargata per sbaglio
 * non deve diventare un problema: **doppio click** sul bordo torna alla
 * misura di partenza, le **frecce** la spostano di dieci pixel per volta, e
 * il menu di sistema del pannello ha sempre il comando di ripristino.
 *
 * Il trascinamento usa la cattura del puntatore: gli eventi arrivano alla
 * maniglia anche quando il mouse esce dalla colonna, che è esattamente quello
 * che succede trascinando.
 */

import { useCallback, useRef, useState, type PointerEvent, type ReactNode } from 'react';

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
  minWidth = 200,
  maxWidth = 640,
  handle,
  children,
}: Props) {
  const [width, setWidth] = useState(() => readStored(storageKey, defaultWidth));
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(value))),
    [minWidth, maxWidth],
  );

  const store = useCallback(
    (value: number) => {
      localStorage.setItem(storageKey, String(value));
    },
    [storageKey],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // La cattura fa arrivare i movimenti a questo elemento anche quando il
    // puntatore esce dalla colonna: senza, il trascinamento si perde appena
    // si supera il bordo.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    // La colonna cresce verso l'interno: a destra si allarga trascinando
    // verso sinistra.
    setWidth(clamp(handle === 'start' ? box.right - e.clientX : e.clientX - box.left));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    store(width);
  };

  const reset = () => {
    setWidth(defaultWidth);
    store(defaultWidth);
  };

  const nudge = (delta: number) => {
    setWidth((w) => {
      const next = clamp(w + delta);
      store(next);
      return next;
    });
  };

  return (
    <div
      ref={ref}
      className={styles.column}
      data-dragging={dragging ? 'true' : undefined}
      style={{ inlineSize: `${String(width)}px` }}
    >
      <div
        className={styles.handle}
        data-side={handle}
        role="separator"
        aria-orientation="vertical"
        aria-label="Ridimensiona la colonna — doppio click per rimetterla com’era"
        title="Trascina per ridimensionare · doppio click per rimetterla com’era"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          const inward = handle === 'start' ? step : -step;
          if (e.key === 'ArrowLeft') nudge(inward);
          else if (e.key === 'ArrowRight') nudge(-inward);
          else if (e.key === 'Home' || e.key === 'Escape') reset();
          else return;
          e.preventDefault();
        }}
      />
      {children}
    </div>
  );
}
