/**
 * Data-flow validator — il salto da "i nodi sono validi" a "i dati FLUISCONO davvero".
 *
 * Lo smoke test valida struttura + campi del singolo nodo. Questo valida i
 * RIFERIMENTI tra nodi: un `{{$node.X.json...}}` che punta a un nodo non-a-monte
 * (i suoi dati non esistono ancora) o a un campo che X non produce.
 *
 * v1 — conservativo (warning, non hard-reject: è euristico, niente falsi-rossi
 * bloccanti). Due controlli, entrambi senza output-schema completo:
 *
 *  1) REACHABILITY: `$node.X.json` deve riferire un nodo X PREDECESSORE
 *     raggiungibile (BFS sugli edge). Becca "referenzi un nodo che gira dopo /
 *     scollegato" — l'errore data-flow più comune dell'LLM.
 *
 *  2) CATENA json_extract: action_json_extract produce il VALORE estratto (scalare
 *     se 1 match — vedi node def). Se un json_extract Y estrae un campo nested
 *     (`path: $.foo`) dall'OUTPUT di un altro json_extract X, `.foo` risolve solo
 *     se quel valore è un oggetto con quel campo → sospetto. Becca il caso reale
 *     "estrai .email → poi estrai .domain dal risultato" (IMAP CRM 2026-06-11).
 *
 * PURO → testabile in isolamento.
 */

export interface DataflowIssue {
  nodeId: string;
  status: 'warn' | 'fail';
  reason: string;
}

export interface DfNode {
  id: string;
  defId: string;
  config: Record<string, unknown>;
}
export interface DfEdge {
  from: string;
  to: string;
}

// Riferimenti: `$node.X.json…`, `node.X.json…`, dentro `{{ }}` o nudi.
const NODE_REF_RE = /\$?node\.([a-zA-Z0-9_-]+)\.json\b/gu;

/** Predecessori raggiungibili (BFS all'indietro) per ogni nodo. */
function buildReachablePreds(
  nodes: readonly DfNode[],
  edges: readonly DfEdge[],
): Map<string, Set<string>> {
  const directPreds = new Map<string, string[]>();
  for (const n of nodes) directPreds.set(n.id, []);
  for (const e of edges) directPreds.get(e.to)?.push(e.from);
  const cache = new Map<string, Set<string>>();
  const compute = (id: string, seen: Set<string>): Set<string> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const acc = new Set<string>();
    for (const p of directPreds.get(id) ?? []) {
      if (acc.has(p) || seen.has(p)) continue;
      acc.add(p);
      seen.add(p);
      for (const up of compute(p, seen)) acc.add(up);
    }
    cache.set(id, acc);
    return acc;
  };
  for (const n of nodes) compute(n.id, new Set([n.id]));
  return cache;
}

/** Estrae gli id-nodo referenziati in una stringa di config. */
function refsIn(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const ids: string[] = [];
  for (const m of value.matchAll(NODE_REF_RE)) ids.push(m[1]!);
  return ids;
}

/**
 * AUTO-HEAL della reachability (l'AUTOMAZIONE, non solo detection): se un nodo Y
 * referenzia `$node.X.json` ma X NON è a monte, COLLEGA X → Y (aggiunge l'edge)
 * così il dato fluisce davvero — purché non crei un ciclo (Y non dev'essere
 * antenato di X). Deterministico + safe. Becca il bug db_insert→nodo-non-collegato.
 *
 * NON tocca i WARN semantici (email→dominio): quelli non sono deterministicamente
 * riparabili (servirebbe conoscere la shape del dato) → restano segnalati.
 *
 * Ritorna gli edge da AGGIUNGERE (il chiamante li applica).
 */
export function healDataflowReachability(
  nodes: readonly DfNode[],
  edges: readonly DfEdge[],
): DfEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = buildReachablePreds(nodes, edges);
  const toAdd: DfEdge[] = [];
  const added = new Set<string>();
  for (const node of nodes) {
    const reach = preds.get(node.id) ?? new Set<string>();
    const seen = new Set<string>();
    for (const value of Object.values(node.config)) {
      for (const refId of refsIn(value)) {
        if (refId === node.id || seen.has(refId)) continue;
        seen.add(refId);
        if (!byId.has(refId) || reach.has(refId)) continue; // inesistente o già a monte
        // Cycle-safe: salta se node è antenato di refId (refId→…→node) — l'edge
        // refId→node chiuderebbe un ciclo.
        if ((preds.get(refId) ?? new Set()).has(node.id)) continue;
        const key = `${refId}->${node.id}`;
        if (added.has(key)) continue;
        added.add(key);
        toAdd.push({ from: refId, to: node.id });
      }
    }
  }
  return toAdd;
}

export function validateDataflow(
  nodes: readonly DfNode[],
  edges: readonly DfEdge[],
): DataflowIssue[] {
  const issues: DataflowIssue[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = buildReachablePreds(nodes, edges);

  for (const node of nodes) {
    const reach = preds.get(node.id) ?? new Set<string>();
    const seenRef = new Set<string>();
    for (const value of Object.values(node.config)) {
      for (const refId of refsIn(value)) {
        if (refId === node.id) continue;
        const key = `${refId}`;
        if (seenRef.has(key)) continue;
        seenRef.add(key);
        if (!byId.has(refId)) continue; // nodo inesistente → già beccato altrove
        // 1) REACHABILITY
        if (!reach.has(refId)) {
          issues.push({
            nodeId: node.id,
            status: 'fail',
            reason: `Riferisce \`$node.${refId}\` che NON è a monte (non raggiungibile via edge): i suoi dati non sono disponibili quando questo nodo gira. Collega ${refId} prima di ${node.id}.`,
          });
        }
      }
    }

    // 2) CATENA json_extract: Y(json_extract) che estrae un campo nested
    //    dall'output di X(json_extract) → sospetto (X produce un valore, non un oggetto).
    if (node.defId === 'action_json_extract') {
      const src =
        typeof node.config.sourceExpression === 'string' ? node.config.sourceExpression : '';
      const path = typeof node.config.path === 'string' ? node.config.path : '';
      // src = `$node.X.json` (output INTERO di X, senza sub-path) → match esatto.
      // Strip del wrapper `{{ }}` (es. `{{$node.sender.json}}`) — senza, la catena
      // sfuggiva (bug fresh-gen IMAP CRM: domain estrae $.address da sender wrappato).
      const srcInner = src
        .trim()
        .replace(/^\{\{\s*/u, '')
        .replace(/\s*\}\}$/u, '')
        .trim();
      const m = /^\$?node\.([a-zA-Z0-9_-]+)\.json$/u.exec(srcInner);
      const x = m ? byId.get(m[1]!) : undefined;
      const accessesNestedField = /^\$\.[a-zA-Z_]/u.test(path.trim()); // es. $.domain
      if (x?.defId === 'action_json_extract' && accessesNestedField) {
        issues.push({
          nodeId: node.id,
          status: 'warn',
          reason: `Estrae \`${path}\` dall'output di \`${x.id}\` (action_json_extract), che produce il VALORE estratto (spesso scalare). \`${path}\` risolve solo se quel valore è un oggetto con quel campo — verifica la catena (es. estrai un oggetto, non un singolo campo, a monte).`,
        });
      }
    }
  }
  return issues;
}
