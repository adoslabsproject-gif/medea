/**
 * Eseguire un workflow: mandarlo al runtime, farlo partire, seguirlo.
 *
 * Il workflow vive nel database di Medea; il runtime ne tiene una copia con
 * un identificativo suo. La prima esecuzione gliela manda, le successive la
 * aggiornano — per questo Medea ricorda `runtimeId`: senza, ogni giro
 * creerebbe un workflow nuovo là dentro.
 *
 * A esecuzione finita il risultato viene copiato nello storico di Medea. È
 * una duplicazione voluta: lo storico deve restare leggibile anche quando il
 * runtime non è in piedi, ed è dentro Medea che l'utente lo cerca.
 */

import { invoke } from '@tauri-apps/api/core';

import { runsApi } from '../runs';
import type { RunStatus, RunStep } from '../runs';
import type { Workflow } from '../types';

import { runtimeApi } from './client';

/** Ogni quanto si chiede al runtime a che punto è. */
const POLL_INTERVAL_MS = 400;
/** Oltre questo tempo si smette di seguire: l'esecuzione continua, ma non la
 *  si aspetta più a schermo. */
const FOLLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface RuntimeWorkflowResponse {
  workflow: { id: string };
}

interface RuntimeRunResponse {
  runId: string;
}

interface RuntimeRunDetail {
  run: {
    id: string;
    status: RunStatus;
    errorCount: number;
    totalDurationMs?: number;
    startedAt: string;
    endedAt?: string;
    triggerType?: string | null;
    steps: RuntimeStep[];
  };
}

interface RuntimeStep {
  nodeId: string;
  defId?: string;
  status: string;
  durationMs?: number;
  output?: string;
  error?: string;
  input?: string;
}

/** Il corpo che il runtime si aspetta: il documento, senza i nostri campi. */
function toRuntimeBody(workflow: Workflow) {
  return {
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    nodes: workflow.nodes,
    edges: workflow.edges,
  };
}

/**
 * Assicura che il runtime abbia questo workflow, e restituisce il suo
 * identificativo là dentro.
 */
export async function syncToRuntime(workflow: Workflow, runtimeId?: string): Promise<string> {
  if (runtimeId) {
    try {
      await runtimeApi.put(`/workflows/${runtimeId}`, toRuntimeBody(workflow));
      return runtimeId;
    } catch {
      // Il runtime non lo conosce più (database azzerato, copia spostata):
      // se ne crea uno nuovo invece di fallire.
    }
  }

  const created = await runtimeApi.post<RuntimeWorkflowResponse>(
    '/workflows',
    toRuntimeBody(workflow),
  );
  const id = created.workflow.id;

  if (workflow.id) {
    await invoke('workflow_set_runtime_id', { id: Number(workflow.id), runtimeId: id });
  }
  return id;
}

/** I passi nella forma dello storico di Medea. */
function toSteps(steps: readonly RuntimeStep[]): RunStep[] {
  return steps.map((s) => ({
    nodeId: s.nodeId,
    ...(s.defId ? { defId: s.defId } : {}),
    status:
      s.status === 'error' || s.status === 'skipped' || s.status === 'running'
        ? s.status
        : 'success',
    ...(typeof s.durationMs === 'number' ? { durationMs: s.durationMs } : {}),
    ...(s.output ? { output: s.output } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.input ? { input: s.input } : {}),
  }));
}

export interface RunProgress {
  runId: string;
  status: RunStatus;
  steps: RunStep[];
  errorCount: number;
  totalDurationMs?: number;
}

const FINISHED: ReadonlySet<RunStatus> = new Set([
  'success',
  'partial',
  'error',
  'cancelled',
  'paused',
]);

/**
 * Esegue il workflow e resta a guardare finché non finisce.
 *
 * `onProgress` viene chiamato a ogni giro: è quello che permette di vedere i
 * nodi accendersi mentre succede, invece di aspettare in silenzio.
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
  const runtimeId = await syncToRuntime(workflow, options.runtimeId);
  const started = await runtimeApi.post<RuntimeRunResponse>(`/workflows/${runtimeId}/run`, {
    input: options.input ?? {},
  });

  const deadline = Date.now() + FOLLOW_TIMEOUT_MS;
  let last: RunProgress = { runId: started.runId, status: 'running', steps: [], errorCount: 0 };

  for (;;) {
    if (options.signal?.aborted) break;
    if (Date.now() > deadline) break;

    const detail = await runtimeApi.get<RuntimeRunDetail>(`/runs/${started.runId}`);
    last = {
      runId: detail.run.id,
      status: detail.run.status,
      steps: toSteps(detail.run.steps),
      errorCount: detail.run.errorCount,
      ...(detail.run.totalDurationMs !== undefined
        ? { totalDurationMs: detail.run.totalDurationMs }
        : {}),
    };
    options.onProgress?.(last);

    if (FINISHED.has(last.status)) {
      await mirror(workflow, detail.run);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return last;
}

/** Copia l'esecuzione nello storico di Medea. */
async function mirror(workflow: Workflow, run: RuntimeRunDetail['run']): Promise<void> {
  if (!workflow.id) return;
  await runsApi.save({
    id: run.id,
    workflowId: Number(workflow.id),
    status: run.status,
    stepsJson: JSON.stringify(toSteps(run.steps)),
    errorCount: run.errorCount,
    ...(run.totalDurationMs !== undefined ? { totalDurationMs: run.totalDurationMs } : {}),
    ...(run.triggerType ? { triggerType: run.triggerType } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    triggeredBy: 'Medea',
  });
}
