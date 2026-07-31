/**
 * Regole sulla topologia: chi parte, chi arriva, chi resta appeso.
 *
 * Sono i problemi che si vedono guardando il disegno del flusso, senza
 * bisogno di sapere cosa fa ciascun nodo.
 */

import { asSearchable, buildAncestors, outDegree } from './graph';
import type { QualityGateInput, QualityIssue } from './types';

/** I riferimenti `{{$node.X.json…}}` contenuti in un valore. */
function extractNodeRefs(value: string): string[] {
  const matches = value.matchAll(/\{\{\s*\$node\.([A-Za-z0-9_-]+)\.json[^}]*\}\}/g);
  const refs = new Set<string>();
  for (const m of matches) {
    if (m[1]) refs.add(m[1]);
  }
  return Array.from(refs);
}

/**
 * Un nodo legge l'output di un altro che, a quel punto, non è ancora stato
 * eseguito. È il tipo di errore che nessuno vede leggendo il JSON e che a
 * runtime produce un campo vuoto senza dire niente.
 */
export function checkCircularReferences(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const nodeIds = new Set(input.nodes.map((n) => n.id));
  for (const node of input.nodes) {
    const ancestors = buildAncestors(node.id, input.edges);
    for (const [field, val] of Object.entries(node.config)) {
      for (const refId of extractNodeRefs(asSearchable(val))) {
        if (!nodeIds.has(refId)) {
          issues.push({
            severity: 'critical',
            code: 'CIRCULAR_REFERENCE',
            nodeId: node.id,
            field,
            message: `Il campo "${field}" fa riferimento a $node.${refId}, ma il nodo "${refId}" non esiste nel workflow.`,
          });
          continue;
        }
        if (refId === node.id) {
          issues.push({
            severity: 'critical',
            code: 'CIRCULAR_REFERENCE',
            nodeId: node.id,
            field,
            message: `Il campo "${field}" fa riferimento a se stesso ($node.${refId}): impossibile.`,
          });
          continue;
        }
        if (!ancestors.has(refId)) {
          issues.push({
            severity: 'critical',
            code: 'CIRCULAR_REFERENCE',
            nodeId: node.id,
            field,
            message: `Il campo "${field}" legge $node.${refId}.json, ma "${refId}" non viene prima di "${node.id}" nel flusso: quando "${node.id}" parte, "${refId}" non è ancora stato eseguito e il riferimento resta vuoto.`,
          });
        }
      }
    }
  }
  return issues;
}

/** Un trigger che non porta da nessuna parte: il workflow non farà mai nulla. */
export function checkOrphanTriggers(input: QualityGateInput): QualityIssue[] {
  const out = outDegree(input.edges);
  return input.nodes
    .filter((n) => n.defId.startsWith('trigger_') && (out.get(n.id) ?? 0) === 0)
    .map((n) => ({
      severity: 'critical' as const,
      code: 'ORPHAN_TRIGGER' as const,
      nodeId: n.id,
      message: `Il trigger "${n.id}" (${n.defId}) non è collegato a nulla: il workflow non eseguirà mai niente.`,
    }));
}

/** I nodi che è normale trovare in fondo a un ramo. */
const KNOWN_SINKS: ReadonlySet<string> = new Set([
  'action_send_email',
  'action_http',
  'db_insert',
  'db_update',
  'db_delete',
  'community_slack',
  'community_telegram',
  'community_discord',
  'community_notion',
  'community_hubspot',
  'community_salesforce',
  'community_linear',
  'community_github',
  'community_stripe',
]);

/** Un ramo che finisce nel vuoto: i dati arrivano lì e spariscono. */
export function checkDeadEnd(input: QualityGateInput): QualityIssue[] {
  const out = outDegree(input.edges);
  return input.nodes
    .filter(
      (n) =>
        (out.get(n.id) ?? 0) === 0 && !KNOWN_SINKS.has(n.defId) && !n.defId.startsWith('trigger_'),
    )
    .map((n) => ({
      severity: 'medium' as const,
      code: 'DEAD_END_BRANCH' as const,
      nodeId: n.id,
      message: `Il nodo "${n.id}" (${n.defId}) non ha collegamenti in uscita e non è un punto d'arrivo tipico: il flusso finisce qui in silenzio. Controlla se manca un collegamento.`,
    }));
}

/**
 * Nodi identici ripetuti. Capita quando il modello copia lo stesso blocco in
 * ogni ramo invece di metterne uno solo a valle.
 */
export function checkDuplicateNodes(input: QualityGateInput): QualityIssue[] {
  const groups = new Map<string, { ids: string[]; defId: string }>();
  for (const node of input.nodes) {
    const configHash = JSON.stringify(node.config, Object.keys(node.config).sort());
    const key = `${node.defId}|${configHash}`;
    const entry = groups.get(key);
    if (entry) entry.ids.push(node.id);
    else groups.set(key, { ids: [node.id], defId: node.defId });
  }
  const issues: QualityIssue[] = [];
  for (const { ids, defId } of groups.values()) {
    if (ids.length <= 1) continue;
    issues.push({
      severity: 'medium',
      code: 'DUPLICATE_NODES',
      nodeId: ids[0] ?? '?',
      message: `${ids.length} nodi "${defId}" hanno configurazione identica: ${ids.join(', ')}. Conviene tenerne uno solo a valle, dopo il punto in cui i rami si ricongiungono.`,
    });
  }
  return issues;
}
