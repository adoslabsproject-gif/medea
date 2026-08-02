import mysql, { type Pool } from 'mysql2/promise';
import type { Column, Database, MigrationAction, QueryFilter, QuerySpec, Table, Relation } from '@medea/engine-db-studio-core';
import { renderCreateViewSql, renderDropViewSql, fkRowsToRelations } from '@medea/engine-db-studio-core';
import type { IDatabaseAdapter, QueryResult, ExecuteResult, RawQueryOptions, RawQueryResult, BatchOp, BatchResult } from '@medea/engine-db-studio-engine';
import { classifyStatement, splitStatements } from '@medea/engine-db-studio-engine';

const TYPE_TO_MYSQL: Record<Column['type'], string> = {
  text: 'TEXT',
  varchar: 'VARCHAR(255)',
  integer: 'INT',
  bigint: 'BIGINT',
  decimal: 'DECIMAL(18,4)',
  real: 'DOUBLE',
  boolean: 'TINYINT(1)',
  date: 'DATE',
  time: 'TIME',
  datetime: 'DATETIME',
  json: 'JSON',
  uuid: 'CHAR(36)',
  bytea: 'BLOB',
  enum: 'VARCHAR(255)',
};

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return `\`${name}\``;
}

function renderColumn(col: Column): string {
  const parts: string[] = [quoteIdent(col.name), TYPE_TO_MYSQL[col.type]];
  if (col.constraints.primaryKey) parts.push('PRIMARY KEY');
  if (!col.constraints.nullable) parts.push('NOT NULL');
  if (col.constraints.unique && !col.constraints.primaryKey) parts.push('UNIQUE');
  if (col.constraints.default !== undefined) parts.push(`DEFAULT ${col.constraints.default}`);
  return parts.join(' ');
}

function renderAction(a: MigrationAction): string {
  switch (a.kind) {
    case 'create_table': return `CREATE TABLE IF NOT EXISTS ${quoteIdent(a.table.name)} (\n  ${a.table.columns.map(renderColumn).join(',\n  ')}\n) ENGINE=InnoDB;`;
    case 'drop_table': return `DROP TABLE IF EXISTS ${quoteIdent(a.tableName)};`;
    case 'rename_table': return `RENAME TABLE ${quoteIdent(a.from)} TO ${quoteIdent(a.to)};`;
    case 'add_column': return `ALTER TABLE ${quoteIdent(a.tableName)} ADD COLUMN ${renderColumn(a.column)};`;
    case 'drop_column': return `ALTER TABLE ${quoteIdent(a.tableName)} DROP COLUMN ${quoteIdent(a.columnName)};`;
    case 'rename_column': return `ALTER TABLE ${quoteIdent(a.tableName)} RENAME COLUMN ${quoteIdent(a.from)} TO ${quoteIdent(a.to)};`;
    case 'alter_column': return `-- ALTER COLUMN ${a.columnName} on ${a.tableName} — MySQL requires MODIFY/CHANGE; generated manually`;
    case 'add_relation': {
      const fk = `${a.relation.fromTable}_${a.relation.fromColumn}_fk`;
      return `ALTER TABLE ${quoteIdent(a.relation.fromTable)} ADD CONSTRAINT ${quoteIdent(fk)} FOREIGN KEY (${quoteIdent(a.relation.fromColumn)}) REFERENCES ${quoteIdent(a.relation.toTable)}(${quoteIdent(a.relation.toColumn)}) ON DELETE ${a.relation.onDelete.toUpperCase()};`;
    }
    case 'drop_relation': return `-- drop relation ${a.relationId} (run ALTER TABLE ... DROP FOREIGN KEY manually)`;
    case 'add_index': {
      const uq = a.index.unique ? 'UNIQUE ' : '';
      return `CREATE ${uq}INDEX ${quoteIdent(a.index.name)} ON ${quoteIdent(a.tableName)} (${a.index.columns.map(quoteIdent).join(', ')});`;
    }
    case 'drop_index': return `DROP INDEX ${quoteIdent(a.indexName)} ON ${quoteIdent(a.tableName)};`;
    case 'create_view': return renderCreateViewSql(a.view, quoteIdent);
    case 'drop_view': return renderDropViewSql(a.viewName, quoteIdent);
  }
}

