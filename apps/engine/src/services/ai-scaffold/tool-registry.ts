/**
 * Tool Registry pattern — infrastructure di livello industria per agent
 * tool dispatching. Pattern usato da:
 *   • Vercel AI SDK (https://sdk.vercel.ai)
 *   • Anthropic Claude tool_use API
 *   • OpenAI function calling
 *   • LangChain Tools
 *
 * EVOLUZIONE da `class ScaffoldSession.execute()` switch O(n):
 *   ─ PRIMA: switch case manuale, 28 case statements
 *   ─ ADESSO: Map<string, ToolDefinition> dispatch O(1)
 *
 * VANTAGGI Federico-grade:
 *   1. Schema-driven validation con Zod (no più `if (typeof X === 'string')`
 *      sparpagliati dentro ogni handler)
 *   2. Type-safety end-to-end: handler signature derivata dal schema con
 *      `z.infer<>` — il compiler garantisce coerenza schema↔handler
 *   3. Auto-introspection: `tools.values()` espone metadata complete
 *      (name + description + JSON schema) per essere passate direttamente
 *      a Anthropic Tools API o OpenAI function calling spec
 *   4. Pluggable: nuovo tool = registry.register({...}), NO switch case
 *      modify, NO conflitti di merge in PR concurrenti
 *   5. Single Responsibility: ogni file in `./tools/*.ts` ha N tool
 *      definitions raggruppati per categoria — modificare un tool non
 *      richiede touchare l'orchestrator
 */
import { z, type ZodType, type ZodTypeAny } from 'zod';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';

/**
 * Risultato standard di un tool call. Tagged union: `ok: true` con `data`
 * tipato, oppure `ok: false` con `error` stringa human-readable per il
 * prompt context dell'agent.
 */
export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Tool definition — single source of truth per ogni tool dell'agent.
 *
 * - `name`: identifier univoco usato nel prompt JSON `{"tool":"<name>",...}`
 * - `description`: 1-2 frasi human-readable, esposte all'LLM nel system prompt
 * - `schema`: Zod schema degli args. Auto-genera JSON schema per LLM
 * - `handler`: function pura che riceve session + args validati, ritorna ToolResult
 *
 * Generic <TArgs>: i schema args sono derivati type-safe dal schema Zod via
 * z.infer<typeof schema>. Cambiare schema = compiler ti dice subito dove
 * il handler deve adattarsi.
 */
export interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny, TData = unknown> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (
    session: ScaffoldSession,
    args: z.infer<TSchema>,
  ) => ToolResult<TData> | Promise<ToolResult<TData>>;
}

/**
 * Helper per creare ToolDefinition con type inference completa.
 * Pattern type-safe usato da Vercel AI SDK, tRPC procedure, shadcn/ui cva:
 * il tipo args del handler è DERIVATO dallo schema via `z.infer<TSchema>`,
 * così cambiare lo schema fa fail-fast il compiler sul handler.
 */
export function defineTool<TSchema extends ZodTypeAny, TData>(
  def: ToolDefinition<TSchema, TData>,
): ToolDefinition<TSchema, TData> {
  return def;
}

/**
 * Registry centrale dei tools. Lookup O(1) via Map.
 * Singleton per processo runtime: i tools sono registrati al boot (import
 * dei file `./tools/*.ts` con side-effect `register(...)`) e immutabili
 * dopo. Pattern dependency-free, no DI container necessario.
 */
