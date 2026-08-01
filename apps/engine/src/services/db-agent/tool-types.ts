/**
 * Tipi del registry tool del DB-agent.
 *
 * Ogni tool porta DUE descrizioni dei suoi argomenti:
 *  - `schema` (Zod): validazione RUNTIME, autorità unica su cosa è accettato.
 *  - `parameters` (JSON Schema): ciò che si espone all'LLM (Anthropic tool_use /
 *    OpenAI function calling). Scritto a mano per restare deterministico e senza
 *    dipendenze da convertitori zod→json-schema.
 *
 * @module services/db-agent/tool-types
 */
import type { ZodType } from 'zod';
import type { DbAgentContext } from './context.js';

export interface DbAgentToolDef {
  name: string;
  description: string;
  /** JSON Schema advertised all'LLM. */
  parameters: Record<string, unknown>;
  /** Validazione runtime (autorità). */
  schema: ZodType<unknown>;
  /** Esegue il tool con args GIÀ validati. Ritorna il payload o lancia DbAgentError. */
  handler: (ctx: DbAgentContext, args: unknown) => Promise<unknown>;
  /** Operazione distruttiva (DROP) — l'UI deve segnalarla; richiede conferma negli args. */
  destructive?: boolean;
  /** Sola lettura — non muta schema né dati. */
  readOnly?: boolean;
}

export type DbAgentToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; error: string };
