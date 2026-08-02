/**
 * Tool DB-agent per le VIEW: create_view / drop_view.
 *
 * SICUREZZA — la definizione di una view è una SELECT salvata: la validiamo
 * read-only PRIMA di costruire l'azione, riusando ESATTAMENTE le stesse guardie
 * di `run_sql` (assertSingleStatement → no multi-statement smuggling;
 * assertSafeRawStatement → no ATTACH/COPY/read_csv filesystem-escape;
 * classifyStatement → il "kind peggiore" deve essere 'select', così
 * `WITH d AS (DELETE …) SELECT …` viene rifiutato). Una view NON può quindi
 * essere un cavallo di Troia per scrivere.
 *
 * Le view sono SOLO su engine relazionali (sqlite/postgres/mysql/mssql/duckdb):
 * mongodb/redis/qdrant non hanno il concetto → rifiuto chiaro nel tool, prima di
 * toccare l'adapter.
 *
 * create_view è ADDITIVO (non gated). drop_view è DISTRUTTIVO (gate allowWrites +
 * conferma per-nome, come drop_table).
 *
 * @module services/db-agent/tools/views
 */
import { z } from 'zod';
import { classifyStatement, assertSafeRawStatement, assertSingleStatement } from '@medea/engine-db-studio-engine';
import type { DbAgentToolDef } from '../tool-types.js';
import { loadOwnedDatabase } from '../guard.js';
import { ConfirmationRequiredError, ToolValidationError } from '../errors.js';

const NAME = /^[a-z_][a-z0-9_]*$/;

/** Engine che supportano le VIEW SQL. pgvector = PostgreSQL → incluso. */
const VIEW_CAPABLE_ENGINES = new Set(['sqlite', 'postgres', 'pgvector', 'mysql', 'mssql', 'duckdb']);

function assertRelational(engine: string): void {
  if (!VIEW_CAPABLE_ENGINES.has(engine)) {
    throw new ToolValidationError(`Le view non sono supportate sull'engine "${engine}" (solo database relazionali: sqlite/postgres/mysql/mssql/duckdb).`);
  }
}

/** La SELECT della view deve essere di SOLA LETTURA, singola e senza fs-escape.
 *  Le guardie dell'engine lanciano Error generici → li rimappiamo a
 *  ToolValidationError, così il modello riceve un errore d'INPUT azionabile
 *  (TOOL_VALIDATION) e non un 'INTERNAL' opaco. */
function assertReadOnlySelect(sql: string): void {
  try {
    assertSingleStatement(sql); // niente "; DROP TABLE …" annidato
    assertSafeRawStatement(sql); // niente ATTACH / COPY / read_csv / VACUUM INTO
  } catch (err) {
    throw new ToolValidationError(err instanceof Error ? err.message : 'SQL non valido per una view.');
  }
  const kind = classifyStatement(sql);
  if (kind !== 'select') {
    throw new ToolValidationError(`La definizione della view deve essere una SELECT di sola lettura (rilevato: ${kind}).`);
  }
}

const CreateViewSchema = z
  .object({
    databaseId: z.string().min(1),
    name: z.string().regex(NAME).max(63),
    select: z.string().min(1).max(20_000),
  })
  .strict();

const createViewTool: DbAgentToolDef = {
  name: 'create_view',
  description: 'Crea una VIEW (query SELECT salvata) in un database relazionale del workspace. select = una singola SELECT di sola lettura.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      name: { type: 'string', description: 'snake_case, max 63' },
      select: { type: 'string', description: 'una SELECT di sola lettura (no DML/DDL, no multi-statement)' },
    },
    required: ['databaseId', 'name', 'select'],
    additionalProperties: false,
  },
  schema: CreateViewSchema,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof CreateViewSchema>;
    const db = loadOwnedDatabase(ctx, a.databaseId);
    assertRelational(db.connection.engine);
    assertReadOnlySelect(a.select);
    await ctx.dbStudio.applyMigration(a.databaseId, [{ kind: 'create_view', view: { name: a.name, select: a.select } }], ctx.tenantId);
    return { created: a.name, engine: db.connection.engine };
  },
};

const DropViewSchema = z
  .object({
    databaseId: z.string().min(1),
    viewName: z.string().min(1),
    confirmViewName: z.string().min(1),
  })
  .strict();

const dropViewTool: DbAgentToolDef = {
  name: 'drop_view',
  description: 'Elimina una VIEW (DISTRUTTIVO). confirmViewName deve combaciare ESATTAMENTE con viewName.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      viewName: { type: 'string' },
      confirmViewName: { type: 'string', description: 'rieco esatto di viewName' },
    },
    required: ['databaseId', 'viewName', 'confirmViewName'],
    additionalProperties: false,
  },
  schema: DropViewSchema,
  destructive: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof DropViewSchema>;
    if (a.confirmViewName !== a.viewName) {
      throw new ConfirmationRequiredError(`drop_view è distruttivo: passa confirmViewName="${a.viewName}" per confermare.`);
    }
    const db = loadOwnedDatabase(ctx, a.databaseId);
    assertRelational(db.connection.engine);
    await ctx.dbStudio.applyMigration(a.databaseId, [{ kind: 'drop_view', viewName: a.viewName }], ctx.tenantId);
    return { dropped: a.viewName };
  },
};

export const viewTools: DbAgentToolDef[] = [createViewTool, dropViewTool];
