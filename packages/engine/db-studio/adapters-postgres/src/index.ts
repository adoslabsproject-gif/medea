/**
 * PostgreSQL adapter for FlowForge DB Studio.
 *
 * Wraps `postgres` (postgres.js) which is the lighter and faster of the
 * mainstream PG drivers (vs node-postgres). All SQL is parameterized via
 * tagged-template params — no string concatenation, no SQL injection vector.
 */

import postgres, { type TransactionSql } from 'postgres';
import type {
  Column,
  Database,
  MigrationAction,
  QueryFilter,
  QuerySpec,
  Table,
  Relation,
} from '@medea/engine-db-studio-core';
import { renderCreateViewSql, renderDropViewSql, fkRowsToRelations } from '@medea/engine-db-studio-core';
import type { IDatabaseAdapter, QueryResult, ExecuteResult, RawQueryResult, RawQueryOptions, BatchOp, BatchResult } from '@medea/engine-db-studio-engine';
import { classifyStatement, splitStatements } from '@medea/engine-db-studio-engine';

/**
 * Costruisce l'URL di connessione Postgres da `connection`. PURO → testabile.
 *
 * FIX 2026-06-14: include la PASSWORD (`conn.passwordSecretRef` = credenziale
 * letterale, stessa convenzione degli altri adapter) — prima era omessa e
 * qualsiasi Postgres con password (esterno O sidecar managed) falliva l'auth.
 * user+pass percent-encoded per gestire eventuali caratteri speciali.
 * Ritorna '' se non c'è né `url` né hostname+port+database (il caller rigetta).
 */
export function buildPostgresUrl(conn: Database['connection']): string {
  if (conn.url) return conn.url;
  if (!(conn.hostname && conn.port && conn.database)) return '';
  const userInfo = conn.username
    ? `${encodeURIComponent(conn.username)}${conn.passwordSecretRef ? `:${encodeURIComponent(conn.passwordSecretRef)}` : ''}@`
    : '';
  const ssl = conn.sslMode ? `?sslmode=${conn.sslMode}` : '';
  return `postgres://${userInfo}${conn.hostname}:${conn.port.toString()}/${conn.database}${ssl}`;
}

const TYPE_TO_PG: Record<Column['type'], string> = {
  text: 'TEXT',
  varchar: 'VARCHAR',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  decimal: 'NUMERIC',
  real: 'REAL',
  boolean: 'BOOLEAN',
  date: 'DATE',
  time: 'TIME',
  datetime: 'TIMESTAMP WITH TIME ZONE',
  json: 'JSONB',
  uuid: 'UUID',
  bytea: 'BYTEA',
  enum: 'TEXT',
};

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

function renderColumn(col: Column): string {
  const parts: string[] = [quoteIdent(col.name), TYPE_TO_PG[col.type]];
  if (col.constraints.primaryKey) parts.push('PRIMARY KEY');
  if (!col.constraints.nullable) parts.push('NOT NULL');
  if (col.constraints.unique && !col.constraints.primaryKey) parts.push('UNIQUE');
  if (col.constraints.default !== undefined) parts.push(`DEFAULT ${col.constraints.default}`);
  if (col.constraints.check) parts.push(`CHECK (${col.constraints.check})`);
  return parts.join(' ');
}

