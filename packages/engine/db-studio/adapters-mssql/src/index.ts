import sql, { type ConnectionPool, type IResult } from 'mssql';
import type { Column, Database, MigrationAction, QueryFilter, QuerySpec, Table, Relation } from '@flowforge/db-studio-core';
import { renderCreateViewSql, renderDropViewSql, fkRowsToRelations } from '@flowforge/db-studio-core';
import type { IDatabaseAdapter, QueryResult, ExecuteResult, RawQueryOptions, RawQueryResult, BatchOp, BatchResult } from '@flowforge/db-studio-engine';
import { classifyStatement, splitStatements } from '@flowforge/db-studio-engine';

const TYPE_TO_TSQL: Record<Column['type'], string> = {
  text: 'NVARCHAR(MAX)',
  varchar: 'NVARCHAR(255)',
  integer: 'INT',
  bigint: 'BIGINT',
  decimal: 'DECIMAL(18,4)',
  real: 'FLOAT',
  boolean: 'BIT',
  date: 'DATE',
  time: 'TIME',
  datetime: 'DATETIME2',
  json: 'NVARCHAR(MAX)',
  uuid: 'UNIQUEIDENTIFIER',
  bytea: 'VARBINARY(MAX)',
  enum: 'NVARCHAR(255)',
};

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return `[${name}]`;
}

function renderColumn(col: Column): string {
  const parts: string[] = [quoteIdent(col.name), TYPE_TO_TSQL[col.type]];
  if (col.constraints.primaryKey) parts.push('PRIMARY KEY');
  if (!col.constraints.nullable) parts.push('NOT NULL');
  if (col.constraints.unique && !col.constraints.primaryKey) parts.push('UNIQUE');
  if (col.constraints.default !== undefined) parts.push(`DEFAULT ${col.constraints.default}`);
  return parts.join(' ');
}

function renderAction(a: MigrationAction): string {
  switch (a.kind) {
    case 'create_table': return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${a.table.name}') CREATE TABLE ${quoteIdent(a.table.name)} (\n  ${a.table.columns.map(renderColumn).join(',\n  ')}\n);`;
    case 'drop_table': return `IF EXISTS (SELECT * FROM sys.tables WHERE name = '${a.tableName}') DROP TABLE ${quoteIdent(a.tableName)};`;
    case 'rename_table': return `EXEC sp_rename '${a.from}', '${a.to}';`;
    case 'add_column': return `ALTER TABLE ${quoteIdent(a.tableName)} ADD ${renderColumn(a.column)};`;
    case 'drop_column': return `ALTER TABLE ${quoteIdent(a.tableName)} DROP COLUMN ${quoteIdent(a.columnName)};`;
    // SQL Server rinomina le colonne via sp_rename (no ALTER RENAME COLUMN).
    case 'rename_column': return `EXEC sp_rename '${a.tableName.replace(/'/gu, "''")}.${a.from.replace(/'/gu, "''")}', '${a.to.replace(/'/gu, "''")}', 'COLUMN';`;
    case 'alter_column': return `-- ALTER COLUMN ${a.columnName} on ${a.tableName} — MSSQL requires ALTER COLUMN syntax; generated manually`;
    case 'add_relation': {
      const fk = `${a.relation.fromTable}_${a.relation.fromColumn}_fk`;
      const cascade = a.relation.onDelete === 'cascade' ? 'CASCADE' : a.relation.onDelete === 'set null' ? 'SET NULL' : 'NO ACTION';
      return `ALTER TABLE ${quoteIdent(a.relation.fromTable)} ADD CONSTRAINT ${quoteIdent(fk)} FOREIGN KEY (${quoteIdent(a.relation.fromColumn)}) REFERENCES ${quoteIdent(a.relation.toTable)}(${quoteIdent(a.relation.toColumn)}) ON DELETE ${cascade};`;
    }
    case 'drop_relation': return `-- drop relation ${a.relationId}`;
    case 'add_index': {
      const uq = a.index.unique ? 'UNIQUE ' : '';
      return `CREATE ${uq}INDEX ${quoteIdent(a.index.name)} ON ${quoteIdent(a.tableName)} (${a.index.columns.map(quoteIdent).join(', ')});`;
    }
    case 'drop_index': return `DROP INDEX ${quoteIdent(a.indexName)} ON ${quoteIdent(a.tableName)};`;
    // NB SQL Server: CREATE VIEW deve essere l'unico statement del batch — il
    // tool create_view manda una sola azione, quindi è rispettato.
    case 'create_view': return renderCreateViewSql(a.view, quoteIdent);
    case 'drop_view': return renderDropViewSql(a.viewName, quoteIdent);
  }
}

