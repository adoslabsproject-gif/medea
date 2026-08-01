/**
 * Registry + executor del DB-agent di Liara.
 *
 * `executeDbAgentTool` è l'UNICO ingresso: dispatch O(1), validazione Zod
 * `.strict()` (un argomento estraneo — es. un `tenantId` iniettato — fa fallire
 * la validazione), poi esecuzione del handler tenant-scoped. Qualsiasi
 * `DbAgentError` diventa un ToolResult `{ ok:false, code, error }` deterministico;
 * un errore inatteso diventa `INTERNAL` senza propagare stack al chiamante.
 *
 * @module services/db-agent/registry
 */
import type { DbAgentContext } from './context.js';
import type { DbAgentToolDef, DbAgentToolResult } from './tool-types.js';
import { DbAgentError } from './errors.js';
import { readTools } from './tools/read.js';
import { writeSchemaTools } from './tools/write-schema.js';
import { writeDataTools } from './tools/write-data.js';
import { schemaPlanTools } from './tools/schema-plan.js';
import { rawReadTools } from './tools/raw-read.js';
import { viewTools } from './tools/views.js';

const ALL_TOOLS: DbAgentToolDef[] = [...readTools, ...writeSchemaTools, ...writeDataTools, ...schemaPlanTools, ...rawReadTools, ...viewTools];

const TOOL_MAP: ReadonlyMap<string, DbAgentToolDef> = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Metadati tool per il tool-calling LLM (Anthropic/OpenAI). Ordine stabile. */
export function listDbAgentTools(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** True se il tool è distruttivo (l'UI deve chiedere conferma visiva). */
export function isDestructiveTool(name: string): boolean {
  return TOOL_MAP.get(name)?.destructive === true;
}

function formatZodIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

/**
 * Esegue un tool del DB-agent in modo tenant-safe e deterministico.
 * Non lancia mai: ogni esito è incapsulato in DbAgentToolResult.
 */
export async function executeDbAgentTool(
  ctx: DbAgentContext,
  toolName: string,
  rawArgs: unknown,
): Promise<DbAgentToolResult> {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return { ok: false, code: 'UNKNOWN_TOOL', error: `Tool DB sconosciuto: "${toolName}".` };
  }
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, code: 'TOOL_VALIDATION', error: `Argomenti non validi per ${toolName} — ${formatZodIssues(parsed.error)}` };
  }
  // GATE SCRITTURE (human-in-the-loop, revisore 2026-06-14): un tool distruttivo
  // gira SOLO se l'utente ha autorizzato le scritture per questa richiesta
  // (ctx.allowWrites). NON basta il `confirm:true` negli args perché quello lo
  // decide l'LLM: un prompt-injection nei dati del DB potrebbe impostarlo. Qui il
  // gate è server-side e indipendente dal modello → niente scritture autonome.
  if (tool.destructive === true && !ctx.allowWrites) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error: `"${toolName}" modifica dati o schema: serve il consenso esplicito dell'utente (attiva "Consenti modifiche" e ripeti la richiesta).`,
    };
  }
  try {
    const data = await tool.handler(ctx, parsed.data);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof DbAgentError) {
      return { ok: false, code: err.code, error: err.message };
    }
    // Errore inatteso del service/adapter: codice generico, nessuno stack leak.
    return { ok: false, code: 'INTERNAL', error: err instanceof Error ? err.message : String(err) };
  }
}
