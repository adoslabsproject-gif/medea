/**
 * trigger-watchers/run-dispatcher — contratto condiviso tra i moduli watcher e
 * RunService (split 2026-06-12). Superficie MINIMA: i watcher non devono vedere
 * pins/steps/duration, solo "fai partire un run e dimmi com'è andata".
 *
 * `RunService.execute` soddisfa strutturalmente `DispatchTriggerRun` senza
 * adapter: input più stretto (campi required ⊂ ExecuteRunInput optional),
 * output più largo (i campi extra vengono ignorati).
 */

export interface TriggerRunInput {
  workflowId: string;
  tenantId: string;
  triggerType: string;
  triggerInput: unknown;
}

export interface TriggerRunResult {
  runId: string;
  status: string;
  errorCount: number;
}

export type DispatchTriggerRun = (input: TriggerRunInput) => Promise<TriggerRunResult>;
