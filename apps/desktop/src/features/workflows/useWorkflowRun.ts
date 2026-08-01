/**
 * Eseguire il workflow aperto, e mostrare cosa succede mentre succede.
 *
 * Un'esecuzione a schermo spento — premi, aspetti, e poi vedi il risultato —
 * non dice se sta funzionando o si è piantata. Qui si segue passo per passo:
 * quale nodo sta girando, quali sono andati bene, dove si è rotto.
 *
 * Il workflow va salvato prima di partire: eseguire una versione diversa da
 * quella scritta sul disco vorrebbe dire che lo storico racconta di un
 * documento che non esiste.
 */

import { useCallback, useRef, useState } from 'react';

import type { RunStep } from './runs';
import { runWorkflow, type RunProgress } from './runtime';
import type { Workflow } from './types';

export interface WorkflowRun {
  running: boolean;
  /** L'ultimo stato conosciuto dell'esecuzione in corso o appena finita. */
  progress: RunProgress | null;
  /** L'esito per nodo, per accendere il canvas mentre gira. */
  stepsByNode: Map<string, RunStep>;
  error: string | null;
  /** Esegue. `input` è il finto ingresso del trigger, quando se ne dà uno. */
  start: (workflow: Workflow, input?: unknown) => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

export function useWorkflowRun(): WorkflowRun {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const start = useCallback(async (workflow: Workflow, input?: unknown) => {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;

    setRunning(true);
    setError(null);
    setProgress(null);

    try {
      const result = await runWorkflow(workflow, {
        // La copia di PROVA, non quella pubblicata: premere «Esegui» non
        // deve cambiare cosa gira alle otto del mattino.
        ...(workflow.draftRuntimeId ? { runtimeId: workflow.draftRuntimeId } : {}),
        ...(input !== undefined ? { input } : {}),
        signal: ac.signal,
        onProgress: setProgress,
      });
      setProgress(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
    setRunning(false);
  }, []);

  const clear = useCallback(() => {
    setProgress(null);
    setError(null);
  }, []);

  const stepsByNode = new Map((progress?.steps ?? []).map((s) => [s.nodeId, s]));

  return { running, progress, stepsByNode, error, start, cancel, clear };
}
