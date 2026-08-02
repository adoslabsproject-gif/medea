/**
 * Tool DB-agent di SCRITTURA SCHEMA: create_database, create_table,
 * add_column, drop_column, drop_table, add_index.
 *
 * Ogni operazione su un DB esistente passa per `loadOwnedDatabase` (guardia
 * tenant) e poi per `DbStudioService.applyMigration(id, actions, ctx.tenantId)`
 * — doppio confine tenant. Le DROP sono distruttive e richiedono conferma
 * esplicita negli argomenti (no "oops").
 *
 * @module services/db-agent/tools/write-schema
 */
import { z } from 'zod';
import type { MigrationAction, Table } from '@medea/engine-db-studio-core';
import type { DbAgentToolDef } from '../tool-types.js';
import { loadOwnedDatabase } from '../guard.js';
import { ConfirmationRequiredError, ToolValidationError } from '../errors.js';
import { ColumnInputSchema, buildColumn } from '../columns.js';
import { createTenantDatabase, CreateDatabaseError } from '@/services/db-studio/create-database.js';

const NAME = /^[a-z_][a-z0-9_]*$/;

// Engine creabili dal tool: embedded (zero-config) + managed (sidecar nel tenant).
// Gli esterni con credenziali NON sono qui di proposito: il modello non inventa
// host/password — quelli passano dal form UI.
const CREATABLE_ENGINES = [
  'sqlite', 'duckdb', 'vector-embedded', // embedded
  'postgres', 'pgvector', 'mysql', 'mssql', 'mongodb', 'redis', 'qdrant', // managed
] as const;

const CreateDatabaseSchema = z
  .object({
    name: z.string().regex(NAME).max(63),
    description: z.string().max(500).optional(),
    engine: z.enum(CREATABLE_ENGINES).optional(),
    // managed=true installa un container DB nel tenant (consuma quota). Richiede
    // il consenso scritture (ctx.allowWrites): è un'azione che alloca risorse.
    managed: z.boolean().optional(),
  })
  .strict();

const createDatabaseTool: DbAgentToolDef = {
  name: 'create_database',
  description: 'Crea un database nel workspace. engine: sqlite (default, embedded zero-config), duckdb, vector-embedded, oppure managed (postgres/pgvector/mysql/mssql/mongodb/redis/qdrant) con managed=true (installa un sidecar nel tenant, richiede il consenso scritture).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'snake_case, max 63 char' },
      description: { type: 'string' },
      engine: { type: 'string', enum: [...CREATABLE_ENGINES], description: 'default sqlite' },
      managed: { type: 'boolean', description: 'true = installa il server DB nel tenant (postgres/mongodb/…)' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  schema: CreateDatabaseSchema,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof CreateDatabaseSchema>;
    const engine = a.engine ?? 'sqlite';
    const managed = a.managed === true;
    // Gate human-in-the-loop: installare un container DB alloca risorse/quota →
    // come le scritture, va abilitato esplicitamente dall'utente (mai dall'LLM).
    if (managed && !ctx.allowWrites) {
      throw new ConfirmationRequiredError(`Installare un database "${engine}" nel tenant consuma quota e crea un container: abilita "Consenti modifiche" per procedere.`);
    }
    try {
      const created = await createTenantDatabase({
        tenantId: ctx.tenantId,
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        engine,
        managed,
        dbStudio: ctx.dbStudio,
      });
      return { databaseId: created.id, name: created.name, engine, managed };
    } catch (err) {
      // Errore d'INPUT (engine non installabile / che richiede credenziali) →
      // validazione azionabile per il modello, non un 'INTERNAL' opaco. Il
      // provisioning fallito (ManagedDbError) resta INTERNAL (infra), propagato.
      if (err instanceof CreateDatabaseError) throw new ToolValidationError(err.message);
      throw err;
    }
  },
};

const CreateTableSchema = z
  .object({
    databaseId: z.string().min(1),
    name: z.string().regex(NAME).max(63),
    columns: z.array(ColumnInputSchema).min(1),
  })
  .strict();

const createTableTool: DbAgentToolDef = {
  name: 'create_table',
  description: 'Crea una tabella in un database del workspace. columns: [{name, type, constraints?}].',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      name: { type: 'string', description: 'snake_case' },
      columns: { type: 'array', items: { type: 'object' }, description: '[{name,type,constraints?}]' },
    },
    required: ['databaseId', 'name', 'columns'],
    additionalProperties: false,
  },
  schema: CreateTableSchema,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof CreateTableSchema>;
    loadOwnedDatabase(ctx, a.databaseId);
    const table: Table = {
      id: a.name,
      name: a.name,
      columns: a.columns.map((col) => buildColumn(a.name, col)),
      indexes: [],
    };
    await ctx.dbStudio.applyMigration(a.databaseId, [{ kind: 'create_table', table }], ctx.tenantId);
    return { created: a.name, columns: table.columns.length };
  },
};

