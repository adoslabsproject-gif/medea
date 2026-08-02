/**
 * Tool DB-agent SOLA LETTURA: list_databases, read_db_schema, run_select.
 * Tutti tenant-scoped via il contesto (list per tenant; gli altri via guard).
 *
 * @module services/db-agent/tools/read
 */
import { z } from 'zod';
import type { QuerySpec } from '@medea/engine-db-studio-core';
import type { DbAgentToolDef } from '../tool-types.js';
import { loadOwnedDatabase, assertTableExists } from '../guard.js';

const RUN_SELECT_MAX = 1000;
const RUN_SELECT_DEFAULT = 100;

const listDatabasesTool: DbAgentToolDef = {
  name: 'list_databases',
  description: 'Elenca i database del workspace corrente (solo quelli del tenant). Nessun argomento.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  schema: z.object({}).strict(),
  readOnly: true,
  handler: (ctx) => {
    const dbs = ctx.dbStudio.list(ctx.tenantId);
    return Promise.resolve(
      dbs.map((d) => ({
        id: d.id,
        name: d.name,
        engine: d.connection.engine,
        tableCount: d.tables.length,
      })),
    );
  },
};

const readDbSchemaTool: DbAgentToolDef = {
  name: 'read_db_schema',
  description: 'Legge lo schema (tabelle + colonne) di un database del workspace. Usalo PRIMA di modificare per non sbagliare nomi.',
  parameters: {
    type: 'object',
    properties: { databaseId: { type: 'string', description: 'id del database (da list_databases)' } },
    required: ['databaseId'],
    additionalProperties: false,
  },
  schema: z.object({ databaseId: z.string().min(1) }).strict(),
  readOnly: true,
  handler: (ctx, args) => {
    const { databaseId } = args as { databaseId: string };
    const db = loadOwnedDatabase(ctx, databaseId);
    return Promise.resolve({
      id: db.id,
      name: db.name,
      engine: db.connection.engine,
      tables: db.tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          primaryKey: c.constraints.primaryKey,
          nullable: c.constraints.nullable,
          unique: c.constraints.unique,
        })),
      })),
    });
  },
};

const RunSelectSchema = z
  .object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    select: z.array(z.string().min(1)).optional(),
    filters: z
      .array(
        z
          .object({
            column: z.string().min(1),
            op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'isNull', 'notNull']),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .optional(),
    orderBy: z.array(z.object({ column: z.string().min(1), direction: z.enum(['asc', 'desc']) }).strict()).optional(),
    groupBy: z.array(z.string().min(1)).optional(),
    limit: z.number().int().positive().max(RUN_SELECT_MAX).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

const runSelectTool: DbAgentToolDef = {
  name: 'run_select',
  description: 'Legge righe da una tabella (SELECT strutturata, sola lettura). Filtri/ordinamento opzionali. Cap righe 1000.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      table: { type: 'string' },
      select: { type: 'array', items: { type: 'string' }, description: 'colonne; omesso = tutte' },
      filters: { type: 'array', items: { type: 'object' }, description: '[{column, op, value}]' },
      orderBy: { type: 'array', items: { type: 'object' }, description: '[{column, direction}]' },
      groupBy: { type: 'array', items: { type: 'string' }, description: 'colonne di raggruppamento' },
      limit: { type: 'number', description: `default ${RUN_SELECT_DEFAULT.toString()}, max ${RUN_SELECT_MAX.toString()}` },
      offset: { type: 'number' },
    },
    required: ['databaseId', 'table'],
    additionalProperties: false,
  },
  schema: RunSelectSchema,
  readOnly: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof RunSelectSchema>;
    assertTableExists(ctx, a.databaseId, a.table);
    const spec: QuerySpec = {
      table: a.table,
      filters: a.filters ?? [],
      orderBy: a.orderBy ?? [],
      limit: a.limit ?? RUN_SELECT_DEFAULT,
      ...(a.select ? { select: a.select } : {}),
      ...(a.groupBy ? { groupBy: a.groupBy } : {}),
      ...(a.offset !== undefined ? { offset: a.offset } : {}),
    };
    return ctx.dbStudio.query(a.databaseId, spec, ctx.tenantId);
  },
};

export const readTools: DbAgentToolDef[] = [listDatabasesTool, readDbSchemaTool, runSelectTool];
