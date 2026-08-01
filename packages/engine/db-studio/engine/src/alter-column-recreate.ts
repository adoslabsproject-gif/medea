/**
 * alter-column-recreate — SQLite NON supporta ALTER COLUMN in-place. La strategia
 * UFFICIALE SQLite è il "table-recreate": CREATE nuova tabella → copia dati → DROP
 * vecchia → RENAME. Qui sta la parte PURA (generazione statement), testabile in
 * isolamento; il SqliteAdapter fornisce lo schema reale (PRAGMA table_info) e la
 * DDL delle colonne. Prima di questo modulo `alter_column` era un NO-OP (commento).
 *
 * NB: preserva COLONNE + DATI. Indici/trigger sulla tabella vanno ricreati a parte
 * (limite noto del table-recreate; documentato).
 *
 * @module alter-column-recreate
 */

export interface RecreateOptions {
  tableName: string;
  /** DDL completa di OGNI colonna della nuova tabella (target già patchata). */
  columnsDdl: readonly string[];
  /** Mapping colonne per l'INSERT … SELECT (gestisce anche un eventuale rename). */
  copyColumns: readonly { from: string; to: string }[];
  quote: (identifier: string) => string;
}

/** Statement del table-recreate, in ordine, da eseguire in UNA transazione. */
export function recreateTableStatements(opts: RecreateOptions): string[] {
  if (opts.columnsDdl.length === 0) {
    throw new Error(`Table-recreate di "${opts.tableName}": nessuna colonna — rifiutato (eviterebbe una tabella vuota e perdita dati).`);
  }
  const tmp = `_ff_recreate_${opts.tableName}`;
  const fromCols = opts.copyColumns.map((c) => opts.quote(c.from)).join(', ');
  const toCols = opts.copyColumns.map((c) => opts.quote(c.to)).join(', ');
  return [
    `CREATE TABLE ${opts.quote(tmp)} (${opts.columnsDdl.join(', ')})`,
    `INSERT INTO ${opts.quote(tmp)} (${toCols}) SELECT ${fromCols} FROM ${opts.quote(opts.tableName)}`,
    `DROP TABLE ${opts.quote(opts.tableName)}`,
    `ALTER TABLE ${opts.quote(tmp)} RENAME TO ${opts.quote(opts.tableName)}`,
  ];
}
