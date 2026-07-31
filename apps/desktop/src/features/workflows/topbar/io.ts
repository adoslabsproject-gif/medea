/**
 * Importazione ed esportazione del workflow in JSON.
 *
 * È il formato con cui un workflow passa da Medea a FlowForge e viceversa,
 * quindi in uscita si scrive esattamente lo schema condiviso — niente campi
 * nostri, niente identificativi locali — e in entrata si accetta quello che
 * arriva dal server senza pretendere che sia stato prodotto qui.
 */

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

/** Il documento nella forma condivisa: senza id locale e senza posizioni
 *  inutili, ma con tutto ciò che serve a rieseguirlo altrove. */
export function toExportJson(workflow: Workflow): string {
  return JSON.stringify(
    {
      name: workflow.name,
      ...(workflow.description ? { description: workflow.description } : {}),
      nodes: workflow.nodes,
      edges: workflow.edges,
      executionTarget: workflow.executionTarget ?? 'local',
    },
    null,
    2,
  );
}

export class WorkflowImportError extends Error {}

function readNodes(value: unknown): CanvasNode[] {
  if (!Array.isArray(value)) throw new WorkflowImportError('Manca l’elenco dei nodi.');
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new WorkflowImportError(`Il nodo numero ${String(i + 1)} non è leggibile.`);
    }
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== 'string' || typeof n.defId !== 'string') {
      throw new WorkflowImportError(`Il nodo numero ${String(i + 1)} non ha id o defId.`);
    }
    return {
      id: n.id,
      defId: n.defId,
      x: typeof n.x === 'number' ? n.x : 0,
      y: typeof n.y === 'number' ? n.y : 0,
      config:
        typeof n.config === 'object' && n.config !== null
          ? (n.config as Record<string, unknown>)
          : {},
      ...(typeof n.label === 'string' ? { label: n.label } : {}),
      // Il server chiama `name` quello che qui è `label`: si accettano
      // entrambi, altrimenti un workflow importato perde i nomi.
      ...(typeof n.name === 'string' && typeof n.label !== 'string' ? { label: n.name } : {}),
    };
  });
}

function readEdges(value: unknown): WorkflowEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const e = raw as Record<string, unknown>;
    const from = typeof e.from === 'string' ? e.from : typeof e.source === 'string' ? e.source : '';
    const to = typeof e.to === 'string' ? e.to : typeof e.target === 'string' ? e.target : '';
    if (!from || !to) return [];
    const port = typeof e.fromPort === 'string' ? e.fromPort : undefined;
    return [{ from, to, ...(port ? { fromPort: port } : {}) }];
  });
}

/** Legge un workflow da JSON. Solleva un errore leggibile invece di
 *  restituire un documento monco: un import a metà è peggio di un rifiuto. */
export function fromImportJson(raw: string): Workflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkflowImportError('Il file non contiene JSON valido.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowImportError('Il file non contiene un workflow.');
  }
  const doc = parsed as Record<string, unknown>;
  const nodes = readNodes(doc.nodes);
  const target = doc.executionTarget === 'server' ? 'server' : 'local';

  return {
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name : 'Workflow importato',
    ...(typeof doc.description === 'string' ? { description: doc.description } : {}),
    nodes,
    edges: readEdges(doc.edges),
    executionTarget: target,
  };
}

/** Il nome del file proposto al salvataggio. */
export function exportFileName(workflow: Workflow): string {
  const slug =
    workflow.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'workflow';
  return `${slug}.json`;
}
