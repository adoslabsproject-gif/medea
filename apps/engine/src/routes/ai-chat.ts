/**
 * /api/v1/ai-chat — sessioni di chat AI conversazionali persistenti.
 *
 * Memoria multi-sessione cross-device per Help Chat AI + AI Scaffold,
 * con tenant isolation rigorosa:
 *   - Ogni sessione ha tenant_id e user_id
 *   - User non-superadmin vede SOLO le sessioni del proprio tenant
 *   - Superadmin via /admin/ai-chat/sessions può vedere TUTTI i tenant
 *     per audit/support (path separato, no leak ai utenti regolari)
 *
 * Endpoint:
 *   POST   /sessions                            crea sessione (auto-title vuoto)
 *   GET    /sessions?surface=help               lista sessioni del user/tenant
 *   GET    /sessions/:id/messages               history completa
 *   POST   /sessions/:id/messages               aggiunge user msg + dispatch LLM + salva assistant reply
 *   PATCH  /sessions/:id                        rinomina (titolo)
 *   DELETE /sessions/:id                        cancellazione GDPR-compliant
 */
import { coerceString } from '@/lib/coerce.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { getTenantId } from '@/lib/tenant.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { dispatchLLMChat } from '@/services/llm-chat.service.js';
import {
  detectIntents,
  executeIntents,
  formatToolResultsForPrompt,
} from '@/services/chat-intent.service.js';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import { logger } from '@/lib/logger.js';

interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  surface: string;
  title: string | null;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}
interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  tokens: number | null;
  model: string | null;
  ts: string;
}

const SURFACE_PROMPTS: Record<string, string> = {
  help: "Sei **Liara**, l'assistente AI di FlowForge (Zeli SRL). Quando l'utente ti saluta, presentati come Liara. Rispondi SOLO in italiano, conciso, max 5 frasi. Aiuti l'utente con workflow, nodi, deploy, sicurezza. Se la domanda è fuori scope, dillo gentilmente.",
  scaffold:
    "Sei **Liara**, l'assistente AI di FlowForge (Zeli SRL) che aiuta a costruire workflow. Rispondi in italiano. Quando proponi un workflow, elenca i nodi in ordine.",
  generic: "Sei **Liara**, l'assistente AI di FlowForge (Zeli SRL). Rispondi in italiano.",
};

const CreateSessionSchema = z.object({
  surface: z.string().default('generic'),
  title: z.string().optional(),
  workflowId: z.string().optional(),
});

/**
 * Attachment supportati nella chat AI (Phase 4):
 *   - 'image': base64-encoded immagine (jpeg/png/gif/webp), processata
 *     come content block multimodal Anthropic (vision)
 *   - 'document': PDF/testo allegato, estratto lato server e iniettato
 *     nel prompt come testo
 *   - 'url': URL fetchata server-side, contenuto estratto via cheerio
 */
const AttachmentSchema = z.object({
  kind: z.enum(['image', 'document', 'url']),
  name: z.string().min(1).max(255),
  mimeType: z.string().optional(),
  /** Base64 raw (no data: prefix). Solo per kind=image/document. */
  dataBase64: z.string().optional(),
  /** Solo per kind=url. */
  url: z.string().url().optional(),
});

const SendMessageSchema = z.object({
  content: z.string().min(1).max(50000),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  /** Abilita tool calling (fetch_url, web_search). Default true. */
  enableTools: z.boolean().optional(),
});

const RenameSchema = z.object({
  title: z.string().min(1).max(200),
});

