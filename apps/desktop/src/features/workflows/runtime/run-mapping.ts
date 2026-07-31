/**
 * Un'esecuzione del runtime, portata nella forma dello storico di Medea.
 *
 * La duplicazione è voluta: lo storico deve restare leggibile anche quando il
 * runtime non è in piedi, ed è dentro Medea che l'utente lo cerca.
 */

import { runsApi } from '../runs';
import type { RunStatus, RunStep } from '../runs';

import { runtimeApi } from './client';

export interface RuntimeStep {
  nodeId: string;
  defId?: string;
  status: string;
  durationMs?: number;
  output?: string;
  error?: string;
  input?: string;
}

/**
 * Un'esecuzione come la racconta il runtime.
 *
 * Conteggio e passi sono facoltativi non per pigrizia: appena partita
 * un'esecuzione non ha ancora né l'uno né gli altri, ed è proprio quel
 * momento che si vuole registrare.
 */
export interface RuntimeRun {
  id: string;
  status: RunStatus;
  errorCount?: number;
  totalDurationMs?: number;
  startedAt: string;
  endedAt?: string;
  triggerType?: string | null;
  steps?: RuntimeStep[];
}

/** Gli stati in cui un'esecuzione ha finito di muoversi. */
export const FINISHED: ReadonlySet<RunStatus> = new Set([
  'success',
  'partial',
  'error',
  'cancelled',
  'paused',
]);

/** I passi nella forma dello storico. */
export function toSteps(steps: readonly RuntimeStep[]): RunStep[] {
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

/** Il dettaglio completo di un'esecuzione, chiesto al runtime. */
export async function fetchRun(runId: string): Promise<RuntimeRun> {
  const detail = await runtimeApi.get<{ run: RuntimeRun }>(`/runs/${runId}`);
  return detail.run;
}

/**
 * Copia l'esecuzione nello storico di Medea.
 *
 * `triggeredBy` distingue chi ha premuto un pulsante da chi non c'era: una
 * riga che dice «cron» alle tre di notte è l'unica prova che l'automazione
 * lavora da sola.
 */
export async function mirrorRun(
  workflowId: number,
  run: RuntimeRun,
  triggeredBy = 'Medea',
): Promise<void> {
  await runsApi.save({
    id: run.id,
    workflowId,
    status: run.status,
    stepsJson: JSON.stringify(toSteps(run.steps ?? [])),
    errorCount: run.errorCount ?? 0,
    ...(run.totalDurationMs !== undefined ? { totalDurationMs: run.totalDurationMs } : {}),
    ...(run.triggerType ? { triggerType: run.triggerType } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    triggeredBy,
  });
}
