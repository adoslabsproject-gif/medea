/**
 * Schema dell'output che il modello deve produrre.
 *
 * Viene usato in due modi, a seconda di cosa il provider supporta:
 *  - vincolo nativo (`response_format: json_schema` su OpenAI/vLLM/Ollama,
 *    `tool_choice` forzato su Anthropic);
 *  - schema incollato nel system prompt, per i provider che non hanno né l'uno
 *    né l'altro.
 *
 * È lo stesso schema del server: un workflow generato qui si importa là.
 */

export const SINGLESHOT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 100 },
    description: { type: 'string', maxLength: 500 },
    // Obbligare a motivare riduce i workflow "plausibili ma a caso": il
    // modello deve dichiarare come ha decomposto l'obiettivo.
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
    tablesToCreate: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: {
                  type: 'string',
                  enum: ['text', 'integer', 'real', 'boolean', 'timestamp', 'json'],
                },
                nullable: { type: 'boolean' },
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

/** La forma che ci aspettiamo dopo il parse, prima della validazione vera. */
export interface ScaffoldOutput {
  name: string;
  description?: string;
  reasoning: string;
  nodes: {
    id: string;
    defId: string;
    label?: string;
    x?: number;
    y?: number;
    config: Record<string, unknown>;
  }[];
  edges: { from: string; to: string; fromPort?: string }[];
  tablesToCreate?: {
    name: string;
    columns: { name: string; type: string; nullable?: boolean }[];
  }[];
}

/** Controllo di forma, prima che entrino in gioco catalogo e regole. */
export function isScaffoldOutput(value: unknown): value is ScaffoldOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.reasoning === 'string' &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges)
  );
}