const AddColumnSchema = z
  .object({ databaseId: z.string().min(1), table: z.string().min(1), column: ColumnInputSchema })
  .strict();

const addColumnTool: DbAgentToolDef = {
  name: 'add_column',
  description: 'Aggiunge una colonna a una tabella esistente. column: {name, type, constraints?}.',
  parameters: {
    type: 'object',
    properties: { databaseId: { type: 'string' }, table: { type: 'string' }, column: { type: 'object' } },
    required: ['databaseId', 'table', 'column'],
    additionalProperties: false,
  },
  schema: AddColumnSchema,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof AddColumnSchema>;
    loadOwnedDatabase(ctx, a.databaseId);
    const action: MigrationAction = { kind: 'add_column', tableName: a.table, column: buildColumn(a.table, a.column) };
    await ctx.dbStudio.applyMigration(a.databaseId, [action], ctx.tenantId);
    return { added: `${a.table}.${a.column.name}` };
  },
};

const DropColumnSchema = z
  .object({ databaseId: z.string().min(1), table: z.string().min(1), columnName: z.string().min(1), confirm: z.boolean() })
  .strict();

const dropColumnTool: DbAgentToolDef = {
  name: 'drop_column',
  description: 'Rimuove una colonna (DISTRUTTIVO). Richiede confirm=true.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      table: { type: 'string' },
      columnName: { type: 'string' },
      confirm: { type: 'boolean', description: 'deve essere true: operazione irreversibile' },
    },
    required: ['databaseId', 'table', 'columnName', 'confirm'],
    additionalProperties: false,
  },
  schema: DropColumnSchema,
  destructive: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof DropColumnSchema>;
    if (!a.confirm) {
      throw new ConfirmationRequiredError(`drop_column è distruttivo: passa confirm=true per rimuovere "${a.table}.${a.columnName}".`);
    }
    loadOwnedDatabase(ctx, a.databaseId);
    await ctx.dbStudio.applyMigration(a.databaseId, [{ kind: 'drop_column', tableName: a.table, columnName: a.columnName }], ctx.tenantId);
    return { dropped: `${a.table}.${a.columnName}` };
  },
};

const DropTableSchema = z
  .object({ databaseId: z.string().min(1), tableName: z.string().min(1), confirmTableName: z.string().min(1) })
  .strict();

const dropTableTool: DbAgentToolDef = {
  name: 'drop_table',
  description: 'Elimina una tabella (DISTRUTTIVO). confirmTableName deve combaciare ESATTAMENTE con tableName.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      tableName: { type: 'string' },
      confirmTableName: { type: 'string', description: 'rieco esatto di tableName' },
    },
    required: ['databaseId', 'tableName', 'confirmTableName'],
    additionalProperties: false,
  },
  schema: DropTableSchema,
  destructive: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof DropTableSchema>;
    if (a.confirmTableName !== a.tableName) {
      throw new ConfirmationRequiredError(`drop_table è distruttivo: passa confirmTableName="${a.tableName}" per confermare.`);
    }
    loadOwnedDatabase(ctx, a.databaseId);
    await ctx.dbStudio.applyMigration(a.databaseId, [{ kind: 'drop_table', tableName: a.tableName }], ctx.tenantId);
    return { dropped: a.tableName };
  },
};

const AddIndexSchema = z
  .object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    indexName: z.string().regex(NAME),
    columns: z.array(z.string().min(1)).min(1),
    unique: z.boolean().optional(),
  })
  .strict();

const addIndexTool: DbAgentToolDef = {
  name: 'add_index',
  description: 'Crea un indice su una o più colonne di una tabella (ottimizza le query).',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      table: { type: 'string' },
      indexName: { type: 'string' },
      columns: { type: 'array', items: { type: 'string' } },
      unique: { type: 'boolean' },
    },
    required: ['databaseId', 'table', 'indexName', 'columns'],
    additionalProperties: false,
  },
  schema: AddIndexSchema,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof AddIndexSchema>;
    loadOwnedDatabase(ctx, a.databaseId);
    await ctx.dbStudio.applyMigration(
      a.databaseId,
      [{ kind: 'add_index', tableName: a.table, index: { id: a.indexName, name: a.indexName, columns: a.columns, unique: a.unique ?? false } }],
      ctx.tenantId,
    );
    return { created: a.indexName, on: `${a.table}(${a.columns.join(', ')})` };
  },
};

export const writeSchemaTools: DbAgentToolDef[] = [
  createDatabaseTool,
  createTableTool,
  addColumnTool,
  dropColumnTool,
  dropTableTool,
  addIndexTool,
];
