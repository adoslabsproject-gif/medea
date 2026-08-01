/**
 * DB schema migration tools (write) — ALTER TABLE / CREATE TABLE reali.
 *
 * Ogni op è idempotent-friendly: il DbStudio adapter short-circuita no-op.
 * Cross-tenant blocked dal DbStudioService (WHERE tenant_id = ?).
 *
 * - createTableHandler:    CREATE TABLE via applyMigration
 * - addColumnHandler:      ALTER TABLE ... ADD COLUMN
 * - dropColumnHandler:     ALTER TABLE ... DROP COLUMN (destructive)
 * - dropTableHandler:      DROP TABLE (gated da confirmTableName)
 * - renameColumnHandler:   not supported uniformemente (suggerisce workaround)
 * - addIndexHandler:       CREATE INDEX
 *
 * Estratto da ai-scaffold.service.ts (refactor 2026-05-28).
 */

import { coerceString } from '@/lib/coerce.js';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import type { ToolResult } from '@/services/ai-scaffold/types.js';
import { normalizeColumnType, normalizeConstraints } from '@/services/ai-scaffold/node-catalog.js';
import { logger } from '@/lib/logger.js';

/**
 * createDatabaseHandler — crea un nuovo database SQLite locale del tenant.
 *
 * Bug fix 2026-05-29: Liara faceva abort quando l'utente non aveva DB
 * configurati (es. nuovo workspace). Adesso lo scaffold puo\` creare un
 * DB SQLite locale on-demand (no setup esterno richiesto).
 *
 * args:
 *   - name (string, required): nome del database (es. "workflow_data")
 *   - description (string, optional)
 *
 * NB: il `kind: 'sqlite'` adapter NON richiede credenziali host/port —
 * SQLite vive nel volume tenant. Per Postgres/MySQL servono credentials
 * esplicite e il flusso e\` UI-only.
 */
