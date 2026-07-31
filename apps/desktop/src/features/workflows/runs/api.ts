/**
 * Ponte verso i comandi Tauri dello storico esecuzioni.
 */

import { invoke } from '@tauri-apps/api/core';

import type { RunRecord, RunSummary } from './types';

export const runsApi = {
  /** Le ultime esecuzioni di un workflow, dalla più recente. */
  list: (workflowId: number, limit = 50): Promise<RunSummary[]> =>
    invoke('workflow_run_list', { workflowId, limit }),

  get: (id: string): Promise<RunRecord | null> => invoke('workflow_run_get', { id }),

  /** Registra o aggiorna un'esecuzione: nasce `running`, si riscrive alla fine. */
  save: (
    run: Partial<RunRecord> & Pick<RunRecord, 'id' | 'workflowId' | 'status' | 'startedAt'>,
  ): Promise<null> => invoke('workflow_run_save', { run }),

  remove: (id: string): Promise<null> => invoke('workflow_run_delete', { id }),

  clear: (workflowId: number): Promise<number> => invoke('workflow_run_clear', { workflowId }),
};
