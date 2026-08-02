/**
 * AUTO-HEAL DB-table (2026-06-11) — l'AUTOMAZIONE che mancava: se un db_insert/
 * db_update scrive colonne che NON esistono nella tabella di destinazione (Liara
 * ha RICICLATO una tabella scollegata, es. `orders` per dati prezzo), il sistema
 * RIPARA invece di rifiutare:
 *   1. cerca una tabella ESISTENTE le cui colonne contengono quelle del nodo → ripunta;
 *   2. altrimenti CREA una tabella DEDICATA (nome derivato dal goal) con quelle colonne
 *      + tipi inferiti, e ci ripunta il nodo.
 * Becca il bug reale "Anti-fraud Price Monitoring" (nicola-cucurachi): db_insert su
 * `orders` invece di `price_monitoring`. PURO → testabile in isolamento.
 */

export interface DbHealNode {
  id: string;
  defId: string;
  config: Record<string, unknown>;
}
export interface DbHealDatabase {
  id: string;
  columns: Record<string, string[]>;
}
export interface HealColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
}
export interface HealTableSpec {
  databaseId?: string;
  name: string;
  description: string;
  columns: HealColumn[];
}
export interface DbHealResult {
  tablesToCreate: HealTableSpec[];
  notes: string[];
}

// db node → (campo tabella, campi che contengono le colonne)
const DB_TABLE_NODES: Record<string, { tableField: string; columnFields: string[] }> = {
  db_insert: { tableField: 'table', columnFields: ['rowJson'] },
  db_update: { tableField: 'table', columnFields: ['whereJson', 'patchJson'] },
};

/** Chiavi-colonna letterali da un campo key-value JSON (ignora espressioni {{...}}). */
function columnKeys(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj as Record<string, unknown>).filter(
    (k) => k.length > 0 && !k.includes('{{'),
  );
}

/** Inferenza tipo colonna dal nome (euristica deterministica). */
function inferType(col: string): HealColumn {
  const c = col.toLowerCase();
  if (c === 'id') return { name: col, type: 'uuid', primaryKey: true };
  if (/(^|_)(price|amount|total|median_price|cost|importo)($|_)/.test(c))
    return { name: col, type: 'decimal' };
  if (/(count|_id|hop|qty|quantita|number|num)$/.test(c) || /^(count|num)/.test(c))
    return { name: col, type: 'integer' };
  if (/(_at$|date|time|timestamp)/.test(c)) return { name: col, type: 'datetime' };
  if (/^(is_|has_)|(_flag$|detected$|enabled$|ok$|valid$)/.test(c))
    return { name: col, type: 'boolean' };
  if (/(json|payload|data|raw|meta)$/.test(c)) return { name: col, type: 'json' };
  return { name: col, type: 'varchar' };
}

/** Slug snake_case da un goal, max 40 char, prefisso lettera. */
function tableNameFromGoal(goal: string, fallback: string): string {
  const slug = goal
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  const name = /^[a-z]/.test(slug) ? slug : `wf_${slug}`;
  return name.length >= 2 ? name : fallback;
}

/**
 * Ripara i riferimenti tabella dei nodi db. MUTA i nodi (ripunta `table`).
 * Ritorna le tabelle da creare + le note. Conservativo: agisce SOLO quando le
 * colonne del nodo sono parseable e la tabella di destinazione esiste con colonne
 * NON-compatibili (mismatch) o non esiste affatto.
 */
export function healDbTableReferences(
  nodes: readonly DbHealNode[],
  databases: readonly DbHealDatabase[],
  goal: string,
): DbHealResult {
  const tablesToCreate: HealTableSpec[] = [];
  const notes: string[] = [];
  const createdNames = new Set<string>();

  for (const node of nodes) {
    const spec = DB_TABLE_NODES[node.defId];
    if (!spec) continue;
    const rawDbId = node.config.databaseId;
    const rawTable = node.config[spec.tableField];
    const dbId = typeof rawDbId === 'string' ? rawDbId : '';
    const table = typeof rawTable === 'string' ? rawTable : '';
    // Skip anche su table === '__USE_PICKER__' (heal pre-validation 2026-06-12:
    // un `table` REQUIRED omesso diventa marker picker — senza questo guard il
    // marker verrebbe trattato come nome tabella e CREATA una tabella
    // letteralmente chiamata "__USE_PICKER__").
    // Skip anche su table === '__USE_PICKER__' (heal pre-validation 2026-06-12:
    // un `table` REQUIRED omesso diventa marker picker — senza questo guard il
    // marker verrebbe trattato come nome tabella e CREATA una tabella
    // letteralmente chiamata "__USE_PICKER__").
    if (
      !dbId ||
      !table ||
      dbId.includes('{{') ||
      table.includes('{{') ||
      dbId === '__USE_PICKER__' ||
      table === '__USE_PICKER__'
    )
      continue;
    const db = databases.find((d) => d.id === dbId);
    if (!db) continue; // databaseId non risolto → lo gestisce resolveDatabaseId all'import

    // Colonne richieste dal nodo (unione dei campi).
    const required = new Set<string>();
    for (const f of spec.columnFields) for (const k of columnKeys(node.config[f])) required.add(k);
    if (required.size === 0) continue; // niente colonne letterali (tutto {{}}) → skip

    const targetCols = db.columns[table];
    const reqArr = [...required];
    const isSubset = (cols: string[] | undefined): boolean =>
      !!cols && reqArr.every((c) => cols.includes(c));

    if (isSubset(targetCols)) continue; // tabella corretta → OK

    // 1) Tabella ESISTENTE che contiene tutte le colonne richieste → ripunta.
    const match = Object.entries(db.columns).find(([t, cols]) => t !== table && isSubset(cols));
    if (match) {
      node.config[spec.tableField] = match[0];
      notes.push(
        `🔧 db node "${node.id}": ripuntato da tabella "${table}" → "${match[0]}" (colonne ${reqArr.join(', ')} corrispondono).`,
      );
      continue;
    }

    // 2) Nessun match → CREA una tabella dedicata coi tipi inferiti + ripunta.
    let newName: string;
    if (!targetCols) {
      // La tabella che Liara ha nominato NON esiste → creala col nome che ha scelto.
      newName = table;
    } else {
      // Tabella riciclata (esiste ma colonne sbagliate) → nome dedicato dal goal.
      newName = tableNameFromGoal(goal, `${node.id}_data`);
    }
    if (!createdNames.has(newName)) {
      createdNames.add(newName);
      const cols: HealColumn[] = reqArr.some((c) => c.toLowerCase() === 'id')
        ? []
        : [{ name: 'id', type: 'uuid', primaryKey: true }];
      for (const c of reqArr) cols.push(inferType(c));
      tablesToCreate.push({
        name: newName,
        description: `Tabella creata automaticamente per ${node.defId} (${goal.slice(0, 80)})`,
        columns: cols,
      });
    }
    if (newName !== table) {
      node.config[spec.tableField] = newName;
      notes.push(
        `🆕 db node "${node.id}": tabella "${table}" non adatta → creata + ripuntata a "${newName}" (colonne ${reqArr.join(', ')}).`,
      );
    } else {
      notes.push(
        `🆕 db node "${node.id}": tabella "${newName}" dichiarata in tablesToCreate (colonne ${reqArr.join(', ')}).`,
      );
    }
  }

  return { tablesToCreate, notes };
}