export function createDatabaseHandler(session: ScaffoldSession, args: Record<string, unknown>): Promise<ToolResult> {
  const name = coerceString(args.name ?? '').trim();
  if (!name) return Promise.resolve({ ok: false, error: 'create_database richiede "name" (es. "workflow_data")' });
  if (!/^[a-z][a-z0-9_]{0,62}$/i.test(name)) {
    return Promise.resolve({ ok: false, error: 'name deve iniziare con lettera, max 63 char, solo [a-zA-Z0-9_]' });
  }
  const description = typeof args.description === 'string'
    ? (args.description)
    : 'Database creato da AI scaffold';
  try {
    const created = session.dbStudio.create({
      tenantId: session.tenantId,
      name,
      description,
      // SQLite embedded — il path file e\` derivato dal adapter (no host/port).
      connection: { engine: 'sqlite', embedded: true },
      tables: [],
      relations: [],
    });
    logger.info({ databaseId: created.id, name, tenantId: session.tenantId }, '[SCAFFOLD] database created');
    return Promise.resolve({ ok: true, data: { databaseId: created.id, name: created.name } });
  } catch (e) {
    return Promise.resolve({ ok: false, error: `create_database fallita: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export async function createTableHandler(session: ScaffoldSession, args: Record<string, unknown>): Promise<ToolResult> {
  const databaseId = coerceString(args.databaseId ?? '');
  const table = args.table as { name?: unknown; columns?: unknown };
  if (!databaseId || !table || typeof table !== 'object') {
    return { ok: false, error: 'create_table richiede databaseId + table { name, columns: [...] }' };
  }
  if (typeof table.name !== 'string') return { ok: false, error: 'table.name mancante o non stringa' };
  if (!Array.isArray(table.columns) || table.columns.length === 0) return { ok: false, error: 'table.columns deve essere un array non vuoto' };
  const tableName: string = table.name;
  try {
    await session.dbStudio.applyMigration(databaseId, [{
      kind: 'create_table',
      table: {
        id: tableName,
        name: tableName,
        columns: (table.columns as unknown[]).map((c) => {
          const col = c as { name?: unknown; type?: unknown; constraints?: unknown };
          return {
            id: `${tableName}.${String(col.name)}`,
            name: String(col.name),
            type: normalizeColumnType(col.type),
            constraints: normalizeConstraints(col.constraints),
          };
        }),
        indexes: [],
      },
    }], session.tenantId);
    return { ok: true, data: { created: tableName } };
  } catch (e) {
    return { ok: false, error: `create_table fallita: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function addColumnHandler(session: ScaffoldSession, args: Record<string, unknown>): Promise<ToolResult> {
  const databaseId = coerceString(args.databaseId ?? '');
  const tableName = coerceString(args.table ?? '');
  const column = args.column as { name?: unknown; type?: unknown; constraints?: unknown };
  if (!databaseId || !tableName || !column || typeof column.name !== 'string') {
    return { ok: false, error: 'add_column richiede databaseId, table, column { name, type, constraints? }' };
  }
  try {
    await session.dbStudio.applyMigration(databaseId, [{
      kind: 'add_column',
      tableName,
      column: {
        id: `${tableName}.${String(column.name)}`,
        name: String(column.name),
        type: normalizeColumnType(column.type),
        constraints: normalizeConstraints(column.constraints),
      },
    }], session.tenantId);
    return { ok: true, data: { added: `${tableName}.${String(column.name)}` } };
  } catch (e) {
    return { ok: false, error: `add_column fallita: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function dropColumnHandler(session: ScaffoldSession, args: Record<string, unknown>): Promise<ToolResult> {
  const databaseId = coerceString(args.databaseId ?? '');
  const tableName = coerceString(args.table ?? '');
  const columnName = coerceString(args.columnName ?? args.column ?? '');
  if (!databaseId || !tableName || !columnName) return { ok: false, error: 'drop_column richiede databaseId, table, columnName.' };
  try {
    await session.dbStudio.applyMigration(databaseId, [{ kind: 'drop_column', tableName, columnName }], session.tenantId);
    logger.info({ tenantId: session.tenantId, databaseId, tableName, columnName }, 'ai-scaffold: drop_column');
    return { ok: true, data: { dropped: `${tableName}.${columnName}` } };
  } catch (e) {
    return { ok: false, error: `drop_column fallito: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function dropTableHandler(session: ScaffoldSession, args: Record<string, unknown>): Promise<ToolResult> {
  const databaseId = coerceString(args.databaseId ?? '');
  const tableName = coerceString(args.tableName ?? args.table ?? '');
  const confirm = coerceString(args.confirmTableName ?? '');
  if (!databaseId || !tableName) return { ok: false, error: 'drop_table richiede databaseId, tableName.' };
  if (confirm !== tableName) return { ok: false, error: `Per drop_table devi passare confirmTableName="${tableName}" — è una operazione DISTRUTTIVA non reversibile.` };
  try {
    await session.dbStudio.applyMigration(databaseId, [{ kind: 'drop_table', tableName }], session.tenantId);
    logger.warn({ tenantId: session.tenantId, databaseId, tableName }, 'ai-scaffold: DROP TABLE');
    return { ok: true, data: { dropped: tableName } };
  } catch (e) {
    return { ok: false, error: `drop_table fallito: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// rename_column non supportato uniformemente (SQLite/generic). L'agente usa
// workaround: add_column + db_query → db_insert + drop_column.
export function renameColumnHandler(_session: ScaffoldSession, _args: Record<string, unknown>): ToolResult {
  return {
    ok: false,
    error: 'rename_column non supportato uniformemente da tutti gli engine DB. Workaround: usa add_column con il nuovo nome, esegui un workflow di copia (db_query → db_insert), poi drop_column del nome vecchio.',
  };
}

export async function addIndexHandler(session: ScaffoldSession, args: Record<string, unknown>): Promise<ToolResult> {
  const databaseId = coerceString(args.databaseId ?? '');
  const tableName = coerceString(args.table ?? '');
  const indexName = coerceString(args.indexName ?? args.name ?? '');
  const columnsArg = args.columns;
  if (!databaseId || !tableName || !indexName || !Array.isArray(columnsArg) || columnsArg.length === 0) {
    return { ok: false, error: 'add_index richiede databaseId, table, indexName, columns: [...].' };
  }
  const columns = columnsArg.filter((c): c is string => typeof c === 'string');
  if (columns.length === 0) return { ok: false, error: 'columns deve essere un array di nomi colonna stringa.' };
  try {
    await session.dbStudio.applyMigration(databaseId, [{
      kind: 'add_index',
      tableName,
      index: { id: indexName, name: indexName, columns, unique: args.unique === true },
    }], session.tenantId);
    return { ok: true, data: { created: indexName, on: `${tableName}(${columns.join(', ')})` } };
  } catch (e) {
    return { ok: false, error: `add_index fallito: ${e instanceof Error ? e.message : String(e)}` };
  }
}
