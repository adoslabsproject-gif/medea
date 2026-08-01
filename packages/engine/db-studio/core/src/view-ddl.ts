/**
 * view-ddl — generatore SQL CONDIVISO per le VIEW (CREATE/DROP). La sintassi è
 * standard SQL; le sole differenze tra dialetti sono il QUOTING dell'identificatore
 * (sqlite/postgres/duckdb → "x", mysql → `x`, mssql → [x]). Per questo il render è
 * UNICO e ogni adapter inietta solo il proprio `quoteIdent` — niente duplicazione
 * della logica DDL across 5 adapter.
 *
 * La SELECT è opaca QUI: la sua validazione read-only (classifyStatement +
 * assertSafeRawStatement + single-statement) avviene a monte, nel tool del
 * DB-agent, PRIMA di costruire l'azione. Questo modulo non interpreta il SELECT.
 *
 * @module view-ddl
 */
import type { ViewDef } from './index.js';

/** Funzione di quoting dell'identificatore, fornita dall'adapter (dialect-specific). */
export type QuoteIdent = (identifier: string) => string;

/** `CREATE VIEW <name> AS <select>` — il SELECT è già validato read-only a monte. */
export function renderCreateViewSql(view: ViewDef, quoteIdent: QuoteIdent): string {
  // Niente ';' finale interno: il select potrebbe già averne uno → lo togliamo
  // per non generare uno statement-break (difesa anti multi-statement smuggling).
  const select = view.select.trim().replace(/\s*;\s*$/u, '');
  return `CREATE VIEW ${quoteIdent(view.name)} AS ${select};`;
}

/** `DROP VIEW IF EXISTS <name>` — idempotente. */
export function renderDropViewSql(viewName: string, quoteIdent: QuoteIdent): string {
  return `DROP VIEW IF EXISTS ${quoteIdent(viewName)};`;
}
