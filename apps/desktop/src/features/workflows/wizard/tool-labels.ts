/**
 * I passi dell'agente detti in italiano.
 *
 * L'agente ragiona per strumenti (`search_nodes`, `set_config`); l'utente
 * ragiona per intenzioni. Mostrare i nomi degli strumenti sarebbe onesto e
 * inutile: chi guarda vuole sapere se sta cercando, montando o correggendo.
 */

import type { AgentStep } from '../scaffold';

import type { TraceEntry } from './types';

const LABELS: Record<string, string> = {
  search_nodes: 'Cerca il nodo giusto',
  get_node_schema: 'Legge come si configura',
  add_node: 'Aggiunge un nodo',
  connect: 'Collega',
  set_config: 'Configura',
  delete_node: 'Toglie un nodo',
  disconnect: 'Scollega',
  validate_workflow: 'Controlla il lavoro',
  finish: 'Consegna',
};

/** Il primo valore utile fra questi campi, come stringa. */
function pick(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Il dettaglio che rende la riga leggibile: quale nodo, quale campo, cosa. */
function detailOf(tool: string, args: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'search_nodes':
      return pick(args, ['query', 'q']);
    case 'get_node_schema':
      return pick(args, ['defId']);
    case 'add_node': {
      const id = pick(args, ['id']);
      const def = pick(args, ['defId']);
      return def && id ? `${def} → ${id}` : (def ?? id);
    }
    case 'connect':
    case 'disconnect': {
      const from = pick(args, ['from']);
      const to = pick(args, ['to']);
      return from && to ? `${from} → ${to}` : undefined;
    }
    case 'set_config': {
      const id = pick(args, ['id', 'nodeId']);
      const config = args.config;
      const fields =
        config && typeof config === 'object' ? Object.keys(config).join(', ') : undefined;
      return fields ? `${id ?? ''} · ${fields}`.trim() : id;
    }
    case 'delete_node':
      return pick(args, ['id', 'nodeId']);
    default:
      return undefined;
  }
}

/** Se il risultato di un passo racconta un fallimento. */
function failureOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (record.ok === false || typeof record.error === 'string') {
    const error = record.error;
    return typeof error === 'string' ? error : 'non riuscito';
  }
  return undefined;
}

export function toTraceEntry(step: AgentStep): TraceEntry {
  const detail = detailOf(step.tool, step.args);
  const error = failureOf(step.result);
  return {
    step: step.step,
    tool: step.tool,
    label: LABELS[step.tool] ?? step.tool,
    ...(detail ? { detail } : {}),
    ok: error === undefined,
    ...(error ? { error } : {}),
    // Argomenti e risposta si conservano: sono il log del passo, e servono
    // quando un workflow esce diverso da come lo si era chiesto e bisogna
    // capire in quale punto la richiesta è stata intesa male.
    args: step.args,
    result: step.result,
  };
}

/** I nodi montati finora, letti dalla cronologia: è il disegno che nasce. */
export function builtNodes(steps: readonly AgentStep[]): { id: string; defId: string }[] {
  const out = new Map<string, string>();
  for (const step of steps) {
    const id = pick(step.args, ['id']);
    const defId = pick(step.args, ['defId']);
    if (step.tool === 'add_node' && id && defId && !failureOf(step.result)) out.set(id, defId);
    if (step.tool === 'delete_node') {
      const removed = pick(step.args, ['id', 'nodeId']);
      if (removed) out.delete(removed);
    }
  }
  return [...out].map(([id, defId]) => ({ id, defId }));
}
