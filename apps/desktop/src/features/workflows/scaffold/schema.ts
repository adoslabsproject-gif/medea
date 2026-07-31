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

/** Tipi di colonna ammessi per le tabelle richieste dal workflow. Unica fonte:
 *  la usano sia lo schema JSON sia la validazione in `validate-tables`. */
export const TABLE_COLUMN_TYPES = [
  'text',
  'integer',
  'real',
  'boolean',
  'timestamp',
  'json',
] as const;

export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];

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
                type: { type: 'string', enum: TABLE_COLUMN_TYPES },
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Un nodo senza `config` oggetto farebbe esplodere riparazione e validazione:
 *  qui si garantisce che ogni elemento abbia la forma minima su cui il resto
 *  della pipeline può camminare senza eccezioni. */
function isScaffoldNode(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === 'string' && typeof value.defId === 'string' && isPlainObject(value.config)
  );
}

function isScaffoldEdge(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return typeof value.from === 'string' && typeof value.to === 'string';
}

function isTableToCreate(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.name !== 'string' || !Array.isArray(value.columns)) return false;
  return value.columns.every(
    (c) => isPlainObject(c) && typeof c.name === 'string' && typeof c.type === 'string',
  );
}

/** Controllo di forma, prima che entrino in gioco catalogo e regole. */
export function isScaffoldOutput(value: unknown): value is ScaffoldOutput {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.name === 'string' &&
    typeof value.reasoning === 'string' &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isScaffoldNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isScaffoldEdge) &&
    (value.tablesToCreate === undefined ||
      (Array.isArray(value.tablesToCreate) && value.tablesToCreate.every(isTableToCreate)))
  );
}
