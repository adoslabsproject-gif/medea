/**
 * Costruzione deterministica di Column/Index del core a partire dall'input
 * (potenzialmente "creativo") del modello. Nessuna coercizione silenziosa: un
 * tipo colonna non valido viene RIFIUTATO con l'elenco di quelli ammessi, così
 * Liara corregge invece di scrivere una colonna sbagliata.
 *
 * @module services/db-agent/columns
 */
import { z } from 'zod';
import { ColumnTypeSchema, type Column, type ColumnType } from '@medea/engine-db-studio-core';

/** Tipi colonna ammessi (single source: il core). */
export const ALLOWED_COLUMN_TYPES: readonly ColumnType[] = ColumnTypeSchema.options;

const SNAKE = /^[a-z_][a-z0-9_]*$/;

/** Schema input colonna — `.strict()`: una chiave extra (es. tenantId) → errore. */
export const ColumnInputSchema = z
  .object({
    name: z.string().regex(SNAKE, 'nome colonna deve essere snake_case ([a-z_][a-z0-9_]*)'),
    type: ColumnTypeSchema,
    constraints: z
      .object({
        nullable: z.boolean().optional(),
        unique: z.boolean().optional(),
        primaryKey: z.boolean().optional(),
        default: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ColumnInput = z.infer<typeof ColumnInputSchema>;

/** Mappa un ColumnInput validato a un Column del core, con id deterministico. */
export function buildColumn(tableName: string, input: ColumnInput): Column {
  const c = input.constraints;
  return {
    id: `${tableName}.${input.name}`,
    name: input.name,
    type: input.type,
    constraints: {
      nullable: c?.nullable ?? true,
      unique: c?.unique ?? false,
      primaryKey: c?.primaryKey ?? false,
      ...(c?.default !== undefined ? { default: c.default } : {}),
    },
  };
}
