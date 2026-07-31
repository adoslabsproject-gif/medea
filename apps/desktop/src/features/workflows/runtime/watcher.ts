/**
 * Chi raccoglie le esecuzioni che nessuno ha chiesto.
 *
 * Un workflow con un cron, o in ascolto su una casella di posta, parte da
 * solo. Prima quelle esecuzioni esistevano solo nel database del runtime:
 * Medea le scopriva mai, e lo storico mostrava solo i tasti premuti a mano —
 * cioè raccontava una bugia sull'automazione.
 *
 * Qui si ascolta il flusso degli eventi e si registra tutto: la riga nasce
 * appena l'esecuzione parte (così un blocco a metà lascia comunque traccia) e
 * si riscrive quando finisce.
 */

import { invoke } from '@tauri-apps/api/core';

import type { WorkflowRecord } from '../api';

import { subscribeRuntime } from './events';
import { fetchRun, mirrorRun } from './run-mapping';

/** Il workflow di Medea che il runtime conosce con questo nome. */
async function medeaWorkflowId(runtimeId: string): Promise<number | null> {
  const record = await invoke<WorkflowRecord | null>('workflow_by_runtime_id', { runtimeId });
  return record ? record.id : null;
}

interface StartedData {
  runId?: string;
  workflowId?: string;
  triggeredBy?: string;
}

interface FinishedData {
  runId?: string;
}

/**
 * Chi ha fatto partire l'esecuzione, in parole.
 *
 * Il runtime dice `cron`, `webhook`, `imap`; quando è Medea a premere il
 * pulsante il campo arriva vuoto ed è giusto che sia così.
 */
function author(triggeredBy: string | undefined): string {
  if (!triggeredBy || triggeredBy === 'manual') return 'Medea';
  return triggeredBy;
}

export interface WatcherOptions {
  /** Chiamata dopo ogni scrittura nello storico: serve a ridisegnare gli elenchi. */
  onChange?: (workflowId: number) => void;
}

/**
 * Comincia ad ascoltare. Restituisce la funzione per smettere.
 *
 * Le esecuzioni di workflow che Medea non conosce vengono ignorate senza
 * rumore: possono venire da prove fatte fuori dall'app, e non sono suoi.
 */
export function startRunWatcher(options: WatcherOptions = {}): () => void {
  /** Da esecuzione a workflow: serve alla fine, quando l'evento ha solo il runId. */
  const owners = new Map<string, number>();

  return subscribeRuntime((event) => {
    void (async () => {
      try {
        if (event.name === 'run.started') {
          const data = event.data as StartedData;
          if (!data.runId || !data.workflowId) return;
          const id = await medeaWorkflowId(data.workflowId);
          if (id === null) return;
          owners.set(data.runId, id);
          await mirrorRun(
            id,
            {
              id: data.runId,
              status: 'running',
              errorCount: 0,
              startedAt: event.ts,
              steps: [],
            },
            author(data.triggeredBy),
          );
          options.onChange?.(id);
          return;
        }

        if (
          event.name === 'run.completed' ||
          event.name === 'run.errored' ||
          event.name === 'run.paused' ||
          event.name === 'run.cancelled'
        ) {
          const data = event.data as FinishedData;
          if (!data.runId) return;
          const id = owners.get(data.runId);
          if (id === undefined) return;
          owners.delete(data.runId);
          const run = await fetchRun(data.runId);
          await mirrorRun(id, run, author(run.triggerType ?? undefined));
          options.onChange?.(id);
        }
      } catch (e) {
        // Lo storico è un racconto, non il motore: se una riga non si scrive
        // l'esecuzione è già avvenuta lo stesso.
        console.warn('[runtime] non sono riuscito a registrare l’esecuzione', e);
      }
    })();
  });
}
