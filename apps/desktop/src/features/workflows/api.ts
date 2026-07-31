/**
 * Ponte verso i comandi Tauri dei workflow.
 *
 * Il grafo attraversa il confine come stringa JSON: il Rust lo conserva
 * senza interpretarlo, quindi la forma del documento resta definita da un
 * punto solo — `types.ts` — e non da due schemi da tenere allineati.
 */

import { invoke } from '@tauri-apps/api/core';

import type { Workflow } from './types';

export interface WorkflowSummary {
  id: number;
  name: string;
  description?: string;
  executionTarget: 'local' | 'server';
  enabled: boolean;
  nodeCount: number;
  updatedAt: string;
}

export interface WorkflowRecord {
  id: number;
  name: string;
  description?: string;
  graphJson: string;
  executionTarget: 'local' | 'server';
  enabled: boolean;
  runtimeId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Il documento salvato, riportato nella forma con cui lavora l'editor. */
export function toWorkflow(record: WorkflowRecord): Workflow {
  const graph = JSON.parse(record.graphJson) as Partial<Workflow>;
  return {
    id: String(record.id),
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
    ...(graph.nodeDefs ? { nodeDefs: graph.nodeDefs } : {}),
    ...(record.runtimeId ? { runtimeId: record.runtimeId } : {}),
    executionTarget: record.executionTarget,
  };
}

export const workflowApi = {
  list: (): Promise<WorkflowSummary[]> => invoke('workflow_list'),

  get: async (id: number): Promise<Workflow | null> => {
    const record = await invoke<WorkflowRecord | null>('workflow_get', { id });
    return record ? toWorkflow(record) : null;
  },

  /** Salva e restituisce l'id: per un workflow nuovo è quello appena creato. */
  save: (workflow: Workflow, enabled = false): Promise<number> =>
    invoke('workflow_save', {
      workflow: {
        id: workflow.id ? Number(workflow.id) : null,
        name: workflow.name,
        description: workflow.description ?? null,
        graphJson: JSON.stringify({
          nodes: workflow.nodes,
          edges: workflow.edges,
          ...(workflow.nodeDefs ? { nodeDefs: workflow.nodeDefs } : {}),
        }),
        executionTarget: workflow.executionTarget ?? 'local',
        enabled,
      },
    }),

  setEnabled: (id: number, enabled: boolean): Promise<void> =>
    invoke('workflow_set_enabled', { id, enabled }),

  remove: (id: number): Promise<void> => invoke('workflow_delete', { id }),

  duplicate: (id: number): Promise<number> => invoke('workflow_duplicate', { id }),
};
