/**
 * Cosa può referenziare un nodo.
 *
 * Solo i nodi **a monte**: quelli a valle, quando questo passo gira, non sono
 * ancora stati eseguiti, e il quality gate boccia chi ci prova. Suggerire
 * un'espressione che verrà segnalata come errore sarebbe peggio che non
 * suggerire niente.
 *
 * ───── Dov'è finito il risultato ─────
 *
 * `$node.<id>.json` **non** è quello che il nodo ha restituito: è la busta in
 * cui il motore lo mette, `{ result, durationMs }`. Il valore vero sta sotto
 * `result`.
 *
 * Verificato eseguendo, non leggendo: un nodo che restituisce `{ campo: 42 }`
 * risolve `{{$node.x.json.result.campo}}` in `42`, e
 * `{{$node.x.json.campo}}` nella stringa vuota. Suggerire il secondo — come si
 * faceva — significa consegnare espressioni che non danno errore e non danno
 * nemmeno il valore: il tipo di guasto che si cerca per un'ora.
 *
 * I **trigger** sono l'eccezione: quello che producono non passa da un
 * esecutore, quindi non ha la busta. Un webhook mette `{ method, headers,
 * body, query }` direttamente.
 */

import { buildAncestors } from '../quality/graph';
import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import type { ExpressionSource } from './ExpressionPicker';

/**
 * Il prefisso giusto per leggere i campi di un nodo.
 *
 * Gli esecutori incartano il risultato, i trigger no.
 */
export function outputPrefix(nodeId: string, def: NodeDef | undefined): string {
  return def?.type === 'trigger' ? `$node.${nodeId}.json` : `$node.${nodeId}.json.result`;
}

/**
 * Le chiavi che un nodo ha prodotto davvero nell'ultima esecuzione.
 *
 * Sono migliori di quelle dichiarate dal catalogo perché sono quelle vere:
 * un `action_http` dichiara `body`, ma cosa c'è *dentro* `body` lo si sa solo
 * dopo averlo chiamato.
 */
export function keysFromOutput(output: unknown): string[] {
  if (!output || typeof output !== 'object') return [];
  const record = output as Record<string, unknown>;
  // La busta del motore: le chiavi utili stanno sotto `result`.
  const dentro = 'result' in record ? record.result : record;
  if (!dentro || typeof dentro !== 'object' || Array.isArray(dentro)) return [];
  return Object.keys(dentro);
}

export function upstreamSources(
  nodeId: string,
  nodes: readonly CanvasNode[],
  edges: readonly WorkflowEdge[],
  defsById: ReadonlyMap<string, NodeDef>,
  /** Cosa ha prodotto ogni nodo nell'ultima esecuzione, se ce n'è stata una. */
  lastOutputs?: ReadonlyMap<string, unknown>,
): ExpressionSource[] {
  const ancestors = buildAncestors(nodeId, edges);

  return nodes
    .filter((n) => ancestors.has(n.id))
    .flatMap((n) => {
      const def = defsById.get(n.defId);
      const label = n.label ?? def?.label ?? n.id;
      const prefix = outputPrefix(n.id, def);

      // Il nodo intero: serve a chi vuole passare tutto, o a chi sa già
      // dove mettere le mani.
      const sources: ExpressionSource[] = [
        { expression: prefix, label, hint: `output di «${label}»` },
      ];

      // I campi veri dell'ultima esecuzione battono quelli dichiarati: un
      // `action_http` dichiara `body`, ma cosa c'è dentro si sa solo dopo
      // averlo chiamato.
      const reali = keysFromOutput(lastOutputs?.get(n.id));
      const dichiarati = def?.outputContract?.fields.map((f) => f.name) ?? def?.outputFields ?? [];
      const campi = reali.length > 0 ? reali : dichiarati;

      for (const campo of campi) {
        sources.push({
          expression: `${prefix}.${campo}`,
          label: `${label} · ${campo}`,
          hint: reali.length > 0 ? 'dall’ultima esecuzione' : 'dichiarato dal nodo',
        });
      }

      return sources;
    });
}
