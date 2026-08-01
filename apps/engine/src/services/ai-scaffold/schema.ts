/**
 * Schema del single-shot scaffold — estratto da singleshot.service.ts
 * (split NO-MONOLITI 2026-06-11). Pure: solo definizione dati.
 *  - SINGLESHOT_OUTPUT_SCHEMA  JSON schema che vLLM forza come output (guided_json)
 *  - ZodOutputShape            validazione runtime server-side del parsed
 */
import { z } from 'zod';

/** Schema JSON che vLLM forzera\` come output. Loose sui config (validati after). */
export const SINGLESHOT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 100 },
    description: { type: 'string', maxLength: 500 },
    reasoning: { type: 'string', minLength: 60, maxLength: 1500 },
    nodes: {
      type: 'array',
      minItems: 3,
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 60 },
          defId: { type: 'string', minLength: 1, maxLength: 80 },
          label: { type: 'string', maxLength: 80 },
          x: { type: 'number' },
          y: { type: 'number' },
          config: { type: 'object', additionalProperties: true },
        },
        required: ['id', 'defId', 'config'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          fromPort: { type: 'string' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
    /**
     * Tabelle DB nuove richieste dal workflow. Il LoRA le genera quando il goal
     * richiede persistenza in tabelle NON presenti nel tenant DB (es. "salva
     * audit SEO in seo_audits"). Il server le crea PRE-import workflow.
     * Se vuoto/omesso → nessuna tabella creata.
     */
    tablesToCreate: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          databaseId: { type: 'string', maxLength: 50 },
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,49}$', minLength: 2, maxLength: 50 },
          description: { type: 'string', maxLength: 200 },
          columns: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,49}$', minLength: 1, maxLength: 50 },
                type: {
                  type: 'string',
                  enum: ['bigint', 'boolean', 'text', 'varchar', 'integer', 'decimal', 'real', 'date', 'time', 'datetime', 'json', 'uuid'],
                },
                nullable: { type: 'boolean' },
                unique: { type: 'boolean' },
                primaryKey: { type: 'boolean' },
              },
              required: ['name', 'type'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'columns'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'reasoning', 'nodes', 'edges'],
  additionalProperties: false,
} as const;

export const ZodOutputShape = z.object({
  name: z.string().min(3).max(100),
  description: z.string().max(500).optional(),
  reasoning: z.string().min(60).max(1500),
  nodes: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/i),
    defId: z.string().min(1),
    label: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    config: z.record(z.string(), z.unknown()),
  })).min(3).max(30),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    fromPort: z.string().optional(),
  })).max(60),
  tablesToCreate: z.array(z.object({
    databaseId: z.string().max(50).optional(),
    name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    description: z.string().max(200).optional(),
    columns: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
      type: z.enum(['bigint', 'boolean', 'text', 'varchar', 'integer', 'decimal', 'real', 'date', 'time', 'datetime', 'json', 'uuid']),
      nullable: z.boolean().optional(),
      unique: z.boolean().optional(),
      primaryKey: z.boolean().optional(),
    })).min(1).max(30),
  })).max(5).optional(),
});
