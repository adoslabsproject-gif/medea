import SqliteDatabase from 'better-sqlite3';
import type { Database as BetterSqlite3Db } from 'better-sqlite3';
import type {
  Column,
  Database,
  MigrationAction,
  QueryFilter,
  QuerySpec,
  Relation,
  RelationOnDelete,
  Table,
} from '@medea/engine-db-studio-core';
import { renderCreateViewSql, renderDropViewSql } from '@medea/engine-db-studio-core';
import type { IDatabaseAdapter, QueryResult, ExecuteResult, RawQueryResult, RawQueryOptions, BatchOp, BatchResult } from './adapter.js';
import { classifyStatement, splitStatements, assertSafeRawStatement } from './adapter.js';
import { recreateTableStatements } from './alter-column-recreate.js';

/** Quoting identificatore SQLite (doppi apici). */
const sqliteQuote = (id: string): string => `"${id.replace(/"/gu, '""')}"`;

/** Riga di PRAGMA table_info. */
interface PragmaCol { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

/** DDL di una colonna esistente, preservandone tipo/constraint (table-recreate). */
function pragmaColDdl(c: PragmaCol): string {
  const parts = [sqliteQuote(c.name), c.type || 'TEXT'];
  if (c.pk) parts.push('PRIMARY KEY');
  else if (c.notnull) parts.push('NOT NULL');
  if (c.dflt_value !== null) parts.push(`DEFAULT ${c.dflt_value}`);
  return parts.join(' ');
}

/** DDL della colonna TARGET applicando il patch di alter_column (mantiene i valori
 *  correnti per i campi non toccati dal patch). */
function patchedColDdl(
  c: PragmaCol,
  patch: { type?: Column['type'] | undefined; constraints?: Column['constraints'] | undefined },
  newName: string,
): string {
  const type = patch.type ? TYPE_TO_SQLITE[patch.type] : (c.type || 'TEXT');
  const cons = patch.constraints;
  const nullable = cons?.nullable ?? (c.notnull === 0);
  const pk = cons?.primaryKey ?? (c.pk > 0);
  const unique = cons?.unique ?? false;
  const def = cons?.default ?? (c.dflt_value ?? undefined);
  const parts = [sqliteQuote(newName), type];
  if (pk) parts.push('PRIMARY KEY');
  else if (!nullable) parts.push('NOT NULL');
  if (unique && !pk) parts.push('UNIQUE');
  if (def !== undefined && def !== null) parts.push(`DEFAULT ${def}`);
  if (cons?.check) parts.push(`CHECK (${cons.check})`);
  return parts.join(' ');
}

/** Mappa il valore PRAGMA on_delete (uppercase) all'enum core. */
function mapSqliteOnDelete(raw: string): RelationOnDelete {
  switch ((raw || '').toUpperCase()) {
    case 'CASCADE': return 'cascade';
    case 'RESTRICT': return 'restrict';
    case 'SET NULL': return 'set null';
    case 'SET DEFAULT': return 'set default';
    default: return 'no action';
  }
}

const TYPE_TO_SQLITE: Record<Column['type'], string> = {
  text: 'TEXT',
  varchar: 'TEXT',
  integer: 'INTEGER',
  bigint: 'INTEGER',
  decimal: 'NUMERIC',
  real: 'REAL',
  boolean: 'INTEGER',
  date: 'TEXT',
  time: 'TEXT',
  datetime: 'TEXT',
  json: 'TEXT',
  uuid: 'TEXT',
  bytea: 'BLOB',
  enum: 'TEXT',
};

function renderColumn(col: Column): string {
  const constraints = col.constraints;
  const parts: string[] = [`"${col.name}"`, TYPE_TO_SQLITE[col.type]];
  if (constraints.primaryKey) parts.push('PRIMARY KEY');
  if (!constraints.nullable) parts.push('NOT NULL');
  if (constraints.unique && !constraints.primaryKey) parts.push('UNIQUE');
  if (constraints.default !== undefined) parts.push(`DEFAULT ${constraints.default}`);
  if (constraints.check) parts.push(`CHECK (${constraints.check})`);
  return parts.join(' ');
}

function renderCreateTable(table: Table): string {
  const cols = table.columns.map(renderColumn).join(',\n  ');
  return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n  ${cols}\n);`;
}

function renderCreateIndex(tableName: string, idx: { name: string; columns: string[]; unique: boolean }): string {
  const unique = idx.unique ? 'UNIQUE ' : '';
  const cols = idx.columns.map((c) => `"${c}"`).join(', ');
  return `CREATE ${unique}INDEX IF NOT EXISTS "${idx.name}" ON "${tableName}" (${cols});`;
}

function renderFilter(filter: QueryFilter): { clause: string; params: unknown[] } {
  switch (filter.op) {
    case 'eq':       return { clause: `"${filter.column}" = ?`,  params: [filter.value] };
    case 'neq':      return { clause: `"${filter.column}" != ?`, params: [filter.value] };
    case 'gt':       return { clause: `"${filter.column}" > ?`,  params: [filter.value] };
    case 'gte':      return { clause: `"${filter.column}" >= ?`, params: [filter.value] };
    case 'lt':       return { clause: `"${filter.column}" < ?`,  params: [filter.value] };
    case 'lte':      return { clause: `"${filter.column}" <= ?`, params: [filter.value] };
    case 'like':     return { clause: `"${filter.column}" LIKE ?`, params: [filter.value] };
    case 'isNull':   return { clause: `"${filter.column}" IS NULL`, params: [] };
    case 'notNull':  return { clause: `"${filter.column}" IS NOT NULL`, params: [] };
    case 'in': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const placeholders = values.map(() => '?').join(', ');
      return { clause: `"${filter.column}" IN (${placeholders})`, params: values };
    }
  }
}

function renderMigrationAction(action: MigrationAction): string {
  switch (action.kind) {
    case 'create_table': {
      const sql = renderCreateTable(action.table);
      const indexes = (action.table.indexes ?? []).map((idx) =>
        renderCreateIndex(action.table.name, idx),
      );
      return [sql, ...indexes].join('\n');
    }
    case 'drop_table':
      return `DROP TABLE IF EXISTS "${action.tableName}";`;
    case 'rename_table':
      return `ALTER TABLE "${action.from}" RENAME TO "${action.to}";`;
    case 'add_column':
      return `ALTER TABLE "${action.tableName}" ADD COLUMN ${renderColumn(action.column)};`;
    case 'drop_column':
      return `ALTER TABLE "${action.tableName}" DROP COLUMN "${action.columnName}";`;
    case 'rename_column':
      return `ALTER TABLE ${sqliteQuote(action.tableName)} RENAME COLUMN ${sqliteQuote(action.from)} TO ${sqliteQuote(action.to)};`;
    case 'alter_column':
      return `-- ALTER TABLE "${action.tableName}" ALTER COLUMN "${action.columnName}" — SQLite has limited ALTER COLUMN support; consider table-recreate strategy.`;
    case 'add_relation':
      return `-- SQLite enforces FK via PRAGMA; relation ${action.relation.name} (${action.relation.fromTable}.${action.relation.fromColumn} → ${action.relation.toTable}.${action.relation.toColumn}) recorded in catalog.`;
    case 'drop_relation':
      return `-- Drop relation ${action.relationId} (cataloged only in SQLite).`;
    case 'add_index':
      return renderCreateIndex(action.tableName, action.index);
    case 'drop_index':
      return `DROP INDEX IF EXISTS "${action.indexName}";`;
    case 'create_view':
      return renderCreateViewSql(action.view, sqliteQuote);
    case 'drop_view':
      return renderDropViewSql(action.viewName, sqliteQuote);
  }
}

export class SqliteAdapter implements IDatabaseAdapter {
  readonly engine = 'sqlite' as const;
  private conn: BetterSqlite3Db | null = null;

  connect(database: Database): Promise<void> {
    const path = database.connection.url ?? `:memory:`;
    this.conn = new SqliteDatabase(path);
    this.conn.pragma('journal_mode = WAL');
    this.conn.pragma('foreign_keys = ON');
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.conn?.close();
    this.conn = null;
    return Promise.resolve();
  }

  private requireConn(): BetterSqlite3Db {
    if (!this.conn) throw new Error('SqliteAdapter not connected — call connect() first');
    return this.conn;
  }

  previewMigration(actions: readonly MigrationAction[]): Promise<string> {
    return Promise.resolve(actions.map(renderMigrationAction).join('\n\n'));
  }

  // MECCANISMO (eccezione require-await): `async` VOLUTO senza await — better-sqlite3
  // è SINCRONO, ma marcando async i throw della transazione diventano una rejected
  // promise (non un throw sincrono), così il contratto è coerente per i chiamanti.
  // eslint-disable-next-line @typescript-eslint/require-await
  async applyMigration(actions: readonly MigrationAction[]): Promise<{ sql: string; affectedTables: string[] }> {
    const conn = this.requireConn();
    const affectedTables = new Set<string>();
    for (const action of actions) {
      if (action.kind === 'create_table') affectedTables.add(action.table.name);
      else if (action.kind === 'drop_table') affectedTables.add(action.tableName);
      else if (action.kind === 'rename_table') affectedTables.add(action.to);
      else if (action.kind === 'add_column' || action.kind === 'drop_column' || action.kind === 'alter_column' || action.kind === 'rename_column') affectedTables.add(action.tableName);
      else if (action.kind === 'add_index' || action.kind === 'drop_index') affectedTables.add(action.tableName);
    }

    const executedSql: string[] = [];
    const txn = conn.transaction(() => {
      for (const action of actions) {
        if (action.kind === 'alter_column') {
          // SQLite non ha ALTER COLUMN in-place → table-recreate REALE (preserva
          // dati). Prima era un no-op (commento saltato dal filtro).
          const info = conn.prepare(`PRAGMA table_info(${sqliteQuote(action.tableName)})`).all() as PragmaCol[];
          if (info.length === 0) throw new Error(`alter_column: tabella "${action.tableName}" non trovata`);
          if (!info.some((c) => c.name === action.columnName)) {
            throw new Error(`alter_column: colonna "${action.columnName}" non esiste in "${action.tableName}"`);
          }
          const newName = action.patch.name ?? action.columnName;
          const columnsDdl = info.map((c) => (c.name === action.columnName ? patchedColDdl(c, action.patch, newName) : pragmaColDdl(c)));
          const copyColumns = info.map((c) => ({ from: c.name, to: c.name === action.columnName ? newName : c.name }));
          const stmts = recreateTableStatements({ tableName: action.tableName, columnsDdl, copyColumns, quote: sqliteQuote });
          for (const s of stmts) conn.exec(s + ';');
          executedSql.push(stmts.join(';\n') + ';');
        } else {
          const rendered = renderMigrationAction(action);
          for (const stmt of rendered.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'))) {
            conn.exec(stmt + ';');
          }
          executedSql.push(rendered);
        }
      }
    });
    txn();
    return { sql: executedSql.join('\n\n'), affectedTables: [...affectedTables] };
  }

  query<T = Record<string, unknown>>(spec: QuerySpec): Promise<QueryResult<T>> {
    const conn = this.requireConn();
    const start = Date.now();
    const filters = spec.filters ?? [];
    const orderBy = spec.orderBy ?? [];
    const selectClause = spec.select && spec.select.length > 0 ? spec.select.map((c) => `"${c}"`).join(', ') : '*';
    const where = filters.map(renderFilter);
    const whereClause = where.length ? `WHERE ${where.map((w) => w.clause).join(' AND ')}` : '';
    const orderClause = orderBy.length
      ? `ORDER BY ${orderBy.map((o) => `"${o.column}" ${o.direction.toUpperCase()}`).join(', ')}`
      : '';
    const limitClause = spec.limit !== undefined ? `LIMIT ${spec.limit.toString()}` : '';
    const offsetClause = spec.offset !== undefined ? `OFFSET ${spec.offset.toString()}` : '';
    const sql = `SELECT ${selectClause} FROM "${spec.table}" ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();
    const params = where.flatMap((w) => w.params);
    const rows = conn.prepare(sql).all(...params) as T[];
    return Promise.resolve({ rows, rowCount: rows.length, durationMs: Date.now() - start });
  }

  insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult> {
    const conn = this.requireConn();
    const start = Date.now();
    const cols = Object.keys(row);
    const sql = `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const info = conn.prepare(sql).run(...Object.values(row));
    return Promise.resolve({
      affectedRows: info.changes,
      insertedId: info.lastInsertRowid as number,
      durationMs: Date.now() - start,
    });
  }

  update(tableName: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<ExecuteResult> {
    const conn = this.requireConn();
    const start = Date.now();
    const setCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    const sql = `UPDATE "${tableName}" SET ${setCols.map((c) => `"${c}" = ?`).join(', ')} WHERE ${whereCols.map((c) => `"${c}" = ?`).join(' AND ')}`;
    const info = conn.prepare(sql).run(...Object.values(patch), ...Object.values(where));
    return Promise.resolve({ affectedRows: info.changes, durationMs: Date.now() - start });
  }

  delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult> {
    const conn = this.requireConn();
    const start = Date.now();
    const whereCols = Object.keys(where);
    const sql = `DELETE FROM "${tableName}" WHERE ${whereCols.map((c) => `"${c}" = ?`).join(' AND ')}`;
    const info = conn.prepare(sql).run(...Object.values(where));
    return Promise.resolve({ affectedRows: info.changes, durationMs: Date.now() - start });
  }

  /**
   * Atomic batch — runs all ops inside ONE better-sqlite3 transaction.
   * `as` bindings let later steps reference earlier insertedIds (e.g.
   * orders→order_lines via order_id FK). If ANY step throws, the whole
   * transaction is rolled back by better-sqlite3.
   */
  transaction(ops: BatchOp[]): Promise<BatchResult> {
    const conn = this.requireConn();
    const start = Date.now();
    const steps: BatchResult['steps'] = [];
    const bindings: BatchResult['bindings'] = {};

    const txn = conn.transaction(() => {
      ops.forEach((op, index) => {
        if (op.kind === 'insert') {
          const cols = Object.keys(op.row);
          if (cols.length === 0) throw new Error(`transaction[${index.toString()}]: insert row has no columns`);
          const sql = `INSERT INTO "${op.table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
          const info = conn.prepare(sql).run(...Object.values(op.row));
          // If the row provided an explicit `id` (typical for TEXT PKs like
          // UUIDs in production schemas), bind THAT — not the internal rowid.
          // Only fall back to lastInsertRowid for auto-increment INTEGER PKs.
          const explicitId = op.row.id;
          const insertedId: string | number = (typeof explicitId === 'string' || typeof explicitId === 'number')
            ? explicitId
            : (info.lastInsertRowid as number);
          if (op.as) bindings[op.as] = insertedId;
          steps.push({ index, kind: 'insert', affectedRows: info.changes, insertedId });
        } else if (op.kind === 'insertMany') {
          if (op.rows.length === 0) {
            steps.push({ index, kind: 'insertMany', affectedRows: 0 });
            return;
          }
          // Resolve the FK column value once (same for every child row).
          let refValue: string | number | undefined;
          if (op.refColumn && op.refFrom) {
            const bound = bindings[op.refFrom];
            if (bound === undefined) {
              throw new Error(`transaction[${index.toString()}]: refFrom "${op.refFrom}" is not bound by any earlier step`);
            }
            refValue = bound;
          }
          // All rows MUST share the same column set; we use the first row's keys.
          const baseCols = Object.keys(op.rows[0] ?? {});
          if (baseCols.length === 0) throw new Error(`transaction[${index.toString()}]: insertMany rows have no columns`);
          const finalCols = op.refColumn ? [...baseCols, op.refColumn] : baseCols;
          const sql = `INSERT INTO "${op.table}" (${finalCols.map((c) => `"${c}"`).join(', ')}) VALUES (${finalCols.map(() => '?').join(', ')})`;
          const stmt = conn.prepare(sql);
          let affected = 0;
          for (const row of op.rows) {
            const values = baseCols.map((c) => row[c]);
            if (op.refColumn) values.push(refValue);
            const info = stmt.run(...values);
            affected += info.changes;
          }
          steps.push({ index, kind: 'insertMany', affectedRows: affected });
        }
      });
    });
    // Run inside Promise.resolve().then so any thrown error becomes a
    // Promise rejection — callers expect rejects.toThrow(), not sync throws.
    return Promise.resolve().then(() => {
      txn();
      return { steps, bindings, durationMs: Date.now() - start };
    });
  }

  introspect(): Promise<Table[]> {
    const conn = this.requireConn();
    const tables = conn.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[];
    const result: Table[] = [];
    for (const t of tables) {
      const cols = conn.prepare(`PRAGMA table_info("${t.name}")`).all() as {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: unknown;
      }[];
      result.push({
        id: t.name,
        name: t.name,
        columns: cols.map((c) => ({
          id: `${t.name}.${c.name}`,
          name: c.name,
          type: 'text',
          constraints: {
            nullable: c.notnull === 0,
            unique: false,
            primaryKey: c.pk > 0,
          },
        })),
        indexes: [],
      });
    }
    return Promise.resolve(result);
  }

  /**
   * Foreign key REALI dal DB via `PRAGMA foreign_key_list` per ogni tabella.
   * È la fonte di verità per l'ER diagram (il manifest.relations non viene
   * aggiornato dalle migration → andava letto dal DB vero).
   */
  introspectRelations(): Promise<Relation[]> {
    const conn = this.requireConn();
    const tables = conn.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[];
    const relations: Relation[] = [];
    for (const t of tables) {
      const fks = conn.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as {
        id: number; seq: number; table: string; from: string; to: string; on_delete: string;
      }[];
      for (const fk of fks) {
        relations.push({
          id: `${t.name}.${fk.from}->${fk.table}.${fk.to}#${fk.id.toString()}`,
          name: `fk_${t.name}_${fk.from}`,
          kind: 'one-to-many',
          fromTable: t.name,
          fromColumn: fk.from,
          toTable: fk.table,
          toColumn: fk.to,
          onDelete: mapSqliteOnDelete(fk.on_delete),
        });
      }
    }
    return Promise.resolve(relations);
  }

  executeRaw(sql: string, opts: RawQueryOptions = {}): Promise<RawQueryResult> {
    const conn = this.requireConn();
    const statements = splitStatements(sql);
    if (statements.length === 0) {
      throw new Error('Empty SQL input — nothing to execute.');
    }
    const start = Date.now();

    /** Execute a single statement, returning the row data + classification. */
    const execOne = (stmt: string): {
      kind: RawQueryResult['statementKind'];
      rows: Record<string, unknown>[];
      columns: RawQueryColumnLike[];
      affectedRows?: number;
    } => {
      assertSafeRawStatement(stmt); // blocca ATTACH/DETACH/VACUUM INTO/load_extension (FS escape)
      const kind = classifyStatement(stmt);
      const isSelect = kind === 'select' || kind === 'explain';
      if (isSelect) {
        const prepared = conn.prepare(stmt);
        const columns = prepared.columns().map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}) }));
        let rows = prepared.all() as Record<string, unknown>[];
        if (opts.rowLimit !== undefined && rows.length > opts.rowLimit) {
          rows = rows.slice(0, opts.rowLimit);
        }
        return { kind, rows, columns };
      }
      // DDL like CREATE INDEX … WHERE … needs `exec()` not `prepare()` on
      // some better-sqlite3 versions — and `exec()` is the only path that
      // returns no changes count. Prefer prepare().run() for affectedRows;
      // fall back to exec() if SQLite refuses to prepare (e.g. multiple
      // semicolons leftover inside a single statement, defensive).
      try {
        const prepared = conn.prepare(stmt);
        const info = prepared.run();
        return { kind, rows: [], columns: [], affectedRows: info.changes };
      } catch {
        conn.exec(stmt);
        return { kind, rows: [], columns: [] };
      }
    };

    /** Multi-statement execution wrapped in a single transaction — atomic. */
    const execAll = (): RawQueryResult => {
      const wrapInTx = statements.length > 1 || opts.dryRun === true;
      const breakdown: NonNullable<RawQueryResult['statementResults']> = [];
      let lastKind: RawQueryResult['statementKind'] = 'other';
      let lastRows: Record<string, unknown>[] = [];
      let lastColumns: RawQueryColumnLike[] = [];
      let lastAffected: number | undefined;

      if (wrapInTx) conn.exec('BEGIN');
      try {
        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i]!;
          const r = execOne(stmt);
          breakdown.push({
            index: i,
            kind: r.kind,
            rowCount: r.rows.length,
            ...(r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
            sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : ''),
          });
          lastKind = r.kind;
          lastRows = r.rows;
          lastColumns = r.columns;
          lastAffected = r.affectedRows;
        }
        if (wrapInTx && !opts.dryRun) conn.exec('COMMIT');
        if (wrapInTx && opts.dryRun) conn.exec('ROLLBACK');
      } catch (err) {
        if (wrapInTx) {
          try { conn.exec('ROLLBACK'); } catch { /* ignore secondary failure */ }
        }
        throw err;
      }

      return {
        rows: lastRows,
        columns: lastColumns,
        rowCount: lastRows.length,
        ...(lastAffected !== undefined ? { affectedRows: lastAffected } : {}),
        durationMs: Date.now() - start,
        rolledBack: opts.dryRun === true,
        statementKind: lastKind,
        ...(statements.length > 1 ? { statementResults: breakdown } : {}),
      };
    };

    return Promise.resolve(execAll());
  }
}

interface RawQueryColumnLike { name: string; type?: string }
