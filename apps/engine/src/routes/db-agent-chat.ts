/**
 * Route SSE della chat DB-agent: Liara opera sul DB del workspace dal pannello
 * di DB Studio. Tenant-scoped, streaming dei passi in tempo reale.
 *
 * Flusso: auth → tenant da getTenantId (spoof-proof) → carica lo schema del DB
 * selezionato (SOLO se del tenant) → costruisce l'llmTurn (Liara/BYOK via
 * llmResolver) → runDbAgentChat con onStep → SSE 'step' per ogni tool, 'done'
 * col messaggio finale, 'error' su guasto.
 *
 * Isolamento: ogni tool passa per executeDbAgentTool (ctx.tenantId congelato).
 * L'llmTurn è iniettabile (test in-process con LLM stubbato → niente greensmoke).
 *
 * @module routes/db-agent-chat
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getTenantId } from '@/lib/tenant.js';
import { logger } from '@/lib/logger.js';
import {
  createDbAgentContext, runDbAgentChat, makeOpenAiLlmTurn,
  type DbAgentContext, type LlmTurn,
} from '@/services/db-agent/index.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { resolveToolEndpoint } from '@/services/llm/provider-registry.js';
import { liaraBaseUrl } from '@/config.js';

const ChatBodySchema = z.object({
  // OPZIONALE: assente = modalità GLOBALE (DB Studio, nessun DB selezionato) →
  // Liara elenca/crea database. Presente = modalità su quel DB (tenant-scoped).
  databaseId: z.string().min(1).optional(),
  userMessage: z.string().min(1).max(8000),
  workflowContext: z.string().max(20_000).optional(),
  maxIterations: z.number().int().min(1).max(16).optional(),
  // Consenso ESPLICITO dell'utente alle scritture (toggle UI). Default false →
  // Liara è in sola lettura finché l'utente non abilita. Gate enforced
  // server-side in registry.executeDbAgentTool (vedi ctx.allowWrites).
  allowWrites: z.boolean().optional(),
}).strict();

interface DbLike { name: string; connection: { engine: string }; tables: { name: string; columns: { name: string; type: string }[] }[] }

/** Serializza lo schema del DB in testo compatto per il system prompt. */
function serializeSchema(db: DbLike): string {
  if (db.tables.length === 0) return `Database "${db.name}": nessuna tabella.`;
  return `Database "${db.name}":\n` + db.tables
    .map((t) => `- ${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(', ')})`)
    .join('\n');
}

/** Panoramica dei DB del workspace (modalità globale): nome · engine · #tabelle. */
function serializeOverview(dbs: DbLike[]): string {
  if (dbs.length === 0) return 'Nessun database nel workspace. Puoi crearne uno con create_database.';
  return dbs.map((d) => `- "${d.name}" (${d.connection.engine}, ${d.tables.length.toString()} tabelle)`).join('\n');
}

export interface DbAgentChatRouteOptions {
  /** Iniezione per i test: fornisce un llmTurn stubbato (niente LLM reale). */
  llmTurnFor?: (tenantId: string) => LlmTurn;
}

export function createDbAgentChatRoutes(opts: DbAgentChatRouteOptions = {}): Hono {
  const app = new Hono();

  app.post('/chat', zValidator('json', ChatBodySchema), (c) => {
    const auth = c.get('auth') as { userId?: string } | null;
    if (!auth?.userId) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');

    // allowWrites SOLO da consenso esplicito del client (mai dall'LLM).
    const ctx: DbAgentContext = createDbAgentContext(tenantId, undefined, body.allowWrites === true);
    // Modalità DATABASE: databaseId presente → DEVE essere del tenant (404 anti-enum).
    // Modalità GLOBALE: databaseId assente → Liara opera su tutto il workspace.
    const db = body.databaseId ? ctx.dbStudio.get(body.databaseId, tenantId) : null;
    if (body.databaseId && !db) return c.json({ error: 'Not found' }, 404); // anti-enumeration

    // llmTurn: stub nei test, altrimenti provider risolto per il tenant.
    let llmTurn: LlmTurn;
    try {
      if (opts.llmTurnFor) {
        llmTurn = opts.llmTurnFor(tenantId);
      } else {
        const r = llmResolver.resolve(tenantId);
        if (r.provider !== 'liara' && r.provider !== 'ollama' && !r.apiKey) {
          return c.json({ error: `Nessuna API key per ${r.provider}.` }, 401);
        }
        // baseUrl per i provider self-host: Liara → gateway portal (config),
        // Ollama → quello configurato dal tenant. Endpoint/model/header da UNICA fonte.
        const baseUrl = r.baseUrl ?? (r.provider === 'liara' ? liaraBaseUrl() : undefined);
        const target = resolveToolEndpoint(r.provider, r.model, baseUrl);
        if (!target) {
          return c.json({
            error: `Il provider "${r.provider}" non supporta il tool-calling richiesto dalla chat di DB Studio. Usa OpenAI, Gemini, Grok, DeepSeek, OpenRouter, Groq, Mistral, Liara o Ollama.`,
          }, 400);
        }
        // AUTH: il gateway Liara (portal) ESIGE la LICENSE KEY come Bearer (non una
        // API key del tenant). I provider BYOK usano la loro apiKey. Ollama locale
        // non richiede auth. (Identico a llm-chat.service per la chat non-tool.)
        const authKey = r.provider === 'liara' ? (process.env.MEDEA_LICENSE_KEY ?? '') : r.apiKey;
        llmTurn = makeOpenAiLlmTurn({
          endpoint: target.url,
          apiKey: authKey,
          model: target.model,
          ...(target.extraHeaders ? { extraHeaders: target.extraHeaders } : {}),
        });
      }
    } catch (err) {
      if (err instanceof NoLlmProviderError) return c.json({ error: err.message }, err.httpStatus);
      throw err;
    }

    // Prompt: schema del DB selezionato (modalità database) o panoramica del
    // workspace (modalità globale → list/create database).
    const promptScope = db
      ? { schemaContext: serializeSchema(db) }
      : { databasesOverview: serializeOverview(ctx.dbStudio.list(tenantId)) };
    return streamSSE(c, async (stream) => {
      try {
        const result = await runDbAgentChat({
          ctx,
          userMessage: body.userMessage,
          prompt: { ...promptScope, ...(body.workflowContext ? { workflowContext: body.workflowContext } : {}) },
          llmTurn,
          ...(body.maxIterations ? { maxIterations: body.maxIterations } : {}),
          onStep: (step) => { void stream.writeSSE({ event: 'step', data: JSON.stringify(step) }); },
        });
        await stream.writeSSE({ event: 'done', data: JSON.stringify(result) });
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), tenantId }, '[db-agent-chat] failed');
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'Generazione interrotta da un errore interno.' }) });
      }
    });
  });

  return app;
}
