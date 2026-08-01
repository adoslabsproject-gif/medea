/**
 * Eseguire un workflow: mandarlo al runtime, farlo partire, seguirlo.
 *
 * Il workflow vive nel database di Medea; il runtime ne tiene una copia con
 * un identificativo suo. La prima esecuzione gliela manda, le successive la
 * aggiornano — per questo Medea ricorda `runtimeId`: senza, ogni giro
 * creerebbe un workflow nuovo là dentro.
 *
 * Il seguito è a eventi, non a domande ripetute: il runtime annuncia ogni
 * passo mentre lo compie. Resta una verifica ogni tanto come rete di
 * sicurezza — se il flusso cade a metà, l'esecuzione non deve restare
 * «in corso» per sempre a schermo.
 */

import { invoke } from '@tauri-apps/api/core';

import type { RunStatus, RunStep } from '../runs';
import type { Workflow } from '../types';

import { reloadRuntime, runtimeApi } from './client';
import { closeRuntimeEvents, subscribeRuntime } from './events';
import { FINISHED, fetchRun, toSteps } from './run-mapping';
import type { RuntimeStep } from './run-mapping';

/** Ogni quanto ci si accerta che l'esecuzione esista ancora, se tace. */
const HEARTBEAT_MS = 4_000;
/** Oltre questo tempo si smette di seguire: l'esecuzione continua, ma non la
 *  si aspetta più a schermo. */
const FOLLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface RuntimeWorkflowResponse {
  workflow: { id: string };
}