function filterToFragment(f: QueryFilter, paramIdx: number): { sql: string; params: unknown[] } {
  const c = quoteIdent(f.column);
  switch (f.op) {
    case 'eq': return { sql: `${c} = ?`, params: [f.value] };
    case 'neq': return { sql: `${c} != ?`, params: [f.value] };
    case 'gt': return { sql: `${c} > ?`, params: [f.value] };
    case 'gte': return { sql: `${c} >= ?`, params: [f.value] };
    case 'lt': return { sql: `${c} < ?`, params: [f.value] };
    case 'lte': return { sql: `${c} <= ?`, params: [f.value] };
    case 'like': return { sql: `${c} LIKE ?`, params: [f.value] };
    case 'isNull': return { sql: `${c} IS NULL`, params: [] };
    case 'notNull': return { sql: `${c} IS NOT NULL`, params: [] };
    case 'in': {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      const placeholders = values.map(() => '?').join(', ');
      return { sql: `${c} IN (${placeholders})`, params: values };
    }
  }
  void paramIdx;
  return { sql: '', params: [] };
}

export class MysqlAdapter implements IDatabaseAdapter {
  readonly engine = 'mysql' as const;
  private pool: Pool | null = null;

  async connect(database: Database): Promise<void> {
    const conn = database.connection;
    this.pool = mysql.createPool({
      host: conn.hostname ?? 'localhost',
      port: conn.port ?? 3306,
      user: conn.username ?? 'root',
      password: conn.passwordSecretRef ?? '',
      database: conn.database ?? '',
      connectionLimit: 10,
      waitForConnections: true,
    });
    await this.pool.query('SELECT 1');
  }

