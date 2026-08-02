/**
 * relation-introspect — helper CONDIVISO per costruire `Relation` (FK) dalle righe
 * introspettate dai vari adapter SQL. La query è dialect-specific (postgres usa
 * information_schema, mysql idem, mssql usa sys.*, sqlite usa PRAGMA), ma la
 * NORMALIZZAZIONE in `Relation` è identica → vive qui, non duplicata su 5 adapter.
 *
 * @module relation-introspect
 */
import type { Relation, RelationOnDelete } from './index.js';

/** Normalizza la stringa onDelete del dialetto (CASCADE / SET NULL / SET_NULL /
 *  NO ACTION / NO_ACTION …) nell'enum del core. Underscore → spazio (MSSQL usa
 *  SET_NULL, NO_ACTION nei *_desc). Sconosciuto → 'no action' (default SQL). */
export function mapOnDeleteAction(raw: string | null | undefined): RelationOnDelete {
  switch ((raw ?? '').toUpperCase().trim().replace(/_/gu, ' ')) {
    case 'CASCADE':
      return 'cascade';
    case 'RESTRICT':
      return 'restrict';
    case 'SET NULL':
      return 'set null';
    case 'SET DEFAULT':
      return 'set default';
    case 'NO ACTION':
      return 'no action';
    default:
      return 'no action';
  }
}

/** Riga FK normalizzata che ogni adapter produce dalla propria query dialect. */
export interface ForeignKeyRow {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete?: string | null;
  /** Disambigua FK multiple sulla stessa coppia di tabelle (default 0). */
  ordinal?: number;
}

/** Costruisce una `Relation` (id/name deterministici, kind one-to-many, onDelete
 *  mappato). Stesso schema id di SqliteAdapter per coerenza cross-engine. */
export function fkRowToRelation(row: ForeignKeyRow): Relation {
  return {
    id: `${row.fromTable}.${row.fromColumn}->${row.toTable}.${row.toColumn}#${(row.ordinal ?? 0).toString()}`,
    name: `fk_${row.fromTable}_${row.fromColumn}`,
    kind: 'one-to-many',
    fromTable: row.fromTable,
    fromColumn: row.fromColumn,
    toTable: row.toTable,
    toColumn: row.toColumn,
    onDelete: mapOnDeleteAction(row.onDelete),
  };
}

/** Mappa una lista di righe FK in Relation[], assegnando ordinal incrementale
 *  per disambiguare FK con stessa from/to (es. due FK verso la stessa tabella). */
export function fkRowsToRelations(rows: readonly ForeignKeyRow[]): Relation[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`;
    const ordinal = r.ordinal ?? seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return fkRowToRelation({ ...r, ordinal });
  });
}
