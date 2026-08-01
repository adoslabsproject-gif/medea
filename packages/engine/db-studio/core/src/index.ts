import { z } from 'zod';

export const ColumnTypeSchema = z.enum([
  'text',
  'varchar',
  'integer',
  'bigint',
  'decimal',
  'real',
  'boolean',
  'date',
  'time',
  'datetime',
  'json',
  'uuid',
  'bytea',
  'enum',
]);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export const ColumnConstraintsSchema = z.object({
  nullable: z.boolean().default(true),
  unique: z.boolean().default(false),
  primaryKey: z.boolean().default(false),
  default: z.string().optional(),
  check: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
  precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(),
  enumValues: z.array(z.string()).optional(),
});
export type ColumnConstraints = z.infer<typeof ColumnConstraintsSchema>;

export const ColumnSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'Column name must be snake_case'),
  type: ColumnTypeSchema,
  constraints: ColumnConstraintsSchema.default({}),
  description: z.string().optional(),
});
export type Column = z.infer<typeof ColumnSchema>;

export const RelationKindSchema = z.enum(['one-to-one', 'one-to-many', 'many-to-many']);
export type RelationKind = z.infer<typeof RelationKindSchema>;

export const RelationOnDeleteSchema = z.enum(['cascade', 'restrict', 'set null', 'set default', 'no action']);
export type RelationOnDelete = z.infer<typeof RelationOnDeleteSchema>;

export const RelationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: RelationKindSchema,
  fromTable: z.string().min(1),
  fromColumn: z.string().min(1),
  toTable: z.string().min(1),
  toColumn: z.string().min(1),
  onDelete: RelationOnDeleteSchema.default('restrict'),
});
export type Relation = z.infer<typeof RelationSchema>;

export const IndexSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  unique: z.boolean().default(false),
});
export type Index = z.infer<typeof IndexSchema>;

/** VIEW = query di sola lettura salvata con un nome. `select` è SQL grezzo,
 *  validato read-only dal chiamante (tool DB-agent) PRIMA di costruire l'azione. */
export const ViewDefSchema = z.object({
  name: z.string().min(1).max(63),
  select: z.string().min(1),
});
export type ViewDef = z.infer<typeof ViewDefSchema>;

export const TableSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'Table name must be snake_case'),
  description: z.string().optional(),
  columns: z.array(ColumnSchema).min(1),
  indexes: z.array(IndexSchema).default([]),
  layout: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type Table = z.infer<typeof TableSchema>;

export const DatabaseEngineSchema = z.enum([
  'sqlite',
  'postgres',
  'mysql',
  'mssql',
  'mongodb',
  'duckdb',
  'redis',
  'vector-embedded',
  'qdrant',
  'pgvector',
]);
export type DatabaseEngine = z.infer<typeof DatabaseEngineSchema>;

export const VectorIndexSchema = z.object({
  collectionName: z.string().min(1).max(200),
  dimensions: z.number().int().positive().max(8192),
  distance: z.enum(['cosine', 'euclidean', 'dot']).default('cosine'),
  description: z.string().optional(),
});
export type VectorIndex = z.infer<typeof VectorIndexSchema>;

export const DatabaseConnectionSchema = z.object({
  engine: DatabaseEngineSchema,
  embedded: z.boolean().default(false),
  url: z.string().optional(),
  hostname: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().optional(),
  username: z.string().optional(),
  passwordSecretRef: z.string().optional(),
  sslMode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).optional(),
  /**
   * MANAGED: il DB è un sidecar provisionato on-demand NEL tenant (vs esterno
   * "porta-la-tua-connessione"). Quando true alla creazione, il runtime chiede
   * al portal di crearlo e poi compila host/port/credenziali del sidecar.
   */
  managed: z.boolean().optional(),
  /** Stato provisioning del sidecar managed (UI: installing → ready). */
  provisionStatus: z.enum(['provisioning', 'ready', 'error']).optional(),
  /** Tunnel SSH per DB esterni dietro bastion (stile DBeaver). Quando presente,
   *  il runtime apre il tunnel (db-remote-ssh) e punta l'adapter al forward locale. */
  sshTunnel: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().min(1).max(255),
    privateKeySecretRef: z.string().min(1),
    passphraseSecretRef: z.string().optional(),
    hostKeyFingerprint: z.string().min(1),
  }).optional(),
});
export type DatabaseConnection = z.infer<typeof DatabaseConnectionSchema>;

export const DatabaseSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  connection: DatabaseConnectionSchema,
  tables: z.array(TableSchema).default([]),
  relations: z.array(RelationSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Database = z.infer<typeof DatabaseSchema>;

export const QueryFilterSchema = z.object({
  column: z.string(),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'isNull', 'notNull']),
  value: z.unknown().optional(),
});
export type QueryFilter = z.infer<typeof QueryFilterSchema>;

export const QuerySpecSchema = z.object({
  table: z.string().min(1),
  select: z.array(z.string()).optional(),
  filters: z.array(QueryFilterSchema).default([]),
  orderBy: z.array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']) })).default([]),
  groupBy: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type QuerySpec = z.infer<typeof QuerySpecSchema>;

export const MigrationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_table'), table: TableSchema }),
  z.object({ kind: z.literal('drop_table'), tableName: z.string() }),
  z.object({ kind: z.literal('rename_table'), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal('add_column'), tableName: z.string(), column: ColumnSchema }),
  z.object({ kind: z.literal('drop_column'), tableName: z.string(), columnName: z.string() }),
  z.object({ kind: z.literal('rename_column'), tableName: z.string(), from: z.string(), to: z.string() }),
  z.object({
    kind: z.literal('alter_column'),
    tableName: z.string(),
    columnName: z.string(),
    patch: ColumnSchema.partial(),
  }),
  z.object({ kind: z.literal('add_relation'), relation: RelationSchema }),
  z.object({ kind: z.literal('drop_relation'), relationId: z.string() }),
  z.object({ kind: z.literal('add_index'), tableName: z.string(), index: IndexSchema }),
  z.object({ kind: z.literal('drop_index'), tableName: z.string(), indexName: z.string() }),
  z.object({ kind: z.literal('create_view'), view: ViewDefSchema }),
  z.object({ kind: z.literal('drop_view'), viewName: z.string() }),
]);
export type MigrationAction = z.infer<typeof MigrationActionSchema>;

export const MigrationSchema = z.object({
  id: z.string().min(1),
  databaseId: z.string().min(1),
  tenantId: z.string().min(1),
  actions: z.array(MigrationActionSchema).min(1),
  preview: z.string().optional(),
  appliedAt: z.string().datetime().optional(),
  rollbackOf: z.string().optional(),
  createdAt: z.string().datetime(),
  createdBy: z.string().optional(),
});
export type Migration = z.infer<typeof MigrationSchema>;

// Generatore SQL condiviso per le VIEW (CREATE/DROP) — usato dagli adapter SQL.
export { renderCreateViewSql, renderDropViewSql, type QuoteIdent } from './view-ddl.js';

// Helper condiviso per l'introspezione delle FOREIGN KEY (ER diagram) — usato
// dagli adapter SQL (postgres/mysql/mssql/sqlite/duckdb).
export { mapOnDeleteAction, fkRowToRelation, fkRowsToRelations, type ForeignKeyRow } from './relation-introspect.js';
