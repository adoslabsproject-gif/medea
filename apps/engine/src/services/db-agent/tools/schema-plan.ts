/**
 * Tool DB-agent PIANO-SCHEMA: preview_schema_plan (anteprima SQL, no apply) e
 * apply_schema_plan (applicazione ATOMICA multi-azione). Sostituiscono, per i
 * cambi schema non banali, le singole add_* (che restano per i casi semplici).
 *
 * `apply_schema_plan` rifiuta i piani con op distruttive (drop_table/column) se
 * `confirmDestructive` non è true → niente "oops" su un piano da 12 azioni.
 *
 * @module services/db-agent/tools/schema-plan
 */
import { z } from 'zod';
import type { DbAgentToolDef } from '../tool-types.js';
import { loadOwnedDatabase } from '../guard.js';
import { ConfirmationRequiredError } from '../errors.js';
import { SchemaPlanSchema, PlanActionSchema, buildMigrationActions, planHasDestructive, destructiveSummary, type PlanAction } from '../plan.js';

const PLAN_PARAM = {
  type: 'array',
  description: 'lista di azioni: {op:"create_table",table,columns} | {op:"add_column",table,column} | {op:"drop_column",table,columnName} | {op:"drop_table",table} | {op:"add_index",table,indexName,columns,unique?} | {op:"add_foreign_key",name,fromTable,fromColumn,toTable,toColumn,onDelete?}',
  items: { type: 'object' },
} as const;

const previewSchemaPlanTool: DbAgentToolDef = {
  name: 'preview_schema_plan',
  description: 'Anteprima: ritorna l\'SQL che un piano-schema eseguirebbe, SENZA toccare il database. Usalo prima di apply_schema_plan per mostrare il diff.',
  parameters: {
    type: 'object',
    properties: { databaseId: { type: 'string' }, plan: PLAN_PARAM },
    required: ['databaseId', 'plan'],
    additionalProperties: false,
  },
  schema: z.object({ databaseId: z.string().min(1), plan: SchemaPlanSchema }).strict(),
  readOnly: true,
  handler: async (ctx, args) => {
    const a = args as { databaseId: string; plan: PlanAction[] };
    loadOwnedDatabase(ctx, a.databaseId);
    const sql = await ctx.dbStudio.previewMigration(a.databaseId, buildMigrationActions(a.plan), ctx.tenantId);
    return { sql, actions: a.plan.length, destructive: planHasDestructive(a.plan) };
  },
};

const applySchemaPlanTool: DbAgentToolDef = {
  name: 'apply_schema_plan',
  description: 'Applica un piano-schema in UN\'UNICA migration atomica (tutto o niente). Se il piano contiene op distruttive (drop_table/drop_column) serve confirmDestructive=true.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: { type: 'string' },
      plan: PLAN_PARAM,
      confirmDestructive: { type: 'boolean', description: 'obbligatorio true se il piano contiene drop_table/drop_column' },
    },
    required: ['databaseId', 'plan'],
    additionalProperties: false,
  },
  schema: z.object({ databaseId: z.string().min(1), plan: SchemaPlanSchema, confirmDestructive: z.boolean().optional() }).strict(),
  destructive: true,
  handler: async (ctx, args) => {
    const a = args as { databaseId: string; plan: PlanAction[]; confirmDestructive?: boolean };
    if (planHasDestructive(a.plan) && a.confirmDestructive !== true) {
      throw new ConfirmationRequiredError(`Il piano contiene operazioni distruttive (${destructiveSummary(a.plan)}): passa confirmDestructive=true per applicarlo.`);
    }
    loadOwnedDatabase(ctx, a.databaseId);
    const result = await ctx.dbStudio.applyMigration(a.databaseId, buildMigrationActions(a.plan), ctx.tenantId);
    return { applied: a.plan.length, affectedTables: (result as { affectedTables?: string[] }).affectedTables ?? [] };
  },
};

export const schemaPlanTools: DbAgentToolDef[] = [previewSchemaPlanTool, applySchemaPlanTool];

// Riesporta lo schema della singola azione per i test di contratto.
export { PlanActionSchema };
