/**
 * Tool DB-agent di SCRITTURA DATI: insert_row, update_rows, delete_rows.
 * Parità con ciò che l'editor (TableBrowser) fa sui dati. Tenant-scoped via
 * guard + i metodi `..., ctx.tenantId` del service.
 *
 * update/delete operano su un filtro WHERE di uguaglianza e richiedono conferma
 * esplicita: una delete senza filtro NON è ammessa (niente "svuota tabella" per
 * sbaglio) e va comunque confermata.
 *
 * @module services/db-agent/tools/write-data
 */
import { z } from 'zod';
import type { DbAgentToolDef } from '../tool-types.js';
import { assertTableExists } from '../guard.js';
import { ConfirmationRequiredError, ToolValidationError } from '../errors.js';

const InsertRowSchema = z
  .object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    row: z.record(z.string(), z.unknown()),
  })
  .strict();

const insertRowTool: DbAgentToolDef = {
  name: 'insert_row',
  description: 'Inserisce una riga in una tabella esistente. row: oggetto colonna→valore.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      table: { type: 'string' },
      row: { type: 'object', description: 'mappa colonna→valore' },
    },
    required: ['databaseId', 'table', 'row'],
    additionalProperties: false,
  },
  schema: InsertRowSchema,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof InsertRowSchema>;
    assertTableExists(ctx, a.databaseId, a.table);
    const result = await ctx.dbStudio.insert(a.databaseId, a.table, a.row, ctx.tenantId);
    return { inserted: true, table: a.table, result };
  },
};

const UpdateRowsSchema = z
  .object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    where: z.record(z.string(), z.unknown()),
    patch: z.record(z.string(), z.unknown()),
    confirm: z.boolean(),
  })
  .strict();

const updateRowsTool: DbAgentToolDef = {
  name: 'update_rows',
  description:
    'Aggiorna le righe che combaciano col filtro WHERE (uguaglianza). Richiede where NON vuoto, patch NON vuoto e confirm=true.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      table: { type: 'string' },
      where: { type: 'object', description: 'filtro uguaglianza colonna→valore (non vuoto)' },
      patch: { type: 'object', description: 'colonne da aggiornare (non vuoto)' },
      confirm: { type: 'boolean', description: 'deve essere true' },
    },
    required: ['databaseId', 'table', 'where', 'patch', 'confirm'],
    additionalProperties: false,
  },
  schema: UpdateRowsSchema,
  destructive: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof UpdateRowsSchema>;
    if (Object.keys(a.where).length === 0)
      throw new ToolValidationError(
        'update_rows: where vuoto non ammesso (aggiornerebbe TUTTE le righe).',
      );
    if (Object.keys(a.patch).length === 0)
      throw new ToolValidationError('update_rows: patch vuoto, niente da aggiornare.');
    if (!a.confirm)
      throw new ConfirmationRequiredError('update_rows modifica dati: passa confirm=true.');
    assertTableExists(ctx, a.databaseId, a.table);
    const result = await ctx.dbStudio.updateRow(
      a.databaseId,
      a.table,
      a.where,
      a.patch,
      ctx.tenantId,
    );
    return { updated: true, table: a.table, result };
  },
};

const DeleteRowsSchema = z
  .object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    where: z.record(z.string(), z.unknown()),
    confirm: z.boolean(),
  })
  .strict();

const deleteRowsTool: DbAgentToolDef = {
  name: 'delete_rows',
  description:
    'Elimina le righe che combaciano col filtro WHERE (uguaglianza). Richiede where NON vuoto e confirm=true (no svuota-tabella accidentale).',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      table: { type: 'string' },
      where: { type: 'object', description: 'filtro uguaglianza colonna→valore (non vuoto)' },
      confirm: { type: 'boolean', description: 'deve essere true' },
    },
    required: ['databaseId', 'table', 'where', 'confirm'],
    additionalProperties: false,
  },
  schema: DeleteRowsSchema,
  destructive: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof DeleteRowsSchema>;
    if (Object.keys(a.where).length === 0)
      throw new ToolValidationError(
        'delete_rows: where vuoto non ammesso (cancellerebbe TUTTE le righe).',
      );
    if (!a.confirm)
      throw new ConfirmationRequiredError('delete_rows cancella dati: passa confirm=true.');
    assertTableExists(ctx, a.databaseId, a.table);
    const result = await ctx.dbStudio.deleteRow(a.databaseId, a.table, a.where, ctx.tenantId);
    return { deleted: true, table: a.table, result };
  },
};

export const writeDataTools: DbAgentToolDef[] = [insertRowTool, updateRowsTool, deleteRowsTool];