export function createAiChatRoutes(): Hono {
  const app = new Hono();

  /** POST /sessions — crea nuova sessione */
  app.post('/sessions', zValidator('json', CreateSessionSchema), (c) => {
    const auth = c.get('auth') as { userId: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const { surface, title, workflowId } = c.req.valid('json');
    const id = nanoid();
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        `
      INSERT INTO ai_chat_sessions (id, tenant_id, user_id, surface, title, workflow_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, tenantId, auth.userId, surface, title ?? null, workflowId ?? null);
    return c.json(
      {
        session: {
          id,
          tenantId,
          userId: auth.userId,
          surface,
          title: title ?? null,
          workflowId: workflowId ?? null,
        },
      },
      201,
    );
  });

  /** GET /sessions?surface=&workflowId= — lista sessioni utente */
  app.get('/sessions', (c) => {
    const auth = c.get('auth') as { userId: string; role?: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const surface = c.req.query('surface');
    const { sqlite } = getDatabase();
    const filters: string[] = ['tenant_id = ?', 'user_id = ?'];
    const params: unknown[] = [tenantId, auth.userId];
    if (surface) {
      filters.push('surface = ?');
      params.push(surface);
    }
    const rows = sqlite
      .prepare(
        `
      SELECT id, tenant_id, user_id, surface, title, workflow_id, created_at, updated_at
      FROM ai_chat_sessions WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC LIMIT 200
    `,
      )
      .all(...params) as SessionRow[];
    return c.json({ sessions: rows });
  });

  /** GET /sessions/:id/messages — history completa */
  app.get('/sessions/:id/messages', (c) => {
    const auth = c.get('auth') as { userId: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const { sqlite } = getDatabase();
    const session = sqlite
      .prepare(
        `
      SELECT * FROM ai_chat_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?
    `,
      )
      .get(id, tenantId, auth.userId) as SessionRow | undefined;
    if (!session) return c.json({ error: 'Not found' }, 404);
    const messages = sqlite
      .prepare(
        `
      SELECT id, session_id, role, content, tokens, model, ts
      FROM ai_chat_messages WHERE session_id = ? ORDER BY id ASC
    `,
      )
      .all(id) as MessageRow[];
    return c.json({ session, messages });
  });

  /**
   * POST /sessions/:id/messages — multimodal chat con tool calling.
   *
   * Phase 4 features:
   *   1. `attachments[]` — immagini/documenti/URL allegati al messaggio
   *      - kind='image': base64 jpeg/png → multimodal Anthropic vision
   *      - kind='document': PDF/testo → extracted text iniettato nel prompt
   *      - kind='url': fetch lato server (cheerio extract) → testo iniettato
   *   2. Tool calling (fetch_url + web_search) via il pattern Tool Registry
   *      (riuso dello stesso pattern Phase 3 AI Scaffold) — l'agente può
   *      esplorare URL e cercare sul web. Default ON, disabile con
   *      enableTools=false.
   */
  app.post(
    '/sessions/:id/messages',
    llmRateLimit('ai-chat'),
    zValidator('json', SendMessageSchema),
    async (c) => {
      const auth = c.get('auth') as { userId: string } | null;
      if (!auth) return c.json({ error: 'Unauthorized' }, 401);
      const tenantId = getTenantId(c);
      const id = c.req.param('id');
      const { content, attachments, enableTools } = c.req.valid('json');
      const { sqlite } = getDatabase();
      const session = sqlite
        .prepare(
          `
      SELECT * FROM ai_chat_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?
    `,
        )
        .get(id, tenantId, auth.userId) as SessionRow | undefined;
      if (!session) return c.json({ error: 'Not found' }, 404);

      // Phase 4: pre-process attachments. URL fetch viene fatta server-side
      // PRIMA del LLM call (l'agente vede il testo estratto, non l'URL).
      // Image/document base64 passa diretto al LLM multimodal.
      const enrichedAttachments: {
        kind: 'image' | 'document' | 'url';
        name: string;
        mimeType?: string;
        dataBase64?: string;
        url?: string;
        extractedText?: string;
      }[] = [];
      let extraContext = '';
      for (const att of attachments ?? []) {
        // Build incrementale (exactOptionalPropertyTypes friendly):
        // i campi opzionali sono presenti SOLO se non-undefined.
        const enriched: (typeof enrichedAttachments)[number] = {
          kind: att.kind,
          name: att.name,
          ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
          ...(att.dataBase64 !== undefined ? { dataBase64: att.dataBase64 } : {}),
          ...(att.url !== undefined ? { url: att.url } : {}),
        };
        if (att.kind === 'url' && att.url) {
          try {
            const { fetchUrl } = await import('../services/web-tools.service.js');
            const fetched = await fetchUrl(att.url);
            enriched.extractedText = `[URL: ${fetched.finalUrl}]\n${fetched.title ? `# ${fetched.title}\n` : ''}${fetched.description ? `> ${fetched.description}\n\n` : ''}${fetched.content.slice(0, 30_000)}`;
            extraContext += `\n\n=== Contenuto da ${att.url} ===\n${enriched.extractedText}\n=== fine ===\n`;
          } catch (e) {
            enriched.extractedText = `[Errore fetch ${att.url}: ${e instanceof Error ? e.message : String(e)}]`;
            extraContext += `\n\n${enriched.extractedText}\n`;
          }
        } else if (att.kind === 'document' && att.dataBase64) {
          // Decode base64 e injecta come testo (max 20KB per attachment)
          try {
            const decoded = Buffer.from(att.dataBase64, 'base64').toString('utf8').slice(0, 20_000);
            enriched.extractedText = decoded;
            extraContext += `\n\n=== Documento "${att.name}" ===\n${decoded}\n=== fine ===\n`;
          } catch {
            enriched.extractedText = `[Errore decode "${att.name}"]`;
          }
        }
        // image: il base64 viene passato al LLM multimodal direttamente,
        // niente extraction server-side
        enrichedAttachments.push(enriched);
      }

      // Salva il messaggio utente con attachments JSON
      const attachmentsJson =
        enrichedAttachments.length > 0 ? JSON.stringify(enrichedAttachments) : null;
      sqlite
        .prepare(
          `INSERT INTO ai_chat_messages (session_id, role, content, attachments_json) VALUES (?, 'user', ?, ?)`,
        )
        .run(id, content, attachmentsJson);

      // Carica intera history (per multi-turn) — NESSUN TRONCAMENTO.
      const history = sqlite
        .prepare(
          `
      SELECT role, content FROM ai_chat_messages WHERE session_id = ? ORDER BY id ASC
    `,
        )
        .all(id) as { role: 'user' | 'assistant'; content: string }[];

      let resolved;
      try {
        resolved = llmResolver.resolve(tenantId);
      } catch (err) {
        if (err instanceof NoLlmProviderError)
          return c.json({ error: 'no_provider', message: err.message }, 503);
        throw err;
      }

      let systemPrompt = SURFACE_PROMPTS[session.surface] ?? SURFACE_PROMPTS.generic;

      // ─────────────────────────────────────────────────────────────────
      // CATALOG AWARENESS — anti-hallucination "questo nodo non esiste"
      // P6 audit RAG (unificazione superfici): la chat usa lo STESSO retriever
      // ibrido di ai-assistant — mappa famiglie (~200 token, il modello sa COSA
      // esiste) + top-k nodi pertinenti al MESSAGGIO (searchAliases + sinonimi
      // IT↔EN inclusi: il fix "nodo code" vale qui by-construction). Fallback
      // a catena: retriever giù → catalogo compatto defId|type|label →
      // nessun catalogo (chat sempre viva).
      // ─────────────────────────────────────────────────────────────────
      const ALIAS_PROMPT_ROW =
        'ALIAS COMUNI (n8n-speak → defId): "code node"/"nodo code"/"function" → action_run_js (JavaScript, default come n8n) o action_run_python (se l\'utente vuole Python) · "set/edit fields" → logic_transform · "http request" → action_http · "if" → logic_if · "filtro" → action_filter · "switch" → logic_switch · "loop/split in batches" → logic_loop.\nQuando l\'utente chiede di un nodo, verifica QUI (defId, label E alias) prima di dire che non esiste.';
      try {
        const { getCatalogRetriever, formatCatalogForPrompt } =
          await import('@/services/catalog-retrieval/index.js');
        const retriever = await getCatalogRetriever(tenantId);
        const retrieved = await retriever.retrieve(content, { k: 18 });
        systemPrompt = `${systemPrompt}\n\n${formatCatalogForPrompt(retriever, retrieved)}\n\n${ALIAS_PROMPT_ROW}`;
      } catch (retrErr) {
        logger.warn(
          { err: retrErr instanceof Error ? retrErr.message : String(retrErr) },
          '[ai-chat] catalog retriever failed — fallback catalogo compatto',
        );
        try {
          const cat = buildNodeCatalog();
          const catalogStr = cat.map((e) => `${e.defId}|${e.type}|${e.label}`).join('\n');
          systemPrompt = `${systemPrompt}\n\n### CATALOGO NODI FLOWFORGE (TUTTI questi defId ESISTONO — non dire mai "non e\` nel catalogo"):\n${catalogStr}\n\n${ALIAS_PROMPT_ROW}`;
        } catch {
          // graceful: chat funziona anche senza catalogo (fallback prompt base)
        }
      }

      // ─────────────────────────────────────────────────────────────────
      // Layer 1 — DETERMINISTIC INTENT DETECTION + AUTO TOOL EXECUTION
      // (pattern usato da ChatGPT Browsing, Perplexity, Claude.ai)
      //
      // I provider weak (Liara/Qwen, Gemini Flash, Llama 3.x small) NON
      // sono affidabili sulla decisione "devo usare un tool?". Quindi
      // SERVER-SIDE rileviamo intent (URL embedded, "cerca X", "apri
      // foo.com") e PRE-ESEGUIAMO i tool. Il risultato viene iniettato
      // nel system prompt come WEB_CONTEXT, il LLM riceve i dati pronti.
      //
      // Garanzia: "cerca nothumanallowed.com" o "fetch https://x.com"
      // FUNZIONANO SEMPRE indipendentemente dal provider e dal prompt.
      // ─────────────────────────────────────────────────────────────────
      let webContext = '';
      if (enableTools !== false) {
        const detectedIntents = detectIntents(content);
        if (detectedIntents.length > 0) {
          const executed = await executeIntents(detectedIntents, {
            provider: resolved.provider,
            apiKey: resolved.apiKey,
            model: resolved.model,
            baseUrl: resolved.baseUrl,
          });
          webContext = formatToolResultsForPrompt(executed);
        }
      }
      if (webContext) {
        systemPrompt = `${webContext}\n\n${systemPrompt ?? ''}`;
      }

      // La history ha già il prompt utente come ultimo elemento.
      const lastUser = history[history.length - 1];
      const earlierHistory = history.slice(0, -1);
      // Iniziamo il messaggio user con il contenuto + extra context da
      // attachments processati server-side.
      const augmentedUserMessage = extraContext
        ? `${lastUser?.content ?? content}\n${extraContext}`
        : (lastUser?.content ?? content);

      try {
        let reply = await dispatchLLMChat(
          resolved.provider,
          resolved.apiKey,
          resolved.model,
          systemPrompt ?? '',
          augmentedUserMessage,
          resolved.baseUrl,
          earlierHistory,
        );

        // Layer 2 — FALLBACK prompt-driven loop (compat con provider che
        // supportano tool_use solo via JSON-in-response). Questo è il loop
        // legacy che resta come safety net se Layer 1 non ha pre-eseguito
        // nulla e il LLM dovesse comunque produrre un tool call JSON.
        if (enableTools !== false) {
          const augmentedHistory = [
            ...earlierHistory,
            { role: 'user' as const, content: augmentedUserMessage },
          ];
          for (let iter = 0; iter < 3; iter++) {
            const cleaned = reply
              .trim()
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```\s*$/i, '')
              .trim();
            if (!cleaned.startsWith('{')) break; // risposta normale, non tool call
            let toolCall: { tool?: unknown; args?: unknown };
            try {
              toolCall = JSON.parse(cleaned) as typeof toolCall;
            } catch {
              break;
            } // non è valid JSON, è una risposta normale
            const toolName = typeof toolCall.tool === 'string' ? toolCall.tool : '';
            if (!toolName) break;
            const args = (
              toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {}
            ) as Record<string, unknown>;
            let toolResult: string;
            try {
              if (toolName === 'fetch_url') {
                const { fetchUrl } = await import('../services/web-tools.service.js');
                const r = await fetchUrl(coerceString(args.url ?? ''));
                toolResult = JSON.stringify({
                  ok: true,
                  ...r,
                  content: r.content.slice(0, 20_000),
                });
              } else if (toolName === 'web_search') {
                const { webSearch } = await import('../services/web-tools.service.js');
                const r = await webSearch(coerceString(args.query ?? ''), Number(args.limit ?? 10));
                toolResult = JSON.stringify({ ok: true, ...r });
              } else {
                toolResult = JSON.stringify({ ok: false, error: `Tool sconosciuto: ${toolName}` });
              }
            } catch (e) {
              toolResult = JSON.stringify({
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
            // Ri-prompt con tool_result iniettato come messaggio user
            augmentedHistory.push({ role: 'assistant', content: cleaned });
            augmentedHistory.push({
              role: 'user',
              content: `tool_result(${toolName}): ${toolResult}`,
            });
            const lastUserNew = augmentedHistory[augmentedHistory.length - 1]?.content ?? '';
            reply = await dispatchLLMChat(
              resolved.provider,
              resolved.apiKey,
              resolved.model,
              systemPrompt ?? '',
              lastUserNew,
              resolved.baseUrl,
              augmentedHistory.slice(0, -1),
            );
          }
        }

        // Salva risposta assistant
        sqlite
          .prepare(
            `
        INSERT INTO ai_chat_messages (session_id, role, content, model) VALUES (?, 'assistant', ?, ?)
      `,
          )
          .run(id, reply, `${resolved.provider}:${resolved.model}`);
        // Auto-title se vuoto: usa le prime 60 char della 1° user msg
        if (!session.title) {
          const newTitle = content.length > 60 ? `${content.slice(0, 60)}…` : content;
          sqlite
            .prepare(
              `UPDATE ai_chat_sessions SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
            )
            .run(newTitle, id);
        } else {
          sqlite
            .prepare(
              `UPDATE ai_chat_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
            )
            .run(id);
        }
        return c.json({ reply, provider: resolved.provider, model: resolved.model });
      } catch (err) {
        logger.error({ err, tenantId, sessionId: id }, 'ai-chat dispatch failed');
        return c.json(
          { error: 'dispatch_failed', message: err instanceof Error ? err.message : String(err) },
          502,
        );
      }
    },
  );

  /** PATCH /sessions/:id — rinomina */
  app.patch('/sessions/:id', zValidator('json', RenameSchema), (c) => {
    const auth = c.get('auth') as { userId: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const { title } = c.req.valid('json');
    const { sqlite } = getDatabase();
    const r = sqlite
      .prepare(
        `
      UPDATE ai_chat_sessions SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `,
      )
      .run(title, id, tenantId, auth.userId);
    if (r.changes === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  /** DELETE /sessions/:id — eliminazione GDPR (cascade su messages) */
  app.delete('/sessions/:id', (c) => {
    const auth = c.get('auth') as { userId: string } | null;
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const { sqlite } = getDatabase();
    const r = sqlite
      .prepare(
        `
      DELETE FROM ai_chat_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?
    `,
      )
      .run(id, tenantId, auth.userId);
    if (r.changes === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Endpoint admin SEPARATO: cross-tenant visibility per superadmin.
 * Montato in admin.ts NON qui — qui esporto solo i query builder.
 */
export function listAllSessionsForSuperadmin(filters: {
  tenantId?: string;
  userId?: string;
  surface?: string;
}): SessionRow[] {
  const { sqlite } = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.tenantId) {
    where.push('tenant_id = ?');
    params.push(filters.tenantId);
  }
  if (filters.userId) {
    where.push('user_id = ?');
    params.push(filters.userId);
  }
  if (filters.surface) {
    where.push('surface = ?');
    params.push(filters.surface);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return sqlite
    .prepare(
      `
    SELECT id, tenant_id, user_id, surface, title, workflow_id, created_at, updated_at
    FROM ai_chat_sessions ${whereSql} ORDER BY updated_at DESC LIMIT 500
  `,
    )
    .all(...params) as SessionRow[];
}