function applyFilter(req: sql.Request, filters: readonly QueryFilter[]): string {
  if (filters.length === 0) return '';
  const parts: string[] = [];
  filters.forEach((f, i) => {
    const c = quoteIdent(f.column);
    const p = `p${i.toString()}`;
    switch (f.op) {
      case 'eq': req.input(p, f.value); parts.push(`${c} = @${p}`); break;
      case 'neq': req.input(p, f.value); parts.push(`${c} <> @${p}`); break;
      case 'gt': req.input(p, f.value); parts.push(`${c} > @${p}`); break;
      case 'gte': req.input(p, f.value); parts.push(`${c} >= @${p}`); break;
      case 'lt': req.input(p, f.value); parts.push(`${c} < @${p}`); break;
      case 'lte': req.input(p, f.value); parts.push(`${c} <= @${p}`); break;
      case 'like': req.input(p, f.value); parts.push(`${c} LIKE @${p}`); break;
      case 'isNull': parts.push(`${c} IS NULL`); break;
      case 'notNull': parts.push(`${c} IS NOT NULL`); break;
      case 'in': {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        const placeholders = arr.map((_, idx) => {
          const pp = `${p}_${idx.toString()}`;
          req.input(pp, arr[idx]);
          return `@${pp}`;
        }).join(', ');
        parts.push(`${c} IN (${placeholders})`);
        break;
      }
    }
  });
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

export class MssqlAdapter implements IDatabaseAdapter {
  readonly engine = 'mssql' as const;
  private pool: ConnectionPool | null = null;

  async connect(database: Database): Promise<void> {
    const conn = database.connection;
    this.pool = await sql.connect({
      server: conn.hostname ?? 'localhost',
      port: conn.port ?? 1433,
      database: conn.database ?? '',
      user: conn.username ?? '',
      password: conn.passwordSecretRef ?? '',
      options: { encrypt: conn.sslMode !== 'disable', trustServerCertificate: conn.sslMode === 'require' },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    });
  }

  async disconnect(): Promise<void> {
    await this.pool?.close();
    this.pool = null;
  }

  private requirePool(): ConnectionPool {
    if (!this.pool) throw new Error('MssqlAdapter not connected');
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
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        await transaction.request().batch(stmt);
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
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
    const req = pool.request();
    const where = applyFilter(req, spec.filters ?? []);
    const orderBy = spec.orderBy ?? [];
    const select = spec.select && spec.select.length > 0 ? spec.select.map(quoteIdent).join(', ') : '*';
    const orderClause = orderBy.length ? `ORDER BY ${orderBy.map((o) => `${quoteIdent(o.column)} ${o.direction.toUpperCase()}`).join(', ')}` : 'ORDER BY (SELECT NULL)';
    const limit = spec.limit ?? 1000;
    const offset = spec.offset ?? 0;
    const text = `SELECT ${select} FROM ${quoteIdent(spec.table)} ${where} ${orderClause} OFFSET ${offset.toString()} ROWS FETCH NEXT ${limit.toString()} ROWS ONLY`.trim();
    const result: IResult<unknown> = await req.query(text);
    const rows = result.recordset as T[];
    return { rows, rowCount: rows.length, durationMs: Date.now() - start };
  }

  async insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const req = pool.request();
    const cols = Object.keys(row);
    cols.forEach((c) => {
      req.input(c, row[c]);
    });
    const text = `INSERT INTO ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(', ')}) OUTPUT INSERTED.* VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
    const result = await req.query(text);
    return {
      affectedRows: result.rowsAffected[0] ?? 1,
      durationMs: Date.now() - start,
    };
  }

  async update(tableName: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const req = pool.request();
    const setCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    setCols.forEach((c) => { req.input(`set_${c}`, patch[c]); });
    whereCols.forEach((c) => { req.input(`w_${c}`, where[c]); });
    const text = `UPDATE ${quoteIdent(tableName)} SET ${setCols.map((c) => `${quoteIdent(c)} = @set_${c}`).join(', ')} WHERE ${whereCols.map((c) => `${quoteIdent(c)} = @w_${c}`).join(' AND ')}`;
    const result = await req.query(text);
    return { affectedRows: result.rowsAffected[0] ?? 0, durationMs: Date.now() - start };
  }

  async delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const req = pool.request();
    const whereCols = Object.keys(where);
    whereCols.forEach((c) => { req.input(`w_${c}`, where[c]); });
    const text = `DELETE FROM ${quoteIdent(tableName)} WHERE ${whereCols.map((c) => `${quoteIdent(c)} = @w_${c}`).join(' AND ')}`;
    const result = await req.query(text);
    return { affectedRows: result.rowsAffected[0] ?? 0, durationMs: Date.now() - start };
  }

  /** Atomic batch — mssql.Transaction begin/commit/rollback. */
  async transaction(ops: BatchOp[]): Promise<BatchResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const steps: BatchResult['steps'] = [];
    const bindings: BatchResult['bindings'] = {};
    const tx = pool.transaction();
    await tx.begin();
    try {
      for (let index = 0; index < ops.length; index++) {
        const op = ops[index]!;
        if (op.kind === 'insert') {
          const cols = Object.keys(op.row);
          if (cols.length === 0) throw new Error(`transaction[${index.toString()}]: insert row has no columns`);
          const req = tx.request();
          cols.forEach((c) => req.input(c, op.row[c]));
          const text = `INSERT INTO ${quoteIdent(op.table)} (${cols.map(quoteIdent).join(', ')}) OUTPUT INSERTED.* VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
          const result = await req.query(text);
          const inserted = (result.recordset?.[0] ?? {}) as { id?: string | number };
          // Prefer OUTPUT INSERTED.id (auto-PK + IDENTITY + user-supplied PK
          // alike: SQL Server returns the row that was actually persisted).
          const explicit = op.row.id;
          const insertedId: string | number | undefined = inserted.id
            ?? ((typeof explicit === 'string' || typeof explicit === 'number') ? explicit : undefined);
          if (op.as && insertedId !== undefined) bindings[op.as] = insertedId;
          const step: BatchResult['steps'][number] = { index, kind: 'insert', affectedRows: result.rowsAffected[0] ?? 1 };
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
          let affected = 0;
          for (const row of op.rows) {
            const req = tx.request();
            baseCols.forEach((c) => req.input(c, row[c]));
            if (op.refColumn) req.input(op.refColumn, refValue);
            const text = `INSERT INTO ${quoteIdent(op.table)} (${finalCols.map(quoteIdent).join(', ')}) VALUES (${finalCols.map((c) => `@${c}`).join(', ')})`;
            const result = await req.query(text);
            affected += result.rowsAffected[0] ?? 1;
          }
          steps.push({ index, kind: 'insertMany', affectedRows: affected });
        }
      }
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch { /* ignore */ }
      throw err;
    }
    return { steps, bindings, durationMs: Date.now() - start };
  }

  /**
   * Free-form SQL with multi-statement support.
   *
   * MSSQL specifics:
   *   - The driver uses Tedious; `.batch()` accepts a TSQL batch with GO
   *     separators, but for atomic multi-statement we use `.query()` per
   *     statement inside a `transaction.begin()` block.
   *   - SELECT recordset is exposed via `result.recordset`; columns metadata
   *     via `result.recordset.columns` when available.
   */
  async executeRaw(text: string, opts: RawQueryOptions = {}): Promise<RawQueryResult> {
    const pool = this.requirePool();
    const statements = splitStatements(text);
    if (statements.length === 0) {
      throw new Error('Empty SQL input — nothing to execute.');
    }
    // N19 audit (2026-05-29): readOnly hard-gate (defense-in-depth).
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

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        const kind = classifyStatement(stmt);
        const isSelect = kind === 'select' || kind === 'explain';
        const limited = (isSelect && opts.rowLimit !== undefined)
          ? `${stmt.replace(/;?\s*$/, '')} OFFSET 0 ROWS FETCH NEXT ${opts.rowLimit.toString()} ROWS ONLY`
          : stmt;
        // .query() handles a single TSQL statement; .batch() would allow multiple
        // but rejects GO inside our split chunks. Single-stmt query is the safe path.
        const result = await transaction.request().query(limited);
        if (isSelect) {
          const rows = (result.recordset ?? []) as Record<string, unknown>[];
          const colsMeta = (result.recordset as unknown as { columns?: Record<string, { name?: string; type?: { name?: string } }> } | undefined)?.columns;
          const columns = colsMeta
            ? Object.entries(colsMeta).map(([k, v]) => ({ name: v?.name ?? k, ...(v?.type?.name ? { type: v.type.name } : {}) }))
            : rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [];
          lastKind = kind; lastRows = rows; lastColumns = columns; lastAffected = undefined;
          breakdown.push({ index: i, kind, rowCount: rows.length, sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '') });
        } else {
          lastKind = kind; lastRows = []; lastColumns = []; lastAffected = result.rowsAffected[0] ?? 0;
          breakdown.push({ index: i, kind, rowCount: 0, affectedRows: lastAffected, sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '') });
        }
      }
      if (opts.dryRun) await transaction.rollback();
      else await transaction.commit();
    } catch (err) {
      try { await transaction.rollback(); } catch { /* ignore secondary failure */ }
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
  }

  async introspect(): Promise<Table[]> {
    const pool = this.requirePool();
    const result = await pool.request().query(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    );
    const grouped = new Map<string, { name: string; type: string; nullable: boolean }[]>();
    for (const row of result.recordset as { TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }[]) {
      const arr = grouped.get(row.TABLE_NAME) ?? [];
      arr.push({ name: row.COLUMN_NAME, type: row.DATA_TYPE, nullable: row.IS_NULLABLE === 'YES' });
      grouped.set(row.TABLE_NAME, arr);
    }
    return [...grouped.entries()].map(([name, cols]) => ({
      id: name,
      name,
      columns: cols.map((c) => ({
        id: `${name}.${c.name}`,
        name: c.name,
        type: 'text' as const,
        constraints: { nullable: c.nullable, unique: false, primaryKey: false },
      })),
      indexes: [],
    }));
  }

  /** Foreign key del DB (per l'ER diagram). sys.foreign_key_columns espone il
   *  lato parent E referenced per-colonna → niente cartesiano sulle composite.
   *  delete_referential_action_desc usa underscore (SET_NULL…) → mappato in core. */
  async introspectRelations(): Promise<Relation[]> {
    const pool = this.requirePool();
    const result = await pool.request().query(`
      SELECT
        OBJECT_NAME(fk.parent_object_id)                              AS from_table,
        COL_NAME(fkc.parent_object_id, fkc.parent_column_id)          AS from_column,
        OBJECT_NAME(fk.referenced_object_id)                          AS to_table,
        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id)  AS to_column,
        fk.delete_referential_action_desc                            AS on_delete
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      ORDER BY from_table, from_column, fkc.constraint_column_id
    `);
    return fkRowsToRelations((result.recordset as { from_table: string; from_column: string; to_table: string; to_column: string; on_delete: string }[]).map((r) => ({
      fromTable: r.from_table, fromColumn: r.from_column,
      toTable: r.to_table, toColumn: r.to_column, onDelete: r.on_delete,
    })));
  }
}
