import type {
  Database,
  MigrationAction,
  QuerySpec,
  Relation,
  Table,
} from '@medea/engine-db-studio-core';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  durationMs: number;
}

export interface ExecuteResult {
  affectedRows: number;
  insertedId?: string | number;
  durationMs: number;
}

export interface RawQueryColumn {
  name: string;
  type?: string;
}

export interface RawQueryResult {
  /** Result rows. Empty for write statements with no RETURNING clause.
   *  For multi-statement inputs, this echoes the LAST statement's rows
   *  (so a SELECT at the bottom of a script still feeds the editor table). */
  rows: Record<string, unknown>[];
  /** Column metadata in the order returned by the engine. */
  columns: RawQueryColumn[];
  /** Number of rows returned (rows.length, repeated for convenience). */
  rowCount: number;
  /** Rows affected (for INSERT/UPDATE/DELETE). undefined for SELECT. */
  affectedRows?: number;
  /** Elapsed time on the server. */
  durationMs: number;
  /** True if the query was wrapped in a transaction and rolled back (dry-run). */
  rolledBack: boolean;
  /** Human-readable kind of statement (best-effort sniff). For multi-statement
   *  inputs, echoes the LAST statement's kind. */
  statementKind: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'explain' | 'other';
  /** Per-statement breakdown for multi-statement scripts. Present when the
   *  SQL editor sent >1 statement; absent (single-statement legacy) otherwise.
   *  All statements are executed inside the SAME transaction — atomic. */
  statementResults?: {
    index: number;
    kind: RawQueryResult['statementKind'];
    rowCount: number;
    affectedRows?: number;
    sqlPreview: string;
  }[];
}

/**
 * Atomic batch operations — used by the `db_insert_batch` workflow node and
 * by any service that needs all-or-nothing semantics for header+children
 * inserts (orders/order_lines, invoices/invoice_lines, ...).
 *
 *  - `insert`         → 1 row, optionally bound to `as` for later FK reference
 *  - `insertMany`     → N rows. If `refColumn` is set, the value is taken from
 *                       the named binding (`refFrom`) — usually the
 *                       `insertedId` of a previous `insert` step with the same `as`.
 *
 * All operations run inside ONE transaction; any failure rolls back everything.
 */
export type BatchOp =
  | { kind: 'insert'; table: string; row: Record<string, unknown>; as?: string | undefined }
  | {
      kind: 'insertMany';
      table: string;
      rows: Record<string, unknown>[];
      /** When set, each row gets `refColumn` populated from the value bound to `refFrom`. */
      refColumn?: string | undefined;
      refFrom?: string | undefined;
    };

export interface BatchResult {
  /** Per-step result (1:1 with input ops). insertedId is the lastrowid when applicable. */
  steps: {
    index: number;
    kind: BatchOp['kind'];
    affectedRows: number;
    insertedId?: string | number;
  }[];
  /** Map of `as` bindings → insertedId, available for downstream callers. */
  bindings: Record<string, string | number>;
  durationMs: number;
}

export interface RawQueryOptions {
  /** If true, the adapter wraps the statement in a transaction and rolls
   * back at the end — useful for "what would this DELETE affect?" without
   * mutating the DB. Implementations that cannot wrap in tx MUST throw. */
  dryRun?: boolean;
  /** Maximum rows to return from a SELECT. Adapter may inject LIMIT. */
  rowLimit?: number;
  /**
   * N19 audit (2026-05-29): hard-gate non-read statements.
   *
   * When true, the adapter MUST refuse the batch if ANY top-level statement
   * is not `select` or `explain` — including multi-statement payloads and
   * Postgres modifying CTEs (WITH ... DELETE ... SELECT ...).
   *
   * Callers that legitimately need DML (migrations, repairs) leave this
   * unset (default false → back-compat with the SQL editor flow). The
   * Janitor DSL detect path MUST pass `readOnly: true` so a tampered or
   * mis-validated `detectSql` cannot mutate the DB.
   */
  readOnly?: boolean;
}

