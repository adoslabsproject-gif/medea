/**
 * Generazione PURA di un dump SQL ripristinabile (CREATE TABLE + INSERT) per il
 * "Backup DB" del DB Studio. Nessun I/O → testabile in isolamento con tutti gli
 * edge di escaping (il punto critico: i literal SQL devono essere anti-injection).
 *
 * Owner 2026-06-16: "un backup deve essere un .sql, non un json di righe".
 * I tipi colonna arrivano dall'introspezione (ColumnType normalizzato dell'engine)
 * → DDL generico ma ampiamente compatibile (Postgres/SQLite/standard SQL).
 */

export type SqlRow = Record<string, unknown>;

export interface DumpColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface DumpTable {
  name: string;
  columns: DumpColumn[];
}

/** Quota un identificatore SQL con doppi apici standard (i `"` interni raddoppiati). */
export function sqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Mappa il ColumnType normalizzato dell'engine → tipo SQL portabile. */
const TYPE_MAP: Record<string, string> = {
  varchar: 'VARCHAR',
  text: 'TEXT',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  decimal: 'DECIMAL',
  real: 'REAL',
  boolean: 'BOOLEAN',
  date: 'DATE',
  time: 'TIME',
  datetime: 'TIMESTAMP',
  json: 'JSON',
  uuid: 'UUID',
};
export function sqlType(t: string): string {
  return TYPE_MAP[t.toLowerCase()] ?? 'TEXT';
}

/** `CREATE TABLE IF NOT EXISTS "name" ( ... );` dalle colonne introspezionate. */
export function createTableStatement(table: string, columns: readonly DumpColumn[]): string {
  if (columns.length === 0) {
    // Tabella senza colonne note (introspezione povera): placeholder valido.
    return `CREATE TABLE IF NOT EXISTS ${sqlIdent(table)} ();`;
  }
  const defs = columns.map((c) => {
    let def = `  ${sqlIdent(c.name)} ${sqlType(c.type)}`;
    if (c.primaryKey) def += ' PRIMARY KEY';
    else if (c.nullable === false) def += ' NOT NULL';
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS ${sqlIdent(table)} (\n${defs.join(',\n')}\n);`;
}

/**
 * Literal SQL ANTI-INJECTION per un valore di cella:
 *  - null/undefined → NULL
 *  - numero finito → as-is (NaN/Infinity → NULL)
 *  - bigint → as-is, boolean → TRUE/FALSE
 *  - Date → 'ISO'
 *  - stringa → '...' con gli apici singoli RADDOPPIATI
 *  - oggetto/array → '...JSON...' (apici raddoppiati)
 * `standard_conforming_strings` (default Postgres/SQLite) → niente escape del
 * backslash: raddoppiare l'apice è sufficiente e corretto.
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v) ?? '';
    } catch {
      s = '[unserializable]';
    }
  }
  return `'${s.replace(/'/g, "''")}'`;
}

/** `INSERT INTO "name" ("c1","c2") VALUES (v1,v2);` per una riga, colonne fisse. */
export function insertStatement(table: string, columns: readonly string[], row: SqlRow): string {
  const cols = columns.map((c) => sqlIdent(c)).join(', ');
  const vals = columns.map((c) => sqlLiteral(row[c])).join(', ');
  return `INSERT INTO ${sqlIdent(table)} (${cols}) VALUES (${vals});`;
}

/**
 * Estrae { name, columns } dalle tabelle introspezionate (tipate `unknown` dal
 * service). Type-safe, niente `any`: scarta tabelle/colonne malformate.
 */
export function parseDumpTables(introspected: unknown): DumpTable[] {
  if (!Array.isArray(introspected)) return [];
  return introspected.flatMap((t): DumpTable[] => {
    if (!t || typeof t !== 'object') return [];
    const name = (t as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) return [];
    const colsRaw = (t as { columns?: unknown }).columns;
    const columns: DumpColumn[] = Array.isArray(colsRaw)
      ? colsRaw.flatMap((c): DumpColumn[] => {
          if (!c || typeof c !== 'object') return [];
          const cn = (c as { name?: unknown }).name;
          if (typeof cn !== 'string' || cn.length === 0) return [];
          const ct = (c as { type?: unknown }).type;
          const constraints = (c as { constraints?: unknown }).constraints;
          const cons = constraints && typeof constraints === 'object' ? (constraints as Record<string, unknown>) : {};
          const col: DumpColumn = { name: cn, type: typeof ct === 'string' ? ct : 'text' };
          if (typeof cons.nullable === 'boolean') col.nullable = cons.nullable;
          if (cons.primaryKey === true) col.primaryKey = true;
          return [col];
        })
      : [];
    return [{ name, columns }];
  });
}
