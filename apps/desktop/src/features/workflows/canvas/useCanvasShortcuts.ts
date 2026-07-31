/**
 * Le scorciatoie da tastiera sul canvas.
 *
 * Cmd+F cerca, Cmd+C copia, Cmd+V incolla, Cmd+D duplica, Canc elimina.
 *
 * La regola che conta è quella che le disattiva: **mentre si scrive in un
 * campo non valgono**. Copiare il testo di una configurazione deve copiare
 * il testo, non il nodo; e premere Canc dentro una casella deve cancellare
 * un carattere, non il passo del workflow.
 */

import { useEffect, useRef } from 'react';

import type { Workflow } from '../types';

import { copySelection, duplicateNodes, paste, type Clipboard } from './clipboard';
import { dropNode } from './graph-ops';

interface Options {
  workflow: Workflow;
  selectedId: string | null;
  onChange: (wf: Workflow) => void;
  onSelect: (id: string | null) => void;
  onSearch: () => void;
}

/** Vero quando il tasto premuto appartiene a un campo di testo. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export function useCanvasShortcuts({
  workflow,
  selectedId,
  onChange,
  onSelect,
  onSearch,
}: Options): void {
  // I gestori si registrano una volta sola e leggono lo stato dai ref:
  // riagganciarli a ogni modifica del documento sarebbe lavoro inutile.
  const state = useRef({ workflow, selectedId, onChange, onSelect, onSearch });
  state.current = { workflow, selectedId, onChange, onSelect, onSearch };

  /** Gli appunti vivono qui: incollare in un altro workflow non ha senso,
   *  i nodi si porterebbero dietro riferimenti che là non esistono. */
  const clipboard = useRef<Clipboard | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const s = state.current;

      // La ricerca vale anche mentre si scrive: è il modo per uscire da un
      // campo e ritrovare un nodo.
      if (meta && key === 'f') {
        e.preventDefault();
        s.onSearch();
        return;
      }
      if (isTyping(e.target)) return;

      const current = s.selectedId;

      if (meta && key === 'c' && current) {
        clipboard.current = copySelection(s.workflow, [current]);
      } else if (meta && key === 'v' && clipboard.current) {
        e.preventDefault();
        const result = paste(s.workflow, clipboard.current);
        s.onChange(result.workflow);
        s.onSelect(result.newIds[0] ?? null);
      } else if (meta && key === 'd' && current) {
        e.preventDefault();
        const result = duplicateNodes(s.workflow, [current]);
        if (result) {
          s.onChange(result.workflow);
          s.onSelect(result.newIds[0] ?? null);
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && current) {
        e.preventDefault();
        s.onChange(dropNode(s.workflow, current));
        s.onSelect(null);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
