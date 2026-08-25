/**
 * Regole sui riferimenti al database.
 *
 * Il modello sa scrivere `INSERT INTO clienti (nome, email)` benissimo; quello
 * che non può sapere è se la tabella `clienti` esiste davvero e se si chiama
 * così anche la colonna. Questi controlli girano solo quando il catalogo dei
 * database è disponibile: senza, tacciono invece di indovinare.
 */

import { PICKER_PLACEHOLDER } from '../constants';

import { asStr, safeParseJson } from './graph';
import type { QualityGateInput, QualityIssue } from './types';

const DB_NODES_WITH_TABLE: ReadonlySet<string> = new Set([
  'db_query',
  'db_insert',
  'db_insert_batch',
  'db_update',
  'db_delete',
]);

/** Un valore da configurare dopo (menu a tendina o espressione) non è un
 *  errore: si salta. */
function isDeferred(value: string): boolean {
  return value === PICKER_PLACEHOLDER || value.includes('{{');
}

export function checkDbTableNotInSchema(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!input.databases || input.databases.length === 0) return issues;

  const tablesByDb = new Map<string, ReadonlySet<string>>();
  for (const db of input.databases) tablesByDb.set(db.id, new Set(db.tables));

  for (const node of input.nodes) {
    if (!DB_NODES_WITH_TABLE.has(node.defId)) continue;
    const dbId = asStr(node.config.databaseId);
    const table = asStr(node.config.table);
    if (!dbId || !table || isDeferred(dbId) || isDeferred(table)) continue;

    const knownTables = tablesByDb.get(dbId);
    if (!knownTables || knownTables.has(table)) continue;

    const available =
      Array.from(knownTables)
        .map((t) => `"${t}"`)
        .join(', ') || '(nessuna)';
    issues.push({
      severity: 'critical',
      code: 'DB_TABLE_NOT_IN_SCHEMA',
      nodeId: node.id,
      field: 'table',
      message: `Il nodo "${node.id}" (${node.defId}) usa la tabella "${table}" del database "${dbId}", che non esiste. Tabelle disponibili: ${available}. Scegline una esistente oppure creala prima.`,
    });
  }
  return issues;
}

/** Per ogni tipo di nodo: dove sta il nome della tabella e in quali campi
 *  compaiono i nomi delle colonne. */
const DB_COLUMN_FIELDS: Readonly<
  Record<string, { tableField: string; columnFields: readonly string[] }>
> = {
  db_insert: { tableField: 'table', columnFields: ['rowJson'] },
  db_update: { tableField: 'table', columnFields: ['whereJson', 'patchJson'] },
  db_delete: { tableField: 'table', columnFields: ['whereJson'] },
};

/**
 * I nomi di colonna citati in un campo chiave-valore. Restituisce `null`
 * quando il valore non è un oggetto leggibile: meglio non dire nulla che
 * inventare un errore.
 */
function extractColumnKeys(raw: unknown): string[] | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    obj = safeParseJson(trimmed);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return Object.keys(obj as Record<string, unknown>).filter(
    (k) => k.length > 0 && !k.includes('{{'),
  );
}

export function checkDbColumnNotInSchema(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!input.databases || input.databases.length === 0) return issues;

  const columnsByDbTable = new Map<string, ReadonlySet<string>>();
  for (const db of input.databases) {
    if (!db.columns) continue;
    for (const [table, cols] of Object.entries(db.columns)) {
      columnsByDbTable.set(`${db.id}::${table}`, new Set(cols));
    }
  }
  if (columnsByDbTable.size === 0) return issues;

  for (const node of input.nodes) {
    const spec = DB_COLUMN_FIELDS[node.defId];
    if (!spec) continue;
    const dbId = asStr(node.config.databaseId);
    const table = asStr(node.config[spec.tableField]);
    if (!dbId || !table || isDeferred(dbId) || isDeferred(table)) continue;

    const cols = columnsByDbTable.get(`${dbId}::${table}`);
    if (!cols || cols.size === 0) continue;

    for (const field of spec.columnFields) {
      const keys = extractColumnKeys(node.config[field]);
      if (!keys || keys.length === 0) continue;
      const missing = keys.filter((k) => !cols.has(k));
      if (missing.length === 0) continue;
      issues.push({
        severity: 'critical',
        code: 'DB_COLUMN_NOT_IN_SCHEMA',
        nodeId: node.id,
        field,
        message: `Il nodo "${node.id}" (${node.defId}), nel campo "${field}", usa le colonne ${missing.map((c) => `"${c}"`).join(', ')} che nella tabella "${table}" non esistono. Colonne disponibili: ${Array.from(
          cols,
        )
          .map((c) => `"${c}"`)
          .join(', ')}.`,
      });
    }
  }
  return issues;
}