/** Il corpo che il runtime si aspetta: il documento, senza i nostri campi. */
function toRuntimeBody(workflow: Workflow, enabled?: boolean) {
  return {
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    nodes: workflow.nodes,
    edges: workflow.edges,
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

/**
 * Quale delle due copie: quella che gira, o quella di prova.
 *
 * Il motore ne tiene una per identificativo, e quella pubblicata è ciò che lo
 * scheduler esegue. Scriverci sopra per provare una modifica significherebbe
 * mandarla in produzione senza che nessuno l'abbia chiesto.
 */
type Copia = 'pubblicata' | 'prova';

/**
 * Assicura che il runtime abbia questo workflow, e restituisce il suo
 * identificativo là dentro.
 *
 * La copia di **prova** viaggia sempre spenta: esiste per essere eseguita a
 * mano, non per far scattare trigger.
 */
export async function syncToRuntime(
  workflow: Workflow,
  runtimeId?: string,
  enabled?: boolean,
  copia: Copia = 'pubblicata',
): Promise<string> {
  const body = toRuntimeBody(workflow, copia === 'prova' ? false : enabled);

  if (runtimeId) {
    try {
      await runtimeApi.put(`/workflows/${runtimeId}`, body);
      return runtimeId;
    } catch {
      // Il runtime non lo conosce più (database azzerato, copia spostata):
      // se ne crea uno nuovo invece di fallire.
    }
  }

  const created = await runtimeApi.post<RuntimeWorkflowResponse>('/workflows', body);
  const id = created.workflow.id;

  if (workflow.id) {
    await invoke(copia === 'prova' ? 'workflow_set_draft_runtime_id' : 'workflow_set_runtime_id', {
      id: Number(workflow.id),
      runtimeId: id,
    });
  }
  return id;
}

/**
 * Attiva o disattiva il workflow **davvero**: lo manda al runtime con lo
 * stato giusto e gli fa riprendere la pianificazione.
 *
 * Il riavvio è necessario perché lo scheduler carica i cron una volta sola
 * all'avvio: senza, il pulsante «Attivo» scriverebbe un flag che nessuno
 * legge — interfaccia che promette un comportamento inesistente.
 */
export async function setEnabledOnRuntime(workflow: Workflow, enabled: boolean): Promise<string> {
  const runtimeId = await syncToRuntime(workflow, workflow.runtimeId, enabled, 'pubblicata');
  // Attivare È pubblicare: da questo momento quello che gira è il documento
  // che si sta guardando, e le modifiche successive restano bozza.
  if (workflow.id) await invoke('workflow_mark_published', { id: Number(workflow.id) });
  await reloadRuntime();
  // Il riavvio invalida la sessione: il flusso aperto sulla vecchia va
  // riaperto, altrimenti gli ascoltatori restano attaccati a un processo morto.
  closeRuntimeEvents();
  return runtimeId;
}

export interface RunProgress {
  runId: string;
  status: RunStatus;
  steps: RunStep[];
  errorCount: number;
  totalDurationMs?: number;
}

/**
 * Esegue il workflow e resta a guardare finché non finisce.
 *
 * `onProgress` viene chiamato a ogni passo: è quello che permette di vedere i
 * nodi accendersi mentre succede, invece di aspettare in silenzio.
 *
 * Lo storico lo scrive il sorvegliante (`watcher.ts`), che ascolta lo stesso
 * flusso: qui si guarda soltanto.
 */
export async function runWorkflow(
  workflow: Workflow,
  options: {
    runtimeId?: string;
    input?: unknown;
    onProgress?: (progress: RunProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<RunProgress> {
  // Sulla copia di PROVA, mai su quella pubblicata. Prima «Esegui» ci
  // scriveva sopra: si cambiava un indirizzo per vedere l'effetto, e il cron
  // del mattino dopo usava quello.
  const runtimeId = await syncToRuntime(
    workflow,
    options.runtimeId ?? workflow.draftRuntimeId,
    false,
    'prova',
  );
  const started = await runtimeApi.post<{ runId: string }>(`/workflows/${runtimeId}/run`, {
    input: options.input ?? {},
  });

  return follow(started.runId, options);
}

/**
 * Segue un'esecuzione già avviata fino alla fine.
 *
 * I passi arrivano dagli eventi. La verifica periodica serve al caso in cui
 * il flusso si interrompa: senza, un'esecuzione finita resterebbe «in corso»
 * a schermo per sempre, che è il modo più efficace per far sembrare rotto
 * qualcosa che ha funzionato.
 */
function follow(
  runId: string,
  options: { onProgress?: (progress: RunProgress) => void; signal?: AbortSignal } = {},
): Promise<RunProgress> {
  return new Promise<RunProgress>((resolve) => {
    const steps = new Map<string, RunStep>();
    let last: RunProgress = { runId, status: 'running', steps: [], errorCount: 0 };
    let done = false;

    const report = () => {
      last = { ...last, steps: [...steps.values()] };
      options.onProgress?.(last);
    };

    const finish = (progress: RunProgress) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
      resolve(progress);
    };

    /** Chiede il quadro completo: alla fine, o quando il flusso tace. */
    const reconcile = async () => {
      try {
        const run = await fetchRun(runId);
        for (const step of toSteps(run.steps ?? [])) steps.set(step.nodeId, step);
        last = {
          runId,
          status: run.status,
          steps: [...steps.values()],
          errorCount: run.errorCount ?? 0,
          ...(run.totalDurationMs !== undefined ? { totalDurationMs: run.totalDurationMs } : {}),
        };
        options.onProgress?.(last);
        if (FINISHED.has(run.status)) finish(last);
      } catch {
        // Il runtime non risponde: ci riproverà il battito successivo.
      }
    };

    const unsubscribe = subscribeRuntime((event) => {
      const data = event.data as { runId?: string; step?: RuntimeStep };
      if (data.runId !== runId) return;

      if (event.name === 'run.step' && data.step) {
        const [mapped] = toSteps([data.step]);
        if (mapped) steps.set(mapped.nodeId, mapped);
        report();
        return;
      }

      if (
        event.name === 'run.completed' ||
        event.name === 'run.errored' ||
        event.name === 'run.paused' ||
        event.name === 'run.cancelled'
      ) {
        void reconcile();
      }
    });

    const heartbeat = setInterval(() => void reconcile(), HEARTBEAT_MS);
    const deadline = setTimeout(() => {
      finish(last);
    }, FOLLOW_TIMEOUT_MS);

    const onAbort = () => {
      finish(last);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
