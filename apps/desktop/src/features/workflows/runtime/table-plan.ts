/**
 * Quali tabelle servono a questo workflow, lette dal workflow stesso.
 *
 * Un nodo `db_insert` dichiara la tabella su cui scrive e, nella mappa dei
 * valori, esattamente i nomi delle colonne. Finora nessuno guardava: il
 * workflow si salvava, si attivava, e falliva alla prima esecuzione con un
 * «no such table» che non dice niente a chi l'ha disegnato.
 *
 * Qui si ricava il piano. Crearle è un altro modulo — questo è puro, e si può
 * provare senza un database sotto.
 */

import type { CanvasNode, Workflow } from '../types';

/** I tipi che sappiamo dichiarare. Sono quelli che DB Studio accetta. */
export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'datetime' | 'json';

export interface PlannedColumn {
  name: string;
  type: ColumnType;
}

export interface PlannedTable {
  name: string;
  columns: PlannedColumn[];
}

/** I nodi che parlano di tabelle, e in quali campi tengono le colonne. */
const COLUMN_SOURCES: Record<string, readonly string[]> = {
  db_insert: ['rowJson'],
  db_update: ['whereJson', 'patchJson'],
  db_delete: ['whereJson'],
  db_query: ['filtersJson'],
  trigger_db_change: [],
};

/** Un identificatore che può finire in una DDL senza virgolette e sorprese. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function readString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Il tipo di una colonna, dedotto dal valore che il nodo ci scrive.
 *
 * Un'espressione (`{{ ... }}`) non dice niente sul tipo: si sceglie testo,
 * che è il tipo che accetta tutto. Meglio una colonna larga che una colonna
 * sbagliata — allargare un tipo dopo costa una migrazione.
 */
function inferType(value: unknown): ColumnType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
  if (value && typeof value === 'object') return 'json';
  return 'text';
}

/** Le colonne nominate da un campo che è una mappa nome → valore. */
function columnsFromMap(raw: unknown): PlannedColumn[] {
  let map: unknown = raw;
  if (typeof raw === 'string') {
    try {
      map = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];

  const out: PlannedColumn[] = [];
  for (const [name, value] of Object.entries(map)) {
    const clean = name.trim().toLowerCase();
    if (!IDENTIFIER.test(clean)) continue;
    out.push({ name: clean, type: inferType(value) });
  }
  return out;
}

/** Le colonne che un nodo nomina, qualunque campo le contenga. */
function columnsOfNode(node: CanvasNode): PlannedColumn[] {
  const fields = COLUMN_SOURCES[node.defId] ?? [];
  return fields.flatMap((field) => columnsFromMap(node.config[field]));
}

/**
 * Le tabelle che questo workflow dà per esistenti, con le colonne che nomina.
 *
 * Ogni tabella riceve una `id` di testo come chiave: senza chiave una riga
 * non si aggiorna e non si cancella, e i nodi `db_update`/`db_delete`
 * diventano inutilizzabili sulla tabella che hanno appena creato.
 */
export function planTables(workflow: Pick<Workflow, 'nodes'>): PlannedTable[] {
  const byTable = new Map<string, Map<string, ColumnType>>();

  for (const node of workflow.nodes) {
    if (!(node.defId in COLUMN_SOURCES)) continue;
    const table = readString(node.config, 'table')?.trim().toLowerCase();
    if (!table || !IDENTIFIER.test(table)) continue;

    const columns = byTable.get(table) ?? new Map<string, ColumnType>([['id', 'text']]);
    for (const column of columnsOfNode(node)) {
      // Il primo che nomina una colonna decide il tipo: i giri successivi
      // aggiungono, non riscrivono. Un `where` con un numero non deve
      // trasformare in intero una colonna già dichiarata testo.
      if (!columns.has(column.name)) columns.set(column.name, column.type);
    }
    byTable.set(table, columns);
  }

  return [...byTable]
    .map(([name, columns]) => ({
      name,
      columns: [...columns].map(([columnName, type]) => ({ name: columnName, type })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Quelle che non ci sono ancora. */
export function missingTables(
  planned: readonly PlannedTable[],
  existing: readonly string[],
): PlannedTable[] {
  const known = new Set(existing.map((n) => n.toLowerCase()));
  return planned.filter((t) => !known.has(t.name));
}
