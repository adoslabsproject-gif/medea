/**
 * Helper PURO per la cascade delete workflow → tabelle DEDICATE (2026-06-11).
 * Sicurezza anti-dataloss: si droppano SOLO le tabelle che questo workflow SCRIVE
 * (db_insert/update/delete) e che NESSUN altro workflow del tenant referenzia
 * (né in scrittura né in lettura). Una tabella condivisa NON viene mai toccata.
 */
export interface DbTableRef {
  databaseId: string;
  table: string;
}

/** defId che SCRIVONO una tabella → "possesso" della tabella. */
export const WRITE_DB_DEFIDS = ['db_insert', 'db_insert_batch', 'db_update', 'db_delete'] as const;
/** defId che USANO una tabella (read+write) → "in uso", non droppabile se altrui. */
export const ANY_DB_DEFIDS = [
  'db_insert',
  'db_insert_batch',
  'db_update',
  'db_delete',
  'db_query',
] as const;

/** Estrae i riferimenti (databaseId, table) dai nodi db con defId in `defIds`. */
export function extractDbTableRefs(nodes: unknown, defIds: readonly string[]): DbTableRef[] {
  if (!Array.isArray(nodes)) return [];
  const allow = new Set(defIds);
  const refs: DbTableRef[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const node = n as { defId?: unknown; config?: unknown };
    if (typeof node.defId !== 'string' || !allow.has(node.defId)) continue;
    if (!node.config || typeof node.config !== 'object') continue;
    const c = node.config as Record<string, unknown>;
    const databaseId = typeof c.databaseId === 'string' ? c.databaseId : '';
    const table = typeof c.table === 'string' ? c.table : '';
    if (!databaseId || !table || databaseId.includes('{{') || table.includes('{{')) continue;
    const key = `${databaseId}::${table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ databaseId, table });
  }
  return refs;
}

/**
 * Tabelle DEDICATE da droppare: quelle SCRITTE dal workflow target e usate da
 * NESSUN altro workflow. `otherWorkflowsNodes` = i nodi di tutti gli ALTRI workflow.
 */
export function dedicatedTablesToDrop(
  targetNodes: unknown,
  otherWorkflowsNodes: readonly unknown[],
): DbTableRef[] {
  const written = extractDbTableRefs(targetNodes, WRITE_DB_DEFIDS);
  if (written.length === 0) return [];
  const usedByOthers = new Set<string>();
  for (const nodes of otherWorkflowsNodes) {
    for (const r of extractDbTableRefs(nodes, ANY_DB_DEFIDS))
      usedByOthers.add(`${r.databaseId}::${r.table}`);
  }
  return written.filter((r) => !usedByOthers.has(`${r.databaseId}::${r.table}`));
}
