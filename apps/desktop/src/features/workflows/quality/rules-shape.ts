/**
 * Regole sulla forma dei dati che scorrono fra i nodi.
 *
 * Qui non si guarda se il grafo è ben disegnato, ma se ciò che un nodo emette
 * ha senso per il nodo che lo riceve: una lista che arriva a chi si aspetta un
 * elemento, N ingressi che convergono su chi non sa unirli, un'aggregazione
 * finita dentro un ciclo e quindi ripetuta N volte.
 */

import { asStr, findDownstreamNodes, inDegree } from './graph';
import {
  isAggregator,
  isArrayProducer,
  isLoopBodyPassthrough,
  isScalarConsumer,
} from './node-shape';
import type { QualityEdge, QualityGateInput, QualityIssue, QualityNode } from './types';

/**
 * Risalendo da `toId`, si attraversa un nodo che itera prima di arrivare a
 * `fromId`? Se sì, il consumer riceve già un elemento per volta e il
 * collegamento è corretto.
 */
function pathHasLoopBetween(
  byId: ReadonlyMap<string, QualityNode>,
  incoming: ReadonlyMap<string, readonly string[]>,
  fromId: string,
  toId: string,
): boolean {
  const seen = new Set<string>();
  const stack: string[] = [toId];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    if (cur === fromId) continue;
    const node = byId.get(cur);
    if (node && cur !== toId && isLoopBodyPassthrough(node.defId)) return true;
    for (const parent of incoming.get(cur) ?? []) {
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return false;
}

function incomingMap(edges: readonly QualityEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const list = map.get(e.to) ?? [];
    list.push(e.from);
    map.set(e.to, list);
  }
  return map;
}

/** Una lista collegata a chi lavora su un elemento per volta, senza un ciclo
 *  in mezzo. */
export function checkArrayToScalarWithoutLoop(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const byId = new Map(input.nodes.map((n) => [n.id, n] as const));
  const incoming = incomingMap(input.edges);

  for (const edge of input.edges) {
    const fromNode = byId.get(edge.from);
    const toNode = byId.get(edge.to);
    if (!fromNode || !toNode) continue;
    if (!isArrayProducer(fromNode.defId) || !isScalarConsumer(toNode.defId)) continue;
    if (pathHasLoopBetween(byId, incoming, edge.from, edge.to)) continue;

    issues.push({
      severity: 'critical',
      code: 'ARRAY_TO_SCALAR_WITHOUT_LOOP',
      nodeId: edge.to,
      message: `Il collegamento "${edge.from}" (${fromNode.defId}) → "${edge.to}" (${toNode.defId}) porta una lista a un nodo che elabora un elemento per volta. Inserisci fra i due un nodo "logic_loop", così il secondo riceve gli elementi uno alla volta.`,
    });
  }
  return issues;
}

/** Più rami che convergono su un nodo che non sa unirli: vince l'ultimo
 *  arrivato, e non è detto quale sia. */
export function checkFanInWithoutMerge(input: QualityGateInput): QualityIssue[] {
  const counts = inDegree(input.edges);
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    const count = counts.get(node.id) ?? 0;
    if (count < 2 || isAggregator(node.defId)) continue;
    // I nodi che scelgono UN ramo tollerano più ingressi per costruzione.
    if (node.defId === 'logic_if' || node.defId === 'logic_switch' || node.defId === 'logic_join') {
      continue;
    }
    issues.push({
      severity: 'critical',
      code: 'FAN_IN_WITHOUT_MERGE',
      nodeId: node.id,
      message: `Il nodo "${node.id}" (${node.defId}) riceve ${count} collegamenti in entrata ma non sa unire più risultati: userà solo l'ultimo arrivato, in un ordine non prevedibile. Metti prima un nodo di unione ("flow_merge" o "action_aggregate"), oppure sostituiscilo con "agent_data_analyst"/"agent_summarizer".`,
    });
  }
  return issues;
}

const AGGREGATION_KEYWORDS_RE =
  /(report|riepilogo|riassunto|summary|aggregat|totale|consolidat|sintesi|recap|digest)/i;

/**
 * Un'aggregazione finita dentro il ciclo invece che dopo. L'utente voleva un
 * riepilogo; ne riceverebbe uno per ogni elemento — con il relativo costo in
 * chiamate al modello e in email inviate.
 */
export function checkAggregationInsideLoop(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const loop of input.nodes.filter((n) => n.defId === 'logic_loop')) {
    // Con strategy="batch" il ciclo gira una volta sola sull'intero elenco:
    // l'aggregazione a valle è esattamente ciò che serve.
    const strategy = asStr(loop.config.strategy) || 'naive';
    if (strategy === 'batch') continue;

    for (const dsId of findDownstreamNodes(loop.id, input.edges)) {
      const dsNode = input.nodes.find((n) => n.id === dsId);
      if (!dsNode) continue;
      const aggregates =
        dsNode.defId === 'agent_data_analyst' ||
        dsNode.defId === 'agent_summarizer' ||
        dsNode.defId === 'action_send_email';
      if (!aggregates || !AGGREGATION_KEYWORDS_RE.test(JSON.stringify(dsNode.config))) continue;

      issues.push({
        severity: 'critical',
        code: 'AGGREGATION_INSIDE_LOOP',
        nodeId: dsNode.id,
        message: `Il nodo "${dsNode.id}" (${dsNode.defId}) sta dentro il ciclo "${loop.id}" (strategy="${strategy}") e parla di riepilogo o report: verrebbe eseguito una volta per ogni elemento invece che una volta sola sul totale. Imposta il ciclo su strategy="batch" oppure sposta questo nodo dopo la fine del ciclo.`,
      });
    }
  }
  return issues;
}