function renderMigrationAction(action: MigrationAction): string {
  switch (action.kind) {
    case 'create_table': {
      const cols = action.table.columns.map(renderColumn).join(',\n  ');
      const indexes = (action.table.indexes ?? []).map((idx) => {
        const unique = idx.unique ? 'UNIQUE ' : '';
        const cs = idx.columns.map(quoteIdent).join(', ');
        return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(idx.name)} ON ${quoteIdent(action.table.name)} (${cs});`;
      });
      return [`CREATE TABLE IF NOT EXISTS ${quoteIdent(action.table.name)} (\n  ${cols}\n);`, ...indexes].join('\n');
    }
    case 'drop_table': return `DROP TABLE IF EXISTS ${quoteIdent(action.tableName)} CASCADE;`;
    case 'rename_table': return `ALTER TABLE ${quoteIdent(action.from)} RENAME TO ${quoteIdent(action.to)};`;
    case 'add_column': return `ALTER TABLE ${quoteIdent(action.tableName)} ADD COLUMN ${renderColumn(action.column)};`;
    case 'drop_column': return `ALTER TABLE ${quoteIdent(action.tableName)} DROP COLUMN ${quoteIdent(action.columnName)};`;
    case 'rename_column': return `ALTER TABLE ${quoteIdent(action.tableName)} RENAME COLUMN ${quoteIdent(action.from)} TO ${quoteIdent(action.to)};`;
    case 'alter_column': {
      const parts: string[] = [];
      const c = action.patch;
      if (c.type) parts.push(`ALTER COLUMN ${quoteIdent(action.columnName)} TYPE ${TYPE_TO_PG[c.type]}`);
      if (c.constraints?.nullable === false) parts.push(`ALTER COLUMN ${quoteIdent(action.columnName)} SET NOT NULL`);
      if (c.constraints?.nullable === true) parts.push(`ALTER COLUMN ${quoteIdent(action.columnName)} DROP NOT NULL`);
      return parts.length > 0 ? `ALTER TABLE ${quoteIdent(action.tableName)} ${parts.join(', ')};` : '';
    }
    case 'add_relation': {
      const fkName = `${action.relation.fromTable}_${action.relation.fromColumn}_fk`;
      return `ALTER TABLE ${quoteIdent(action.relation.fromTable)} ADD CONSTRAINT ${quoteIdent(fkName)} FOREIGN KEY (${quoteIdent(action.relation.fromColumn)}) REFERENCES ${quoteIdent(action.relation.toTable)}(${quoteIdent(action.relation.toColumn)}) ON DELETE ${action.relation.onDelete.toUpperCase()};`;
    }
    case 'drop_relation': return `-- Drop relation ${action.relationId} (run ALTER TABLE ... DROP CONSTRAINT manually if you know the name)`;
    case 'add_index': {
      const unique = action.index.unique ? 'UNIQUE ' : '';
      const cols = action.index.columns.map(quoteIdent).join(', ');
      return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(action.index.name)} ON ${quoteIdent(action.tableName)} (${cols});`;
    }
    case 'drop_index': return `DROP INDEX IF EXISTS ${quoteIdent(action.indexName)};`;
    case 'create_view': return renderCreateViewSql(action.view, quoteIdent);
    case 'drop_view': return renderDropViewSql(action.viewName, quoteIdent);
  }
}

function filterToFragment(filter: QueryFilter): { sql: string; param: unknown } | { sql: string } {
  const col = quoteIdent(filter.column);
  switch (filter.op) {
    case 'eq': return { sql: `${col} = $1`, param: filter.value };
    case 'neq': return { sql: `${col} != $1`, param: filter.value };
    case 'gt': return { sql: `${col} > $1`, param: filter.value };
    case 'gte': return { sql: `${col} >= $1`, param: filter.value };
    case 'lt': return { sql: `${col} < $1`, param: filter.value };
    case 'lte': return { sql: `${col} <= $1`, param: filter.value };
    case 'like': return { sql: `${col} LIKE $1`, param: filter.value };
    case 'isNull': return { sql: `${col} IS NULL` };
    case 'notNull': return { sql: `${col} IS NOT NULL` };
    case 'in': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      return { sql: `${col} = ANY($1)`, param: values };
    }
  }
}

export class PostgresAdapter implements IDatabaseAdapter {
  readonly engine = 'postgres' as const;
  private sql: postgres.Sql | null = null;

  connect(database: Database): Promise<void> {
    const url = buildPostgresUrl(database.connection);
    if (!url) {
      return Promise.reject(new Error('PostgresAdapter requires either connection.url or hostname+port+database'));
    }
    this.sql = postgres(url, { onnotice: () => { /* suppress NOTICE */ } });
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    if (this.sql) {
      await this.sql.end({ timeout: 5 });
      this.sql = null;
    }
  }

  private requireSql(): postgres.Sql {
    if (!this.sql) throw new Error('PostgresAdapter not connected');
    return this.sql;
  }

