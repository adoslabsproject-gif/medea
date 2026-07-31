/**
 * Cosa può referenziare un nodo.
 *
 * Solo i nodi **a monte**: quelli a valle, quando questo passo gira, non sono
 * ancora stati eseguiti, e il quality gate boccia chi ci prova. Suggerire
 * un'espressione che verrà segnalata come errore sarebbe peggio che non
 * suggerire niente.
 */

import { buildAncestors } from '../quality/graph';
import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import type { ExpressionSource } from './ExpressionPicker';

export function upstreamSources(
  nodeId: string,
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
  defsById: ReadonlyMap<string, NodeDef>,
): ExpressionSource[] {
  const ancestors = buildAncestors(nodeId, edges);
  return nodes
    .filter((n) => ancestors.has(n.id))
    .map((n) => {
      const def = defsById.get(n.defId);
      const label = n.label ?? def?.label ?? n.id;
      return {
        expression: `$node.${n.id}.json`,
        label,
        hint: `output di «${label}»`,
      };
    });
}