export interface IDatabaseAdapter {
  readonly engine: Database['connection']['engine'];

  connect(database: Database): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Apply a migration plan idempotently. Returns the SQL that was executed
   * (for preview / audit). Implementations MUST run all actions in a single
   * transaction and roll back on any failure.
   */
  applyMigration(
    actions: readonly MigrationAction[],
  ): Promise<{ sql: string; affectedTables: string[] }>;

  /**
   * Render a migration plan to SQL WITHOUT executing it. Used for the
   * 'preview before apply' UX requested by the owner.
   */
  previewMigration(actions: readonly MigrationAction[]): Promise<string>;

  query<T = Record<string, unknown>>(spec: QuerySpec): Promise<QueryResult<T>>;
  insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult>;
  update(
    tableName: string,
    where: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<ExecuteResult>;
  delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult>;

  /**
   * Introspect the live schema and return Tables matching the current state.
   * Used to diff against the Database.tables canonical model.
   */
  introspect(): Promise<Table[]>;

  /**
   * OPTIONAL — introspect le foreign key REALI dal DB (per l'ER diagram).
   * Implementato dagli adapter SQL; assente su Mongo/Redis/Vector.
   */
  introspectRelations?(): Promise<Relation[]>;

  /**
   * OPTIONAL — execute a free-form SQL statement. Only SQL adapters
   * (sqlite/postgres/mysql/mssql/duckdb) implement this. MongoDB / Redis /
   * Vector adapters leave it undefined. The HTTP route returns 405 when
   * the engine does not support raw SQL.
   *
   * Implementations MUST:
   *   - Reject multi-statement input (single `;` allowed at end).
   *   - When `opts.dryRun === true`, wrap in tx and ROLLBACK at the end.
   *   - Respect `opts.rowLimit` for SELECT; either inject LIMIT or truncate.
   *   - Return column metadata in declaration order.
   *   - Never log the SQL at info level (may contain PII).
   */
  executeRaw?(sql: string, opts?: RawQueryOptions): Promise<RawQueryResult>;

  /**
   * OPTIONAL — atomic batch insert (single transaction).
   * SQL adapters (sqlite/postgres/mysql/mssql/duckdb) implement this. Mongo/
   * Redis/Vector leave it undefined; the workflow node returns a clear error
   * when invoked against an unsupported backend.
   */
  transaction?(ops: BatchOp[]): Promise<BatchResult>;
}

/**
 * N19 audit (2026-05-29): defense-in-depth priority for `classifyStatement`.
 *
 * Higher rank = more restrictive intent. Used to fold a multi-statement
 * blob into the WORST-kind so callers (executeRaw, DSL detect validator)
 * cannot be tricked by `SELECT 1; DROP TABLE x` — historically that
 * returned 'select' because only the first keyword was inspected.
 *
 * KEEP THE ORDER `ddl > delete > update > insert > other > select|explain`:
 *  - DDL is irreversible (DROP/TRUNCATE/ALTER) → highest gate
 *  - DELETE > UPDATE because deletes are non-recoverable without backup
 *  - 'other' (unknown keyword: CALL, BEGIN, VACUUM, GRANT, …) higher than
 *    SELECT because we cannot prove read-only semantics.
 */
const STATEMENT_KIND_PRIORITY: Record<RawQueryResult['statementKind'], number> = {
  ddl: 5,
  delete: 4,
  update: 3,
  insert: 2,
  other: 1,
  select: 0,
  explain: 0,
};

/**
 * Sostituisce con spazi il contenuto di stringhe ('…', "…") e commenti
 * (-- …, /* … * /), preservando lunghezza e struttura. Stessa lessicalizzazione
 * di `splitStatements` → un verbo DML dentro un letterale/commento/identificatore
 * quotato NON viene scambiato per esecuzione. Usato dalla detection del ramo
 * WITH (anti falso-positivo).
 */
function maskLiteralsAndComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';
    if (inLineComment) {
      out += ch === '\n' ? '\n' : ' ';
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        out += '  ';
        inBlockComment = false;
        i++;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inSingle) {
      out += ' ';
      if (ch === "'" && sql[i - 1] !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ' ';
      if (ch === '"' && sql[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (ch === '-' && next === '-') {
      out += '  ';
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      out += ' ';
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      out += ' ';
      inDouble = true;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Classify ONE statement by its first significant keyword. Strips leading
 * comments and whitespace. NB: does NOT split multi-statement input — that
 * is `classifyStatement`'s job (it folds multi-statement to the worst).
 */
function classifySingleStatement(sql: string): RawQueryResult['statementKind'] {
  const stripped = sql
    .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)+/g, '')
    .trim()
    .toLowerCase();

  // N19 audit + fix revisore 2026-06-14: un WITH-prefisso può MUTARE il DB in
  // DUE modi, ENTRAMBI da cogliere:
  //   (a) CTE modificante:        WITH d AS (DELETE FROM t RETURNING *) SELECT …
  //   (b) DML PRIMARIO dopo i CTE: WITH x AS (SELECT 1) DELETE FROM t …   ← buco
  // Postgres/SQLite eseguono entrambi. Pre-fix la detection cercava il verbo
  // SOLO dentro le parentesi del CTE (`(\s*delete`) → il caso (b) sfuggiva e
  // tornava 'select' → run_sql / nodo SSH "sola lettura" eseguivano la mutazione.
  // Ora: maschera stringhe/commenti (no falsi positivi su letterali/identificatori
  // quotati/commenti) e cerca i pattern DML come parola intera OVUNQUE, ripiegando
  // al kind peggiore (un SELECT puro non contiene mai questi pattern fuori da stringhe).
  if (stripped.startsWith('with')) {
    const masked = maskLiteralsAndComments(stripped);
    let worst: RawQueryResult['statementKind'] = 'select';
    const bump = (k: RawQueryResult['statementKind']): void => {
      if (STATEMENT_KIND_PRIORITY[k] > STATEMENT_KIND_PRIORITY[worst]) worst = k;
    };
    if (/\bdelete\s+from\b/u.test(masked)) bump('delete');
    if (/\bupdate\b[\s\S]*?\bset\b/u.test(masked)) bump('update');
    if (/\binsert\s+into\b/u.test(masked)) bump('insert');
    if (/\bmerge\s+into\b/u.test(masked)) bump('delete'); // MERGE muta → worst DML
    return worst;
  }
  if (stripped.startsWith('select')) return 'select';
  if (stripped.startsWith('insert')) return 'insert';
  if (stripped.startsWith('update')) return 'update';
  if (stripped.startsWith('delete')) return 'delete';
  if (stripped.startsWith('explain')) return 'explain';
  if (
    stripped.startsWith('create') ||
    stripped.startsWith('drop') ||
    stripped.startsWith('alter') ||
    stripped.startsWith('truncate')
  ) {
    return 'ddl';
  }
  return 'other';
}

/**
 * Classify a SQL blob by inspecting EVERY top-level statement and returning
 * the WORST kind (highest priority). N19 audit (2026-05-29) hardening:
 *
 *  - `SELECT 1; DROP TABLE x`        → 'ddl'    (was 'select' pre-fix)
 *  - `WITH d AS (DELETE …) SELECT …` → 'delete' (was 'select' pre-fix)
 *  - `SELECT 1`                      → 'select' (unchanged)
 *
 * Used by adapters AND by the manage-dsl-rules validator. The "worst-kind"
 * fold is the load-bearing security property: any caller that gates on
 * `kind === 'select'` will reject hidden DML/DDL.
 */
export function classifyStatement(sql: string): RawQueryResult['statementKind'] {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return classifySingleStatement(sql);
  }

  // Seed with the first statement's actual kind (so a single EXPLAIN
  // returns 'explain' instead of being collapsed into 'select' just
  // because explain shares the same read-only priority bucket).
  let worst: RawQueryResult['statementKind'] = classifySingleStatement(statements[0]!);
  for (let i = 1; i < statements.length; i++) {
    const kind = classifySingleStatement(statements[i]!);
    if (STATEMENT_KIND_PRIORITY[kind] > STATEMENT_KIND_PRIORITY[worst]) {
      worst = kind;
    }
  }
  return worst;
}

const FS_ESCAPE_FIRST_RE = /^(attach|detach)\b/u;
const VACUUM_INTO_RE = /^vacuum\b[\s\S]*\binto\b/u;
const LOAD_EXTENSION_RE = /\bload_extension\s*\(/u;

/**
 * Blocca gli statement che evadono il sandbox del DB workspace verso il
 * filesystem dell'host. A differenza di Postgres, SQLite può montare/scrivere
 * file arbitrari:
 *   - ATTACH 'file' AS x  → monta un DB esterno (lettura FS host)
 *   - VACUUM INTO 'file'  → scrive il DB su un path arbitrario (exfil)
 *   - load_extension('lib.so') → carica codice nativo (RCE)
 * Il DB Studio raw-SQL gira sul DB del tenant ma resta isolato SOLO se questi
 * verbi sono vietati. Throw → l'endpoint risponde errore, nessuna esecuzione.
 * Normalizzazione identica a classifySingleStatement (strip commenti/leading ws)
 * così un `/* * / ATTACH …` non bypassa il check.
 */
export function assertSafeRawStatement(sql: string): void {
  const stripped = sql
    .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)+/g, '')
    .trim()
    .toLowerCase();
  if (FS_ESCAPE_FIRST_RE.test(stripped)) {
    throw new Error(
      'ATTACH/DETACH non consentito: il raw SQL non può montare database esterni (filesystem escape bloccato).',
    );
  }
  if (VACUUM_INTO_RE.test(stripped)) {
    throw new Error(
      'VACUUM INTO non consentito: scrittura su file arbitrari del filesystem bloccata.',
    );
  }
  if (LOAD_EXTENSION_RE.test(stripped)) {
    throw new Error('load_extension non consentito: caricamento di estensioni native bloccato.');
  }
}

/**
 * Ensure the user passed a single SQL statement. Allows a single trailing
 * `;` but rejects two top-level statements. Naive but adequate: handles
 * `;` inside string literals and comments.
 *
 * Kept for the few callers that legitimately want single-stmt enforcement
 * (e.g. dry-run plan estimator). For the SQL editor, use `splitStatements`.
 */
export function assertSingleStatement(sql: string): void {
  const list = splitStatements(sql);
  if (list.length > 1) {
    throw new Error('Multiple statements not allowed — run one statement at a time.');
  }
}

/**
 * Split a SQL blob into individual statements at top-level `;` boundaries.
 * Respects string literals (`'…'`, `"…"`), line comments (`-- …`), and
 * block comments (`/* … *\/`). Trims whitespace; drops empties.
 *
 * This is the foundation of multi-statement execution in the SQL editor:
 * the route wraps `splitStatements()` output in a single transaction and
 * executes each — atomic by construction. Rollback on any error.
 *
 * Limitations: no support for dollar-quoted strings (PostgreSQL $$body$$
 * function bodies). Callers that need them should fall back to single-stmt.
 * For the FlowForge schema authoring use case (CREATE TABLE / INSERT / etc.)
 * this is enough.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';
    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (ch === '*' && next === '/') {
        buf += next;
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'" && sql[i - 1] !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '"' && sql[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (ch === '-' && next === '-') {
      buf += ch + next;
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      buf += ch + next;
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      buf += ch;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      buf += ch;
      inDouble = true;
      continue;
    }
    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt !== '') statements.push(stmt);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail !== '') statements.push(tail);
  return statements;
}
