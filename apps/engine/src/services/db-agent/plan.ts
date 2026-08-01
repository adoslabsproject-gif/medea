/**
 * Piano-schema del DB-agent: una LISTA di azioni di alto livello (create_table,
 * add_column, drop_column, drop_table, add_index, add_foreign_key) che vengono
 * (a) anteprimate come SQL senza toccare il disco, oppure (b) applicate in
 * UN'UNICA migration ATOMICA (l'adapter SQLite avvolge tutte le statement in
 * una transazione → all-or-nothing). È il salto da "wrapper CRUD" a "modellatore
 * di schema": Liara compone tabella+indice+FK e o passa tutto, o niente.
 *
 * Mapping deterministico verso `MigrationAction[]` del core; nessuna coercizione.
 *
 * @module services/db-agent/plan
 */
import { z } from 'zod';
import type { MigrationAction, Relation } from '@flowforge/db-studio-core';
import { ColumnInputSchema, buildColumn } from './columns.js';

const NAME = /^[a-z_][a-z0-9_]*$/;
const ON_DELETE = ['cascade', 'restrict', 'set null', 'set default', 'no action'] as const;

/** Azione di piano (alto livello, LLM-friendly). `.strict()`: chiavi extra = errore. */
export const PlanActionSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_table'),
    table: z.string().regex(NAME).max(63),
    columns: z.array(ColumnInputSchema).min(1),
  }).strict(),
  z.object({ op: z.literal('add_column'), table: z.string().min(1), column: ColumnInputSchema }).strict(),
  z.object({ op: z.literal('drop_column'), table: z.string().min(1), columnName: z.string().min(1) }).strict(),
  z.object({ op: z.literal('drop_table'), table: z.string().min(1) }).strict(),
  z.object({
    op: z.literal('add_index'),
    table: z.string().min(1),
    indexName: z.string().regex(NAME),
    columns: z.array(z.string().min(1)).min(1),
    unique: z.boolean().optional(),
  }).strict(),
  z.object({
    op: z.literal('add_foreign_key'),
    name: z.string().regex(NAME),
    fromTable: z.string().min(1),
    fromColumn: z.string().min(1),
    toTable: z.string().min(1),
    toColumn: z.string().min(1),
    onDelete: z.enum(ON_DELETE).optional(),
  }).strict(),
]);

export type PlanAction = z.infer<typeof PlanActionSchema>;

export const SchemaPlanSchema = z.array(PlanActionSchema).min(1).max(50);

/** Le op che distruggono dati/struttura → richiedono conferma esplicita. */
const DESTRUCTIVE_OPS = new Set<PlanAction['op']>(['drop_column', 'drop_table']);

export function planHasDestructive(plan: PlanAction[]): boolean {
  return plan.some((a) => DESTRUCTIVE_OPS.has(a.op));
}

/** Elenco leggibile delle op distruttive nel piano (per il messaggio di conferma). */
export function destructiveSummary(plan: PlanAction[]): string {
  return plan
    .filter((a) => DESTRUCTIVE_OPS.has(a.op))
    .map((a) => (a.op === 'drop_table' ? `drop_table(${a.table})` : a.op === 'drop_column' ? `drop_column(${a.table}.${a.columnName})` : a.op))
    .join(', ');
}

/** Mappa il piano di alto livello alle MigrationAction del core (1:1, ordine preservato). */
export function buildMigrationActions(plan: PlanAction[]): MigrationAction[] {
  return plan.map((a): MigrationAction => {
    switch (a.op) {
      case 'create_table':
        return { kind: 'create_table', table: { id: a.table, name: a.table, columns: a.columns.map((c) => buildColumn(a.table, c)), indexes: [] } };
      case 'add_column':
        return { kind: 'add_column', tableName: a.table, column: buildColumn(a.table, a.column) };
      case 'drop_column':
        return { kind: 'drop_column', tableName: a.table, columnName: a.columnName };
      case 'drop_table':
        return { kind: 'drop_table', tableName: a.table };
      case 'add_index':
        return { kind: 'add_index', tableName: a.table, index: { id: a.indexName, name: a.indexName, columns: a.columns, unique: a.unique ?? false } };
      case 'add_foreign_key': {
        const relation: Relation = {
          id: a.name,
          name: a.name,
          kind: 'one-to-many',
          fromTable: a.fromTable,
          fromColumn: a.fromColumn,
          toTable: a.toTable,
          toColumn: a.toColumn,
          onDelete: a.onDelete ?? 'restrict',
        };
        return { kind: 'add_relation', relation };
      }
    }
  });
}