class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<ZodTypeAny, unknown>>();

  /** Registra un tool. Se name duplicato → throw immediato (fail-fast al boot). */
  register<TSchema extends ZodTypeAny, TData>(tool: ToolDefinition<TSchema, TData>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" già registrato — duplicate registration al boot.`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition<ZodTypeAny, unknown>);
  }

  /** Lookup O(1). Ritorna undefined se il tool non esiste. */
  get(name: string): ToolDefinition<ZodTypeAny, unknown> | undefined {
    return this.tools.get(name);
  }

  /** Lista nomi registrati (utile per error messages "tool sconosciuto"). */
  names(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  /** Snapshot completo per introspection (LLM tool catalog, debug, docs). */
  all(): ToolDefinition<ZodTypeAny, unknown>[] {
    return Array.from(this.tools.values());
  }

  /** Dispatcher unificato: valida args via schema, poi delega al handler. */
  async execute(
    session: ScaffoldSession,
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        ok: false,
        error: `Tool sconosciuto: "${toolName}". Tools disponibili: ${this.names().join(', ')}`,
      };
    }
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ok: false, error: `Args invalidi per "${toolName}": ${issues}` };
    }
    try {
      return await tool.handler(session, parsed.data);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Singleton registry condiviso dall'app runtime. */
export const toolRegistry = new ToolRegistry();

// ─────────────────────────────────────────────────────────────────────────
// Native LLM tool-use API serializers — state-of-the-art 2026
// ─────────────────────────────────────────────────────────────────────────
//
// Questi helper convertono il registry interno in spec compatibili con le
// API di tool calling nativo dei principali provider LLM. Pattern usato
// dalle production app: invece di prompt-engineering "rispondi in JSON",
// si passa al modello la lista dei tool come metadata strutturata e il
// modello restituisce un tool_use block tipizzato (no JSON parsing fragile,
// no risposte malformate, no escape token issues).
//
// Riferimenti:
//   • Anthropic: https://docs.anthropic.com/claude/docs/tool-use
//   • OpenAI: https://platform.openai.com/docs/guides/function-calling
//
// Tradeoff vs prompt-engineered JSON:
//   ─ Pro: zero parsing fragility, schema validation by the provider,
//          tool_use streaming, parallel tool calling
//   ─ Contro: lock-in lieve a Anthropic/OpenAI tool_use schema (mitigato:
//            i 2 schema sono molto simili, helper sotto coprono entrambi)

/**
 * Serializza il registry in spec Anthropic Messages API tools[].
 *
 * Output shape:
 *   [{ name, description, input_schema: {...JSONSchema} }]
 *
 * Da passare direttamente a `client.messages.create({ tools: [...] })`.
 */
export function toAnthropicToolsSpec(): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}[] {
  return toolRegistry.all().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema as ZodType),
  }));
}

/**
 * Serializza il registry in spec OpenAI Chat Completions tools[].
 *
 * Output shape:
 *   [{ type: 'function', function: { name, description, parameters: {...} } }]
 *
 * Da passare direttamente a `openai.chat.completions.create({ tools: [...] })`.
 */
export function toOpenAIToolsSpec(): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  return toolRegistry.all().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema as ZodType),
    },
  }));
}

/**
 * Mini-converter Zod → JSON Schema. Copre i pattern usati dai 28 tool
 * scaffold (object con string/number/boolean/array properties + optional).
 * Per shape complesse oltre questi pattern, raccomandiamo
 * `zod-to-json-schema` (pacchetto npm dedicato, 8KB gz) — l'abbiamo
 * inlinato per evitare una dep extra finchè copre il use case attuale.
 */
function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = (
    schema as unknown as { _def: { typeName?: string; shape?: () => Record<string, ZodType> } }
  )._def;
  if (def.typeName === 'ZodObject' && typeof def.shape === 'function') {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const fieldDef = (
        fieldSchema as unknown as { _def: { typeName?: string; innerType?: ZodType } }
      )._def;
      const isOptional = fieldDef.typeName === 'ZodOptional' || fieldDef.typeName === 'ZodDefault';
      const inner = isOptional && fieldDef.innerType ? fieldDef.innerType : fieldSchema;
      properties[key] = zodTypeToJsonSchema(inner);
      if (!isOptional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  return zodTypeToJsonSchema(schema);
}

function zodTypeToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName?: string } })._def;
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      const elem = (def as unknown as { type: ZodType }).type;
      return { type: 'array', items: zodTypeToJsonSchema(elem) };
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: true };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      return { type: 'string' }; // fallback safe
  }
}

/**
 * Schema-vuoto helper per tool senza args (es. list_databases).
 * Z.object({}) è il pattern Zod canonico per "no args required".
 */
export const EmptyArgs = z.object({});