  async disconnect(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private requirePool(): Pool {
    if (!this.pool) throw new Error('MysqlAdapter not connected');
    return this.pool;
  }

  previewMigration(actions: readonly MigrationAction[]): Promise<string> {
    try {
      return Promise.resolve(actions.map(renderAction).filter((s) => s.trim()).join('\n\n'));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async applyMigration(actions: readonly MigrationAction[]): Promise<{ sql: string; affectedTables: string[] }> {
    const pool = this.requirePool();
    const text = actions.map(renderAction).filter((s) => s.trim() && !s.startsWith('--')).join('\n\n');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    const affected = new Set<string>();
    for (const a of actions) {
      if (a.kind === 'create_table') affected.add(a.table.name);
      else if (a.kind === 'drop_table' || a.kind === 'add_column' || a.kind === 'drop_column') affected.add(a.tableName);
    }
    return { sql: text, affectedTables: [...affected] };
  }

  async query<T = Record<string, unknown>>(spec: QuerySpec): Promise<QueryResult<T>> {
    const pool = this.requirePool();
    const start = Date.now();
    const filters = spec.filters ?? [];
    const orderBy = spec.orderBy ?? [];
    const select = spec.select && spec.select.length > 0 ? spec.select.map(quoteIdent).join(', ') : '*';
    const fragments = filters.map((f, i) => filterToFragment(f, i));
    const whereClause = fragments.length ? `WHERE ${fragments.map((f) => f.sql).join(' AND ')}` : '';
    const orderClause = orderBy.length ? `ORDER BY ${orderBy.map((o) => `${quoteIdent(o.column)} ${o.direction.toUpperCase()}`).join(', ')}` : '';
    const limitClause = spec.limit !== undefined ? `LIMIT ${spec.limit.toString()}` : '';
    const offsetClause = spec.offset !== undefined ? `OFFSET ${spec.offset.toString()}` : '';
    const sql = `SELECT ${select} FROM ${quoteIdent(spec.table)} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();
    const params = fragments.flatMap((f) => f.params);
    const [rows] = await pool.query(sql, params);
    return { rows: rows as T[], rowCount: (rows as unknown[]).length, durationMs: Date.now() - start };
  }

  async insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
    const [result] = await pool.query(sql, Object.values(row));
    const r = result as { insertId?: number; affectedRows?: number };
    const out: ExecuteResult = { affectedRows: r.affectedRows ?? 1, durationMs: Date.now() - start };
    if (r.insertId !== undefined) out.insertedId = r.insertId;
    return out;
  }

  async update(tableName: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const setCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    const sql = `UPDATE ${quoteIdent(tableName)} SET ${setCols.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${whereCols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')}`;
    const [result] = await pool.query(sql, [...Object.values(patch), ...Object.values(where)]);
    return { affectedRows: (result as { affectedRows?: number }).affectedRows ?? 0, durationMs: Date.now() - start };
  }

  async delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const cols = Object.keys(where);
    const sql = `DELETE FROM ${quoteIdent(tableName)} WHERE ${cols.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')}`;
    const [result] = await pool.query(sql, Object.values(where));
    return { affectedRows: (result as { affectedRows?: number }).affectedRows ?? 0, durationMs: Date.now() - start };
  }

  /** Atomic batch — single mysql2 connection + beginTransaction. */
  async transaction(ops: BatchOp[]): Promise<BatchResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const steps: BatchResult['steps'] = [];
    const bindings: BatchResult['bindings'] = {};

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let index = 0; index < ops.length; index++) {
        const op = ops[index]!;
        if (op.kind === 'insert') {
          const cols = Object.keys(op.row);
          if (cols.length === 0) throw new Error(`transaction[${index.toString()}]: insert row has no columns`);
          const placeholders = cols.map(() => '?').join(', ');
          const sql = `INSERT INTO ${quoteIdent(op.table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
          const [result] = await conn.query(sql, Object.values(op.row));
          const r = result as { insertId?: number; affectedRows?: number };
          // Prefer explicit `id` from the row (TEXT/UUID PKs) over the
          // mysql2 auto-generated insertId (which is 0 when the table has no
          // AUTO_INCREMENT column).
          const explicit = op.row.id;
          const insertedId: string | number | undefined =
            (typeof explicit === 'string' || typeof explicit === 'number') ? explicit : r.insertId;
          if (op.as && insertedId !== undefined) bindings[op.as] = insertedId;
          const step: BatchResult['steps'][number] = { index, kind: 'insert', affectedRows: r.affectedRows ?? 1 };
          if (insertedId !== undefined) step.insertedId = insertedId;
          steps.push(step);
        } else if (op.kind === 'insertMany') {
          if (op.rows.length === 0) { steps.push({ index, kind: 'insertMany', affectedRows: 0 }); continue; }
          let refValue: string | number | undefined;
          if (op.refColumn && op.refFrom) {
            const bound = bindings[op.refFrom];
            if (bound === undefined) {
              throw new Error(`transaction[${index.toString()}]: refFrom "${op.refFrom}" is not bound by any earlier step`);
            }
            refValue = bound;
          }
          const baseCols = Object.keys(op.rows[0] ?? {});
          if (baseCols.length === 0) throw new Error(`transaction[${index.toString()}]: insertMany rows have no columns`);
          const finalCols = op.refColumn ? [...baseCols, op.refColumn] : baseCols;
          const placeholders = finalCols.map(() => '?').join(', ');
          const sql = `INSERT INTO ${quoteIdent(op.table)} (${finalCols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
          let affected = 0;
          for (const row of op.rows) {
            const values = baseCols.map((c) => row[c]);
            if (op.refColumn) values.push(refValue);
            const [res] = await conn.query(sql, values);
            affected += (res as { affectedRows?: number }).affectedRows ?? 1;
          }
          steps.push({ index, kind: 'insertMany', affectedRows: affected });
        }
      }
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
    return { steps, bindings, durationMs: Date.now() - start };
  }

  /**
   * Free-form SQL execution with multi-statement support.
   *
   * Strategy:
   *   - Split into statements via `splitStatements` (handles strings/comments).
   *   - Run all of them inside a single `conn.beginTransaction()` block —
   *     on any error, rollback and re-throw with the offending SQL preview.
   *   - SELECT statements expose `rows` + `columns`; non-SELECT capture
   *     `affectedRows`.
   *   - The returned RawQueryResult.rows/columns mirror the LAST statement
   *     so a script ending in `SELECT * FROM …` populates the editor grid.
   */
  async executeRaw(text: string, opts: RawQueryOptions = {}): Promise<RawQueryResult> {
    const pool = this.requirePool();
    const statements = splitStatements(text);
    if (statements.length === 0) {
      throw new Error('Empty SQL input — nothing to execute.');
    }
    // N19 audit (2026-05-29): readOnly hard-gate — reject DML/DDL/other
    // before opening the transaction (no partial side effects).
    if (opts.readOnly === true) {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        const kind = classifyStatement(stmt);
        if (kind !== 'select' && kind !== 'explain') {
          throw new Error(
            `executeRaw readOnly=true: statement #${String(i + 1)} classified as "${kind}" — refused`,
          );
        }
      }
    }
    const start = Date.now();
    const breakdown: NonNullable<RawQueryResult['statementResults']> = [];
    let lastKind: RawQueryResult['statementKind'] = 'other';
    let lastRows: Record<string, unknown>[] = [];
    let lastColumns: { name: string; type?: string }[] = [];
    let lastAffected: number | undefined;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        const kind = classifyStatement(stmt);
        const isSelect = kind === 'select' || kind === 'explain';
        if (isSelect) {
          const limited = opts.rowLimit !== undefined ? `${stmt.replace(/;?\s*$/, '')} LIMIT ${opts.rowLimit.toString()}` : stmt;
          const [rowsRaw, fields] = await conn.query(limited);
          const rows = rowsRaw as Record<string, unknown>[];
          const columns = Array.isArray(fields)
            ? (fields as { name: string; type?: number }[]).map((f) => ({ name: f.name }))
            : rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [];
          lastKind = kind; lastRows = rows; lastColumns = columns; lastAffected = undefined;
          breakdown.push({ index: i, kind, rowCount: rows.length, sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '') });
        } else {
          const [result] = await conn.query(stmt);
          const r = result as { affectedRows?: number };
          lastKind = kind; lastRows = []; lastColumns = []; lastAffected = r.affectedRows ?? 0;
          breakdown.push({ index: i, kind, rowCount: 0, affectedRows: lastAffected, sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '') });
        }
      }
      if (opts.dryRun) await conn.rollback();
      else await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore secondary failure */ }
      throw err;
    } finally {
      conn.release();
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
  }

  async introspect(): Promise<Table[]> {
    const pool = this.requirePool();
    const [rows] = await pool.query('SHOW TABLES');
    const tables: Table[] = [];
    for (const row of rows as Record<string, string>[]) {
      const tableName = Object.values(row)[0] ?? '';
      if (!tableName) continue;
      const [cols] = await pool.query(`SHOW COLUMNS FROM ${quoteIdent(tableName)}`);
      tables.push({
        id: tableName,
        name: tableName,
        columns: (cols as { Field: string; Type: string; Null: string; Key: string }[]).map((c) => ({
          id: `${tableName}.${c.Field}`,
          name: c.Field,
          type: 'text' as const,
          constraints: { nullable: c.Null === 'YES', unique: c.Key === 'UNI', primaryKey: c.Key === 'PRI' },
        })),
        indexes: [],
      });
    }
    return tables;
  }

  /** Foreign key del DB (per l'ER diagram). MySQL espone il lato referenced
   *  per-colonna in KEY_COLUMN_USAGE → niente cartesiano sulle FK composite. */
  async introspectRelations(): Promise<Relation[]> {
    const pool = this.requirePool();
    const [rows] = await pool.query(`
      SELECT
        kcu.TABLE_NAME            AS from_table,
        kcu.COLUMN_NAME           AS from_column,
        kcu.REFERENCED_TABLE_NAME AS to_table,
        kcu.REFERENCED_COLUMN_NAME AS to_column,
        rc.DELETE_RULE            AS on_delete
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL AND kcu.TABLE_SCHEMA = DATABASE()
      ORDER BY from_table, from_column, kcu.ORDINAL_POSITION
    `);
    return fkRowsToRelations((rows as { from_table: string; from_column: string; to_table: string; to_column: string; on_delete: string }[]).map((r) => ({
      fromTable: r.from_table, fromColumn: r.from_column,
      toTable: r.to_table, toColumn: r.to_column, onDelete: r.on_delete,
    })));
  }
}
