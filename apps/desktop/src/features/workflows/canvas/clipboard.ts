/**
 * Copiare e incollare i nodi.
 *
 * Copiare un nodo significa portarsi dietro la sua configurazione, che è la
 * parte che costa tempo: un `action_http` con l'URL, le intestazioni e il
 * corpo già scritti si riusa, un `action_http` vuoto si rifà.
 *
 * Gli id vengono rigenerati — due nodi non possono chiamarsi allo stesso modo
 * — e i collegamenti interni alla selezione si ricostruiscono sui nuovi id,
 * così incollando due nodi collegati restano collegati.
 */

import type { CanvasNode, Workflow, WorkflowEdge } from '../types';

import { uniqueNodeId } from './graph-ops';

/** Di quanto si sposta ciò che si incolla, per non finire sopra l'originale. */
const PASTE_OFFSET = 40;

export interface Clipboard {
  nodes: CanvasNode[];
  edges: WorkflowEdge[];
}

/** Prende i nodi indicati e i collegamenti che stanno **fra** di loro. */
export function copySelection(wf: Workflow, ids: readonly string[]): Clipboard | null {
  const selected = new Set(ids);
  const nodes = wf.nodes.filter((n) => selected.has(n.id));
  if (nodes.length === 0) return null;
  return {
    nodes: nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: wf.edges
      .filter((e) => selected.has(e.from) && selected.has(e.to))
      .map((e) => ({ ...e })),
  };
}

export interface PasteResult {
  workflow: Workflow;
  /** Gli id dei nodi appena creati: servono a selezionarli. */
  newIds: string[];
}

export function paste(wf: Workflow, clip: Clipboard): PasteResult {
  const rename = new Map<string, string>();
  let nodes = [...wf.nodes];

  for (const source of clip.nodes) {
    // L'id si genera contro i nodi già presenti E quelli appena incollati,
    // altrimenti due copie dello stesso nodo collidono fra loro.
    const id = uniqueNodeId(source.defId, nodes);
    rename.set(source.id, id);
    nodes = [
      ...nodes,
      {
        ...source,
        id,
        x: source.x + PASTE_OFFSET,
        y: source.y + PASTE_OFFSET,
        config: { ...source.config },
      },
    ];
  }

  const edges = [
    ...wf.edges,
    ...clip.edges.flatMap((e) => {
      const from = rename.get(e.from);
      const to = rename.get(e.to);
      return from && to ? [{ ...e, from, to }] : [];
    }),
  ];

  return { workflow: { ...wf, nodes, edges }, newIds: [...rename.values()] };
}

/** Duplicare è copiare e incollare in un colpo solo. */
export function duplicateNodes(wf: Workflow, ids: readonly string[]): PasteResult | null {
  const clip = copySelection(wf, ids);
  return clip ? paste(wf, clip) : null;
}
