/**
 * Annulla e ripeti sul workflow.
 *
 * La cronologia registra gli **stati**, non le operazioni: un workflow è un
 * documento piccolo, e tenerne cinquanta copie costa meno che descrivere
 * l'inverso di ogni possibile modifica — e non può sbagliare.
 *
 * Non ogni tasto premuto diventa un passo: le modifiche ravvicinate sullo
 * stesso campo si fondono, altrimenti annullare il nome di un nodo
 * richiederebbe venti Ctrl+Z quante sono le lettere.
 */

import { useCallback, useRef, useState } from 'react';

import type { Workflow } from '../types';

/** Oltre questa profondità si dimenticano i passi più vecchi. */
const MAX_HISTORY = 50;

/** Due modifiche entro questo tempo diventano un passo solo. */
const COALESCE_MS = 600;

export interface UndoRedo {
  canUndo: boolean;
  canRedo: boolean;
  /** Registra lo stato PRIMA di una modifica. */
  record: (before: Workflow) => void;
  /** Registra un passo che non va fuso con il precedente. */
  recordDistinct: (before: Workflow) => void;
  undo: (current: Workflow) => Workflow | null;
  redo: (current: Workflow) => Workflow | null;
  reset: () => void;
}

export function useUndoRedo(): UndoRedo {
  const past = useRef<Workflow[]>([]);
  const future = useRef<Workflow[]>([]);
  const lastAt = useRef(0);
  // Serve solo a far ridisegnare i pulsanti: la cronologia vera sta nei ref.
  const [, bump] = useState(0);

  const refresh = () => {
    bump((v) => v + 1);
  };

  const push = useCallback((before: Workflow, coalesce: boolean) => {
    const now = Date.now();
    const merge = coalesce && now - lastAt.current < COALESCE_MS && past.current.length > 0;
    lastAt.current = now;
    if (!merge) {
      past.current = [...past.current.slice(-(MAX_HISTORY - 1)), before];
    }
    // Una nuova modifica invalida il futuro: da qui la storia riparte.
    future.current = [];
    refresh();
  }, []);

  const record = useCallback(
    (before: Workflow) => {
      push(before, true);
    },
    [push],
  );

  const recordDistinct = useCallback(
    (before: Workflow) => {
      push(before, false);
    },
    [push],
  );

  const undo = useCallback((current: Workflow): Workflow | null => {
    const previous = past.current.at(-1);
    if (!previous) return null;
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, current];
    refresh();
    return previous;
  }, []);

  const redo = useCallback((current: Workflow): Workflow | null => {
    const next = future.current.at(-1);
    if (!next) return null;
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, current];
    refresh();
    return next;
  }, []);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    refresh();
  }, []);

  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    record,
    recordDistinct,
    undo,
    redo,
    reset,
  };
}
