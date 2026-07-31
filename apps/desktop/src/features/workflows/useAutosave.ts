/**
 * Il salvataggio automatico.
 *
 * Perdere mezz'ora di lavoro perché si è chiusa una finestra è inaccettabile,
 * quindi si salva da soli. Ma salvare a ogni tasto premuto vorrebbe dire
 * scrivere sul disco venti volte per un nome di nodo: si aspetta che l'utente
 * si fermi.
 *
 * Il salvataggio automatico **non** sostituisce quello esplicito: cambia solo
 * cosa vuol dire «scarta». Con l'autosalvataggio, scartare significa tornare
 * a com'era quando hai aperto il workflow (o all'ultima volta che hai premuto
 * Salva), non all'ultimo istante — quello è già sul disco.
 */

import { useEffect, useRef } from 'react';

import type { Workflow } from './types';

/** Quanto silenzio serve prima di scrivere. */
const QUIET_MS = 1500;

interface Options {
  workflow: Workflow;
  /** Vero quando c'è qualcosa da salvare. */
  dirty: boolean;
  enabled: boolean;
  onSave: () => void | Promise<void>;
}

/**
 * Vero quando vale la pena salvare: un documento vuoto e senza nome non deve
 * creare una riga nel database solo perché la sezione è aperta.
 */
export function worthSaving(workflow: Workflow): boolean {
  return Boolean(workflow.id) || workflow.nodes.length > 0;
}

export function useAutosave({ workflow, dirty, enabled, onSave }: Options): void {
  // Il salvataggio cambia a ogni render (dipende dal documento): tenerlo in
  // un ref evita di far ripartire il timer per quello.
  const save = useRef(onSave);
  save.current = onSave;

  const shouldSave = enabled && dirty && worthSaving(workflow);

  useEffect(() => {
    if (!shouldSave) return;
    const timer = setTimeout(() => {
      void save.current();
    }, QUIET_MS);
    // Ogni modifica rimanda: si scrive quando l'utente si ferma, non mentre
    // sta ancora lavorando.
    return () => {
      clearTimeout(timer);
    };
  }, [shouldSave, workflow]);
}
