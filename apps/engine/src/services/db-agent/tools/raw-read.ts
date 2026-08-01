/**
 * Tool DB-agent `run_sql` — lettura raw "alla DBeaver", SOLA LETTURA, blindata.
 *
 * Tripla guardia prima di toccare il DB:
 *  1. `classifyStatement` (engine) ripiega un blob multi-statement al kind
 *     PEGGIORE → `SELECT 1; DROP TABLE x` = 'ddl' = rifiutato; una CTE
 *     modificante `WITH d AS (DELETE …) SELECT …` = 'delete' = rifiutato.
 *     Ammessi SOLO 'select' e 'explain'.
 *  2. `assertSafeRawStatement` (engine) blocca i verbi che evadono il sandbox
 *     verso il filesystem host anche dentro un SELECT: ATTACH / VACUUM INTO /
 *     load_extension('…') (RCE/exfil).
 *  3. guardia tenant (`loadOwnedDatabase`) → mai un DB di un altro tenant.
 *
 * Solo dopo, `executeRaw` con rowLimit. Niente scritture per costruzione.
 *
 * @module services/db-agent/tools/raw-read
 */
import { z } from 'zod';
import { classifyStatement, assertSafeRawStatement } from '@flowforge/db-studio-engine';
import type { DbAgentToolDef } from '../tool-types.js';
import { loadOwnedDatabase } from '../guard.js';
import { ToolValidationError } from '../errors.js';

const RAW_MAX_ROWS = 5000;
const RAW_DEFAULT_ROWS = 200;
const RAW_SQL_MAX_CHARS = 20_000;

const RunSqlSchema = z
  .object({
    databaseId: z.string().min(1),
    sql: z.string().min(1).max(RAW_SQL_MAX_CHARS),
    rowLimit: z.number().int().positive().max(RAW_MAX_ROWS).optional(),
  })
  .strict();

const runSqlTool: DbAgentToolDef = {
  name: 'run_sql',
  description: 'Esegue SQL di SOLA LETTURA (solo SELECT/EXPLAIN) sul database del workspace e ritorna le righe. Scritture, DDL, multi-statement e verbi di filesystem-escape sono RIFIUTATI. Cap righe 5000.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      sql: { type: 'string', description: 'una singola query SELECT (o EXPLAIN)' },
      rowLimit: { type: 'number', description: `default ${RAW_DEFAULT_ROWS.toString()}, max ${RAW_MAX_ROWS.toString()}` },
    },
    required: ['databaseId', 'sql'],
    additionalProperties: false,
  },
  schema: RunSqlSchema,
  readOnly: true,
  handler: async (ctx, args) => {
    const a = args as z.infer<typeof RunSqlSchema>;

    // (1) Read-only: kind peggiore del blob deve essere select/explain.
    const kind = classifyStatement(a.sql);
    if (kind !== 'select' && kind !== 'explain') {
      throw new ToolValidationError(`run_sql consente SOLO query di lettura (SELECT/EXPLAIN); statement classificato come "${kind}". Per modificare schema o dati usa gli strumenti dedicati (apply_schema_plan, insert_row, update_rows, delete_rows).`);
    }

    // (2) Filesystem-escape: blocca ATTACH/VACUUM INTO/load_extension anche in un SELECT.
    try {
      assertSafeRawStatement(a.sql);
    } catch (e) {
      throw new ToolValidationError(e instanceof Error ? e.message : 'statement non consentito');
    }

    // (3) Tenant: il DB deve appartenere al tenant del contesto.
    loadOwnedDatabase(ctx, a.databaseId);

    const result = await ctx.dbStudio.executeRaw(
      a.databaseId,
      a.sql,
      { dryRun: false, rowLimit: a.rowLimit ?? RAW_DEFAULT_ROWS },
      ctx.tenantId,
    );
    return result;
  },
};

export const rawReadTools: DbAgentToolDef[] = [runSqlTool];
