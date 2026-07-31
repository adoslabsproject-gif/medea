/**
 * Cosa non va nel workflow, nodo per nodo.
 *
 * È lo stesso giudizio che riceve il modello quando genera — le stesse
 * regole, gli stessi messaggi — mostrato mentre l'utente disegna. Sarebbe
 * assurdo che l'AI non possa consegnare un workflow che l'editor accetta in
 * silenzio: il criterio deve essere uno solo.
 */

import { gateWorkflow, type QualityIssue } from '../quality';
import { isPickerField } from '../scaffold';
import type { CanvasNode, NodeDef, Workflow, WorkflowEdge } from '../types';

export interface Diagnostics {
  /** Per ogni nodo: quanti campi obbligatori restano da compilare. */
  missingByNode: Map<string, number>;
  /** Per ogni nodo: i problemi da mostrare nel pannello. */
  issuesByNode: Map<string, string[]>;
  /** Tutti i problemi, per il riepilogo in basso. */
  issues: QualityIssue[];
  /** Vero quando nulla impedisce di attivare il workflow. */
  ok: boolean;
}

/** I campi obbligatori ancora vuoti, esclusi quelli che si scelgono da un
 *  elenco: quelli l'utente li completerà, non sono una dimenticanza. */
export function missingRequired(node: CanvasNode, def: NodeDef | undefined): string[] {
  return (def?.configFields ?? [])
    .filter((f) => f.required && !isPickerField(f.type))
    .filter((f) => {
      const v = node.config[f.key];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.key);
}

export function diagnose(
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
  defsById: ReadonlyMap<string, NodeDef>,
): Diagnostics {
  const missingByNode = new Map<string, number>();
  const issuesByNode = new Map<string, string[]>();

  for (const node of nodes) {
    const missing = missingRequired(node, defsById.get(node.defId));
    missingByNode.set(node.id, missing.length);
    if (missing.length > 0) {
      issuesByNode.set(node.id, [`Campi obbligatori da compilare: ${missing.join(', ')}.`]);
    }
    if (!defsById.has(node.defId)) {
      const existing = issuesByNode.get(node.id) ?? [];
      issuesByNode.set(node.id, [
        ...existing,
        `Il nodo "${node.defId}" non è installato: il workflow non partirà.`,
      ]);
    }
  }

  const quality = gateWorkflow({ nodes: [...nodes], edges: [...edges] });
  for (const issue of quality.issues) {
    if (!issue.nodeId) continue;
    const existing = issuesByNode.get(issue.nodeId) ?? [];
    issuesByNode.set(issue.nodeId, [...existing, issue.message]);
  }

  const anyMissing = [...missingByNode.values()].some((n) => n > 0);
  return {
    missingByNode,
    issuesByNode,
    issues: quality.issues,
    ok: !quality.shouldReject && !anyMissing,
  };
}

/** I problemi che non appartengono a un nodo preciso (riguardano il flusso
 *  nel suo insieme). */
export function globalIssues(issues: readonly QualityIssue[]): QualityIssue[] {
  return issues.filter((i) => !i.nodeId);
}

/** Un workflow vuoto ma valido, per il pulsante «nuovo». */
export function emptyWorkflow(): Workflow {
  return { name: 'Nuovo workflow', nodes: [], edges: [], executionTarget: 'local' };
}