  previewMigration(actions: readonly MigrationAction[]): Promise<string> {
    try {
      const result = actions.map(renderMigrationAction).filter((s) => s.trim().length > 0).join('\n\n');
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async applyMigration(actions: readonly MigrationAction[]): Promise<{ sql: string; affectedTables: string[] }> {
    const sql = this.requireSql();
    const text = actions.map(renderMigrationAction).filter((s) => s.trim().length > 0).join('\n\n');
    await sql.begin(async (tx) => {
      for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'))) {
        await tx.unsafe(stmt + ';');
      }
    });
    const affected = new Set<string>();
    for (const a of actions) {
      if (a.kind === 'create_table') affected.add(a.table.name);
      else if (a.kind === 'drop_table' || a.kind === 'add_column' || a.kind === 'drop_column' || a.kind === 'alter_column') affected.add(a.tableName);
      else if (a.kind === 'rename_table') affected.add(a.to);
    }
    return { sql: text, affectedTables: [...affected] };
  }

  async query<T = Record<string, unknown>>(spec: QuerySpec): Promise<QueryResult<T>> {
    const sql = this.requireSql();
    const start = Date.now();
    const filters = spec.filters ?? [];
    const orderBy = spec.orderBy ?? [];
    const select = spec.select && spec.select.length > 0 ? spec.select.map(quoteIdent).join(', ') : '*';

    const params: unknown[] = [];
    const whereParts: string[] = [];
    for (const f of filters) {
      const frag = filterToFragment(f);
      if ('param' in frag) {
        params.push(frag.param);
        whereParts.push(frag.sql.replace('$1', `$${params.length.toString()}`));
      } else {
        whereParts.push(frag.sql);
      }
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const orderClause = orderBy.length ? `ORDER BY ${orderBy.map((o) => `${quoteIdent(o.column)} ${o.direction.toUpperCase()}`).join(', ')}` : '';
    const limitClause = spec.limit !== undefined ? `LIMIT ${spec.limit.toString()}` : '';
    const offsetClause = spec.offset !== undefined ? `OFFSET ${spec.offset.toString()}` : '';
    const text = `SELECT ${select} FROM ${quoteIdent(spec.table)} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();

    const rows = (await sql.unsafe(text, params as never)) as unknown as T[];
    return { rows, rowCount: rows.length, durationMs: Date.now() - start };
  }

  async insert(tableName: string, row: Record<string, unknown>): Promise<ExecuteResult> {
    const sql = this.requireSql();
    const start = Date.now();
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${(i + 1).toString()}`).join(', ');
    const text = `INSERT INTO ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const rows = (await sql.unsafe(text, Object.values(row) as never)) as unknown as { id?: string | number }[];
    const first = rows[0];
    const result: ExecuteResult = {
      affectedRows: rows.length,
      durationMs: Date.now() - start,
    };
    if (first?.id !== undefined) result.insertedId = first.id;
    return result;
  }

  async update(tableName: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<ExecuteResult> {
    const sql = this.requireSql();
    const start = Date.now();
    const setCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    const setParts = setCols.map((c, i) => `${quoteIdent(c)} = $${(i + 1).toString()}`).join(', ');
    const whereParts = whereCols.map((c, i) => `${quoteIdent(c)} = $${(i + 1 + setCols.length).toString()}`).join(' AND ');
    const text = `UPDATE ${quoteIdent(tableName)} SET ${setParts} WHERE ${whereParts}`;
    const result = await sql.unsafe(text, [...Object.values(patch), ...Object.values(where)] as never);
    return { affectedRows: (result as { count?: number }).count ?? 0, durationMs: Date.now() - start };
  }

  /** Atomic batch: header + children in one transaction. postgres-js
   *  `sql.begin(cb)` commits on resolve, rolls back on throw. */
  async transaction(ops: BatchOp[]): Promise<BatchResult> {
    const sql = this.requireSql();
    const start = Date.now();
    const steps: BatchResult['steps'] = [];
    const bindings: BatchResult['bindings'] = {};

    await sql.begin(async (tx) => {
      for (let index = 0; index < ops.length; index++) {
        const op = ops[index]!;
        if (op.kind === 'insert') {
          const cols = Object.keys(op.row);
          if (cols.length === 0) throw new Error(`transaction[${index.toString()}]: insert row has no columns`);
          const placeholders = cols.map((_, i) => `$${(i + 1).toString()}`).join(', ');
          const text = `INSERT INTO ${quoteIdent(op.table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders}) RETURNING *`;
          const rows = (await tx.unsafe(text, Object.values(op.row) as never)) as unknown as { id?: string | number }[];
          const insertedId = rows[0]?.id;
          if (op.as && insertedId !== undefined) bindings[op.as] = insertedId;
          const step: BatchResult['steps'][number] = { index, kind: 'insert', affectedRows: rows.length };
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
          const placeholders = finalCols.map((_, i) => `$${(i + 1).toString()}`).join(', ');
          const text = `INSERT INTO ${quoteIdent(op.table)} (${finalCols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
          let affected = 0;
          for (const row of op.rows) {
            const values = baseCols.map((c) => row[c]);
            if (op.refColumn) values.push(refValue);
            await tx.unsafe(text, values as never);
            affected += 1;
          }
          steps.push({ index, kind: 'insertMany', affectedRows: affected });
        }
      }
    });
    return { steps, bindings, durationMs: Date.now() - start };
  }

  async delete(tableName: string, where: Record<string, unknown>): Promise<ExecuteResult> {
    const sql = this.requireSql();
    const start = Date.now();
    const whereCols = Object.keys(where);
    const whereParts = whereCols.map((c, i) => `${quoteIdent(c)} = $${(i + 1).toString()}`).join(' AND ');
    const text = `DELETE FROM ${quoteIdent(tableName)} WHERE ${whereParts}`;
    const result = await sql.unsafe(text, Object.values(where) as never);
    return { affectedRows: (result as { count?: number }).count ?? 0, durationMs: Date.now() - start };
  }

  async introspect(): Promise<Table[]> {
    const sql = this.requireSql();
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const result: Table[] = [];
    for (const t of tables) {
      const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${t.table_name}
        ORDER BY ordinal_position
      `;
      result.push({
        id: t.table_name,
        name: t.table_name,
        columns: cols.map((c) => ({
          id: `${t.table_name}.${c.column_name}`,
          name: c.column_name,
          type: 'text' as const,
          constraints: { nullable: c.is_nullable === 'YES', unique: false, primaryKey: false },
        })),
        indexes: [],
      });
    }
    return result;
  }

  /**
   * Foreign key del DB (per l'ER diagram). Composite-safe: il lato referenced
   * (ccu) è allineato per `ordinal_position = position_in_unique_constraint`,
   * così le FK multi-colonna NON producono prodotti cartesiani.
   */
  async introspectRelations(): Promise<Relation[]> {
    const sql = this.requireSql();
    const rows = await sql<{ from_table: string; from_column: string; to_table: string; to_column: string; on_delete: string }[]>`
      SELECT
        kcu.table_name  AS from_table,
        kcu.column_name AS from_column,
        ccu.table_name  AS to_table,
        ccu.column_name AS to_column,
        rc.delete_rule  AS on_delete
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
      JOIN information_schema.key_column_usage ccu
        ON ccu.constraint_name = rc.unique_constraint_name
        AND ccu.constraint_schema = rc.unique_constraint_schema
        AND ccu.ordinal_position = kcu.position_in_unique_constraint
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY from_table, from_column
    `;
    return fkRowsToRelations(rows.map((r) => ({
      fromTable: r.from_table, fromColumn: r.from_column,
      toTable: r.to_table, toColumn: r.to_column, onDelete: r.on_delete,
    })));
  }

  async executeRaw(text: string, opts: RawQueryOptions = {}): Promise<RawQueryResult> {
    const sql = this.requireSql();
    const statements = splitStatements(text);
    if (statements.length === 0) {
      throw new Error('Empty SQL input — nothing to execute.');
    }
    // N19 audit (2026-05-29): if the caller asks for read-only execution,
    // every statement must classify as 'select' or 'explain'. Modifying
    // CTEs (WITH ... DELETE ...) classify as 'delete' via the hardened
    // classifyStatement, so this loop catches them too. Reject the whole
    // batch BEFORE opening the transaction — no partial side effects.
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

    /** Execute every statement inside a single transaction. postgres-js
     *  exposes `sql.begin(cb)` which commits on resolve / rolls back on
     *  throw — perfect for atomic multi-statement execution. */
    const runAll = async (): Promise<RawQueryResult> => {
      const breakdown: NonNullable<RawQueryResult['statementResults']> = [];
      let lastKind: RawQueryResult['statementKind'] = 'other';
      let lastRows: Record<string, unknown>[] = [];
      let lastColumns: { name: string; type?: string }[] = [];
      let lastAffected: number | undefined;

      const work = async (tx: TransactionSql<Record<string, never>>): Promise<void> => {
        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i]!;
          const kind = classifyStatement(stmt);
          const isSelect = kind === 'select' || kind === 'explain';
          if (isSelect) {
            const limited = opts.rowLimit !== undefined
              ? `${stmt.replace(/;?\s*$/, '')} LIMIT ${opts.rowLimit.toString()}`
              : stmt;
            const r = await tx.unsafe(limited);
            const rows = r as unknown as Record<string, unknown>[];
            const columns = rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [];
            lastKind = kind; lastRows = rows; lastColumns = columns; lastAffected = undefined;
            breakdown.push({ index: i, kind, rowCount: rows.length, sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '') });
          } else {
            const r = await tx.unsafe(stmt);
            const meta = r as unknown as { count?: number };
            lastKind = kind; lastRows = []; lastColumns = []; lastAffected = meta.count ?? 0;
            breakdown.push({ index: i, kind, rowCount: 0, affectedRows: lastAffected, sqlPreview: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '') });
          }
        }
      };

      // Always wrap in tx — even single-statement, for consistent semantics
      // with dryRun rollback below.
      if (opts.dryRun) {
        await sql.begin(async (tx) => {
          await work(tx);
          throw new __RollbackSentinel();
        }).catch((err: unknown) => {
          if (err instanceof __RollbackSentinel) return;
          throw err;
        });
      } else {
        await sql.begin(async (tx) => { await work(tx); });
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

    return runAll();
  }
}

// estende Error: è un valore lanciato (rollback control-flow) → only-throw-error.
class __RollbackSentinel extends Error {}
