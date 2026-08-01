/**
 * Le note appiccicate al disegno.
 *
 * Un workflow spiega **cosa** fa; una nota spiega **perché** — «qui
 * aspettiamo perché il gestionale impiega due minuti a indicizzare», «questo
 * ramo c'è solo per i clienti esteri». È quello che manca quando lo si riapre
 * dopo sei mesi, e nessun nome di nodo può dirlo.
 *
 * Non partecipano all'esecuzione e non entrano nel documento che va al
 * motore: vivono nel disegno, che è dove serve leggerle.
 */

import { useState } from 'react';

import type { StickyNote, Workflow } from '../types';

import styles from './StickyNotes.module.css';

interface Props {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
}

export function StickyNotes({ workflow, onChange }: Props) {
  const [inModifica, setInModifica] = useState<string | null>(null);
  const notes = workflow.notes ?? [];

  const aggiorna = (id: string, patch: Partial<StickyNote>) => {
    onChange({
      ...workflow,
      notes: notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    });
  };

  return (
    <>
      {notes.map((nota) => (
        <div
          key={nota.id}
          className={styles.note}
          style={{ transform: `translate(${String(nota.x)}px, ${String(nota.y)}px)` }}
        >
          {inModifica === nota.id ? (
            <textarea
              className={styles.editor}
              autoFocus
              aria-label="Testo della nota"
              value={nota.text}
              onChange={(e) => {
                aggiorna(nota.id, { text: e.target.value });
              }}
              onBlur={() => {
                setInModifica(null);
                // Una nota rimasta vuota sparisce: un rettangolo giallo che
                // non dice niente è solo una cosa che copre il disegno.
                if (!nota.text.trim()) {
                  onChange({ ...workflow, notes: notes.filter((n) => n.id !== nota.id) });
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.text}
              onClick={() => {
                setInModifica(nota.id);
              }}
            >
              {nota.text}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** Una nota nuova, dove c'è spazio. */
export function newNote(existing: readonly StickyNote[]): StickyNote {
  return {
    id: `nota_${String(existing.length + 1)}_${String(Math.floor(performance.now()))}`,
    x: 40,
    y: 40 + existing.length * 24,
    text: 'Perché questo pezzo è fatto così…',
  };
}
