/**
 * AI Assistant — in-editor chat that proposes workflow edits.
 *
 * The model is invoked with the system prompt below and returns a strict JSON
 * envelope: { message: string, patch?: WorkflowPatch }. The editor renders
 * `message` in the chat and shows `patch` as a diff with Accept/Reject buttons.
 *
 * BYO LLM key: header X-LLM-API-Key (Anthropic) — FlowForge
 * never stores or proxies the credential, per the on-prem licensing model.
 */

import { coerceString } from '@/lib/coerce.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { logger } from '@/lib/logger.js';
import { liaraBaseUrl } from '@/config.js';
import { AIInteractionsService } from '@/services/ai-interactions.service.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import { buildAiAssistantSystemPrompt, buildAiAssistantUserContent } from '@/prompts/ai-assistant.prompt.js';
import { getTenantId } from '@/lib/tenant.js';
import { conversationService } from '@/services/ai-conversations/index.js';
import { buildCrossSurfaceContext } from '@/services/ai-conversations/cross-surface-context.js';
import { detectIntents, executeIntents, formatToolResultsForPrompt, type DetectedIntent } from '@/services/chat-intent.service.js';
import {
  coerceAssistantReply,
  NodeRefSchema,
  EdgeRefSchema,
  AssistantReplySchema,
  ASSISTANT_REPLY_JSON_SCHEMA,
} from './ai-assistant-reply.js';

const WorkflowSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  nodes: z.array(NodeRefSchema),
  edges: z.array(EdgeRefSchema),
});

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

const RequestSchema = z.object({
  workflow: WorkflowSnapshotSchema,
  /**
   * Legacy client-side history (deprecated). Tollerato per backward-compat
   * con sessioni in flight. Da Phase 1 in poi la history vera vive in
   * ai_messages e viene materializzata server-side via ConversationService.
   * Quando conversationId e\` fornito, history viene IGNORATA.
   */
  history: z.array(ChatMessageSchema).max(40).optional().default([]),
  userMessage: z.string().min(1).max(8000),
  provider: z.string().optional(),
  /**
   * NEW Phase 1: persistent conversation memory. Se omesso, viene creata
   * una nuova conversation scoped a (user, workspace?, surface=editor_chat).
   */
  conversationId: z.string().uuid().optional(),
  workspaceId: z.string().optional(),
  workflowId: z.string().optional(),
  attachments: z.array(z.object({
    kind: z.enum(['image', 'document', 'url']),
    name: z.string().max(500),
    mimeType: z.string().max(120).optional(),
    dataBase64: z.string().optional(),
    url: z.string().url().optional(),
  })).max(10).optional(),
});

// AssistantReplySchema + ASSISTANT_REPLY_JSON_SCHEMA vivono nel modulo PURO
// ai-assistant-reply.ts (testabili senza i service della route).

// Prompt assembly is delegated to prompts/ai-assistant.prompt.ts so the
// system prompt can be diff'd / snapshot-tested in isolation.

export function createAiAssistantRoutes(): Hono {
  const app = new Hono();

  app.post('/ai-assistant/chat', llmRateLimit('ai-assistant'), zValidator('json', RequestSchema), async (c) => {
    const startTime = Date.now();
    const tenantId = getTenantId(c);
    const headerKey = c.req.header('x-llm-api-key') ?? '';
    const body = c.req.valid('json') as {
      history: { role: 'user' | 'assistant'; content: string }[];
      workflow: unknown;
      userMessage: string;
      provider?: string;
      conversationId?: string;
      workspaceId?: string;
      workflowId?: string;
      attachments?: {
        kind: 'image' | 'document' | 'url';
        name: string;
        mimeType?: string;
        dataBase64?: string;
        url?: string;
      }[];
    };
    // PHASE 1 — persistent conversation memory.
    // Per editor_chat surface, the user is identified via auth context.
    //
    // AUDIT FIX BYOK-11 (2026-06-09 HIGH): rimosso fallback `x-user-id` header
    // → impersonation attack. Pre-fix: se auth.userId mancante, qualsiasi
    // caller poteva mandare `X-User-Id: <target-uid>` e accedere alle
    // conversazioni di altro user (conversationService.findOrCreate confronta
    // existing.userId === input.userId → con userId attacker-controlled passa).
    // Stesso problema su GET /conversations e DELETE /conversations/:id.
    //
    // Post-fix: auth.userId required (set dal middleware auth dopo verifySession
    // sul cookie HttpOnly). Senza auth → 401. NO fallback header.
    const auth = c.get('auth');
    if (!auth?.userId) {
      logger.warn({ tenantId }, '[SECURITY BYOK-11] ai-assistant called without auth.userId — rejecting');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const userId = auth.userId;
    let conversation;
    try {
      conversation = conversationService.findOrCreate(body.conversationId, {
        userId,
        surface: 'editor_chat',
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        ...(body.workflowId ? { workflowId: body.workflowId } : {}),
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), tenantId, userId },
        '[ai-assistant] conversation resolve failed',
      );
      return c.json({ error: 'Failed to resolve conversation' }, 500);
    }

    // Append user message FIRST (auditable even if LLM fails).
    conversationService.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: body.userMessage,
    });

    // Server-materialized history: sliding window (20 turns / 8K tokens) +
    // summary if present. Ignora body.history (legacy client-side).
    const ctx = conversationService.buildContext(conversation.id, {
      maxTurns: 20,
      maxTokens: 8192,
    });
    // Esclude l'ULTIMO turno (l'abbiamo appena INSERT-ato come current user message).
    const historyForLlm = ctx.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1)
      .map(({ role, content }) => ({ role, content }) as { role: 'user' | 'assistant'; content: string });

    // Provider resolution delegated to LlmResolverService — single source of
    // truth for "which LLM for this tenant?" (DRY across ai-assistant,
    // run-explain, help-chat). The resolver also enforces the Liara
    // env-or-tenant disable rule.
    let provider: string;
    let apiKey: string;
    let model: string;
    let baseUrl: string | undefined;
    try {
      const resolveOpts: { requestedProvider?: string; headerApiKey?: string } = {};
      if (body.provider) resolveOpts.requestedProvider = body.provider;
      if (headerKey) resolveOpts.headerApiKey = headerKey;
      const resolved = llmResolver.resolve(tenantId, resolveOpts);
      provider = resolved.provider;
      apiKey = resolved.apiKey;
      model = resolved.model;
      baseUrl = resolved.baseUrl;
    } catch (err) {
      if (err instanceof NoLlmProviderError) {
        return c.json({ error: err.message }, err.httpStatus);
      }
      throw err;
    }

    if (provider !== 'liara' && provider !== 'ollama' && !apiKey) {
      return c.json({ error: `Nessuna API key per ${provider}. Configurala in Settings → AI Providers o passa X-LLM-API-Key in header.` }, 401);
    }

    // CATALOG RETRIEVAL (2026-06-12): invece del catalogo completo nel prompt
    // (~100k token → Liara 400), recupera le famiglie + i top-k nodi pertinenti
    // al messaggio dell'utente E ai nodi già nel workflow corrente. Provider-
    // agnostico: vale identico per Liara e per i BYOK. Fail-soft: se il
    // retrieval esplode, il blocco resta vuoto e il modello chiede chiarimenti
    // (mai un 500 per colpa del retrieval).
    let catalogBlock = '';
    try {
      const { getCatalogRetriever, formatCatalogForPrompt } = await import('@/services/catalog-retrieval/index.js');
      const { searchMarketplace, formatMarketplaceSuggestions } = await import('@/services/catalog-retrieval/marketplace-discovery.js');
      const inUseDefIds = Array.isArray((body.workflow as { nodes?: { defId?: string }[] })?.nodes)
        ? ((body.workflow as { nodes: { defId?: string }[] }).nodes
            .map((n) => n.defId).filter((d): d is string => typeof d === 'string'))
        : [];
      // Catalogo del tenant E discovery marketplace IN PARALLELO — niente
      // latenza sommata. Entrambi fail-soft: il marketplace giù non blocca la
      // chat (searchMarketplace ritorna [] su qualunque problema).
      const retriever = await getCatalogRetriever(tenantId);
      const [retrieved, marketplace] = await Promise.all([
        retriever.retrieve(body.userMessage, { inUseDefIds }),
        searchMarketplace(body.userMessage),
      ]);
      catalogBlock = formatCatalogForPrompt(retriever, retrieved) + formatMarketplaceSuggestions(marketplace);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[ai-assistant] catalog retrieval failed — prompt senza catalogo');
    }
    const baseSystem = buildAiAssistantSystemPrompt(catalogBlock);

    // FIX 2026-05-30: deterministic intent + attachment auto-dispatch.
    // BEFORE LLM call (pattern ChatGPT Browsing / Perplexity / Claude.ai):
    //   - URL embedded → fetch_url
    //   - "esegui workflow X" → run_workflow
    //   - "attiva/disattiva X" → set_workflow_enabled
    //   - "configura nodo X" → configure_node
    //   - attachment image → analyze_image (Qwen2.5-VL)
    //   - attachment PDF → extract_document
    interface ToolEvent {
      tool: string; args: unknown; result?: unknown; errorMessage?: string;
      status: 'ok' | 'error'; elapsedMs?: number;
    }
    const toolEvents: ToolEvent[] = [];
    const attachmentIntents: DetectedIntent[] = [];
    // OPERA D'ARTE (2026-06-22): per LIARA le IMMAGINI vanno DIRETTE come content
    // multimodale della chat (Qwen3-VL legge i pixel nativamente — 1 call, fedeltà
    // piena). Per i provider BYOK non-Liara (il cui dispatch è solo testo) si tiene
    // il pre-pass vision `analyze_image` come prima → nessuna regressione.
    // Documenti (PDF→testo) e URL restano intent perché NON sono vision-native.
    const chatImages: { base64: string; mimeType: string }[] = [];
    if (Array.isArray(body.attachments)) {
      for (const att of body.attachments) {
        if (att.kind === 'image' && att.dataBase64) {
          if (provider === 'liara') {
            chatImages.push({ base64: att.dataBase64, mimeType: att.mimeType ?? 'image/png' });
          } else {
            attachmentIntents.push({
              type: 'analyze_image',
              args: { imageBase64: att.dataBase64, imagePrompt: `Analizza ${att.name}: estrai testo e dati strutturati.` },
              reason: `image attachment: ${att.name}`,
            });
          }
        } else if (att.kind === 'document' && att.dataBase64 && att.mimeType) {
          attachmentIntents.push({
            type: 'extract_document',
            args: { documentBase64: att.dataBase64, documentMime: att.mimeType, documentName: att.name },
            reason: `document attachment: ${att.name}`,
          });
        } else if (att.kind === 'url' && att.url) {
          attachmentIntents.push({
            type: 'fetch_url', args: { url: att.url }, reason: `URL attachment: ${att.url}`,
          });
        }
      }
    }

    let webContext = '';
    try {
      const t0 = Date.now();
      const detected = detectIntents(body.userMessage);
      const allIntents = [...attachmentIntents, ...detected];
      if (allIntents.length > 0) {
        const executed = await executeIntents(allIntents, { provider, apiKey, model, baseUrl });
        webContext = formatToolResultsForPrompt(executed);
        for (const r of executed) {
          toolEvents.push({
            tool: r.intent.type,
            args: r.intent.args,
            ...(r.error ? { errorMessage: r.error } : { result: r.data }),
            status: r.error ? 'error' : 'ok',
            elapsedMs: Date.now() - t0,
          });
        }
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[ai-assistant] auto-intent failed');
    }

    // Contesto cross-surface: cosa l'utente stava facendo nelle ALTRE schede
    // (editor nodi / db-studio / aiuto) dello stesso workspace → Liara non
    // chiede di rispiegare. Fail-soft (mai rompe la chat). Esclude la conv corrente.
    const crossSurface = buildCrossSurfaceContext(userId, body.workspaceId, { excludeConversationId: conversation.id });

    const system = [
      baseSystem,
      ctx.summary ? `[CONVERSATION SUMMARY SO FAR]\n${ctx.summary}` : '',
      crossSurface,
      webContext,
    ].filter((s) => s.length > 0).join('\n\n');
    const userContent = buildAiAssistantUserContent(body.workflow, body.userMessage);

    // Race #10 fix DD audit (2026-06-01) — budget recording correttezza
    // su tutti i path (success E failure). Pre-fix: dispatchLLMChat poteva
    // throw post-stream (timeout, parse error) e il tracker.record veniva
    // skippato → tokens consumati dal provider ma NON contati nel budget
    // utente → over-quota silente.
    // Fix: outer try/catch + tracker.record SEMPRE eseguito con `isError`
    // appropriato. Token usage capturato via closure callback anche su
    // failure parziale (stream con N chunks consumed prima del throw).
    let chatUsage: { input: number; output: number; fromApi: boolean } = { input: 0, output: 0, fromApi: false };
    let llmError: unknown = null;
    let llmText = '';
    // Context window del modello — per il contatore di contesto del chatter
    // (used/window) e per la soglia di compaction token-based ("identico a
    // Claude Code": comprimi al riempimento, non a conteggio messaggi).
    let contextWindow = 40960;
    try {
      const dispatcher = await import('../services/llm-chat.service.js');
      contextWindow = dispatcher.getLiaraContextWindow();
      const clientRequestId = (c.req.header('x-ff-request-id') ?? '').trim();
      // STRATO 1 — constrained decoding: Liara è COSTRETTA a emettere un envelope
      // JSON valido {message, patch?} (guided_json/xgrammar). Niente più output in
      // prosa → 502 (incident 2026-06-16). requestId propagato → posizione coda live.
      llmText = (await dispatcher.dispatchLLMChatStructured(
        provider, apiKey, model, system, userContent, baseUrl, historyForLlm,
        ASSISTANT_REPLY_JSON_SCHEMA,
        (u) => { chatUsage = u; },
        clientRequestId || undefined,
        chatImages.length > 0 ? chatImages : undefined,
      )).trim();
    } catch (err) {
      llmError = err;
    }
    // Record budget SEMPRE — success o error — dopo il dispatch.
    try {
      const { workflowCallTracker } = await import('../services/ai-budget/workflow-call-tracker.service.js');
      workflowCallTracker.recordChatBudget({
        provider, model,
        inputTokens: chatUsage.input, outputTokens: chatUsage.output,
        isError: llmError !== null,
      });
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, '[ai-assistant] recordChatBudget failed (non-fatal)');
    }
    if (llmError !== null) {
      // Context overflow → 413 con messaggio CHIARO (non 500 'Errore interno').
      const { LlmContextOverflowError, LlmProviderUnavailableError } = await import('../services/llm-chat.service.js');
      if (llmError instanceof LlmContextOverflowError) {
        logger.warn(
          { tenantId, estimatedTokens: llmError.estimatedTokens, contextWindow: llmError.contextWindow },
          '[ai-assistant] context overflow',
        );
        return c.json({ error: llmError.message, code: 'CONTEXT_TOO_LONG' }, 413);
      }
      // Provider selezionato giù (es. Liara offline in gen-mode) → 503 CHIARO,
      // mai swap silenzioso su un'altra chiave. La UI mostra il messaggio + il
      // provider effettivo così l'utente sa cosa è successo e può cambiarlo.
      if (llmError instanceof LlmProviderUnavailableError) {
        logger.warn({ tenantId, provider: llmError.provider }, '[ai-assistant] provider unavailable');
        return c.json({ error: llmError.message, code: 'PROVIDER_UNAVAILABLE', provider: llmError.provider }, 503);
      }
      throw llmError instanceof Error ? llmError : new Error(coerceString(llmError));
    }
    const text = llmText;
    try {
      // STRATO 2 — estrazione robusta + FALLBACK GRAZIOSO (mai 502). Il constrained
      // decoding (strato 1) garantisce JSON valido con Liara; per BYOK/edge che
      // tornano prosa o JSON non conforme, coerceAssistantReply degrada a
      // { message: <testo> }. La chat risponde SEMPRE.
      const coerced = coerceAssistantReply(text, (v) => {
        const r = AssistantReplySchema.safeParse(v);
        return r.success ? ({ success: true, data: r.data } as const) : ({ success: false } as const);
      });
      if (!coerced.conformed) {
        logger.warn(
          { tenantId, provider, model: model || '(default)' },
          '[ai-assistant] output LLM non conforme allo schema → fallback a messaggio testuale (no 502)',
        );
      }
      const reply: z.infer<typeof AssistantReplySchema> = coerced.reply;

      // FIX 2026-05-30 user-segnalato: per messaggi conversazionali ("ciao",
      // "che fa questo workflow?") il LLM ritorna patch:{} (object vuoto)
      // → il frontend renderizzava "Modifica proposta" con zero items + bottone
      // Applica/Rifiuta inutili. Normalizziamo: se patch ha zero ops reali,
      // lo SCARTIAMO dal response.
      const p = reply.patch;
      const hasOps = !!p && (
        (p.addNodes?.length ?? 0) > 0 ||
        (p.removeNodeIds?.length ?? 0) > 0 ||
        (p.addEdges?.length ?? 0) > 0 ||
        (p.removeEdgeIds?.length ?? 0) > 0 ||
        (p.updateNodes?.length ?? 0) > 0
      );
      const finalReply: z.infer<typeof AssistantReplySchema> = hasOps ? reply : { message: reply.message };
      // Training-set capture: persist the interaction (PII-redacted) into
      // ai_interactions so we can later build a fine-tuning dataset. The
      // service honors per-tenant opt-out and never throws on failure
      // (failing capture should not break the AI call).
      const captureService = new AIInteractionsService();
      const wfSnapshot = (body.workflow ?? null) as unknown;
      const workflowIdFromSnap = wfSnapshot && typeof wfSnapshot === 'object' && 'id' in wfSnapshot && typeof (wfSnapshot).id === 'string'
        ? (wfSnapshot as { id: string }).id
        : undefined;
      // AUDIT FIX BYOK-11 (2026-06-09): userId solo da auth (cookie), no header.
      const interactionId = captureService.insert({
        context: {
          tenantId,
          ...(auth?.userId ? { userId: auth.userId } : {}),
          ...(workflowIdFromSnap ? { workflowId: workflowIdFromSnap } : {}),
        },
        interactionType: 'editor_chat',
        request: {
          prompt: body.userMessage,
          workflowSnapshot: wfSnapshot,
          conversationHistory: body.history,
        },
        response: {
          message: finalReply.message,
          ...(finalReply.patch ? { patch: finalReply.patch } : {}),
          model: `${provider}/${model || '(default)'}`,
          latencyMs: Date.now() - startTime,
        },
      });

      // PHASE 1 — persist assistant turn nella conversation memory.
      const latencyMs = Date.now() - startTime;
      const appendInput: Parameters<typeof conversationService.appendMessage>[0] = {
        conversationId: conversation.id,
        role: 'assistant',
        content: finalReply.message,
        provider,
        latencyMs,
      };
      if (model) appendInput.model = model;
      if (finalReply.patch) appendInput.patch = finalReply.patch;
      conversationService.appendMessage(appendInput);

      // Background: trigger summary compaction se serve (fire-and-forget).
      // In Phase 2 questo job sara\` spostato in BullMQ con priorita\` low.
      // Soglia TOKEN-based al 75% della finestra del modello — comprimi quando
      // il contesto si riempie (come Claude Code), lasciando margine per la
      // prossima risposta. Vedi conversationService.needsCompaction.
      const compactionThresholdTokens = Math.floor(contextWindow * 0.75);
      if (conversationService.needsCompaction(conversation.id, { maxContextTokens: compactionThresholdTokens })) {
        void Promise.resolve().then(async () => {
          try {
            const { trySummarize } = await import('@/services/ai-conversations/summary.service.js');
            await trySummarize(conversation.id, provider, apiKey, model, baseUrl, { maxContextTokens: compactionThresholdTokens });
          } catch (err) {
            logger.warn(
              { conversationId: conversation.id, err: err instanceof Error ? err.message : String(err) },
              '[ai-assistant] background summary failed',
            );
          }
        });
      }

      // Echo interaction id + conversationId back so the UI can resume + record outcome.
      // + usage token (input/output) per mostrarli nel chatter dell'editor.
      return c.json({
        ...finalReply,
        interactionId,
        conversationId: conversation.id,
        // Provider+model EFFETTIVI che hanno risposto → la UI mostra l'avatar
        // veritiero per QUESTO messaggio (fine della "foto di Liara mentre
        // risponde Claude"). Niente più disallineamento brand↔provenienza.
        provider,
        ...(model ? { model } : {}),
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        usage: { input: chatUsage.input, output: chatUsage.output },
        // Contatore di contesto: `used` = token del prompt EFFETTIVAMENTE inviato
        // al modello in questo turno (system+summary+history+immagini+messaggio
        // = chatUsage.input, provider-reported se disponibile), `window` = finestra
        // del modello. La UI mostra una barra used/window (verde→giallo→rosso).
        context: { used: chatUsage.input, window: contextWindow },
      });
    } catch (err) {
      logger.error({ err }, 'AI assistant chat failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // PHASE 1 — list conversations per user (per editor sidebar UX).
  // Risposta camelCase + title derivato dal primo user message se assente.
  app.get('/ai-assistant/conversations', (c) => {
    // AUDIT FIX BYOK-11 (2026-06-09): no x-user-id fallback.
    const auth = c.get('auth');
    const userId = auth?.userId;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const workspaceId = c.req.query('workspaceId');
    const surface = c.req.query('surface') as 'editor_chat' | 'wizard_scaffold' | 'help_chat' | undefined;
    const rows = conversationService.listForUser(userId, {
      ...(surface ? { surface } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      limit: 50,
    });
    // Deriva titolo dal primo user message se non gia\` impostato (lazy title).
    const conversations = rows.map((r) => {
      let title = r.title;
      if (!title) {
        try {
          const msgs = conversationService.getRecentMessages(r.id, 5);
          const firstUser = msgs.find((m) => m.role === 'user');
          if (firstUser) {
            title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 80);
          }
        } catch { /* fallback null */ }
      }
      return {
        id: r.id,
        title,
        surface: r.surface,
        messageCount: r.messageCount,
        lastMessageAt: r.lastMessageAt,
        createdAt: r.createdAt,
        workspaceId: r.workspaceId,
      };
    });
    return c.json({ conversations });
  });

  // PHASE 1 — get messages of a conversation (sliding window).
  app.get('/ai-assistant/conversations/:id/messages', (c) => {
    // AUDIT FIX BYOK-11 (2026-06-09): no x-user-id fallback.
    const auth = c.get('auth');
    const userId = auth?.userId;
    if (!userId) return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
    const id = c.req.param('id');
    const conv = conversationService.getById(id);
    if (conv?.userId !== userId) return Promise.resolve(c.json({ error: 'Not found' }, 404));
    const messages = conversationService.getRecentMessages(id, 50);
    return Promise.resolve(c.json({ conversation: conv, messages }));
  });

  // PHASE 1 — soft-delete conversation (GDPR right-to-erasure).
  app.delete('/ai-assistant/conversations/:id', (c) => {
    // AUDIT FIX BYOK-11 (2026-06-09): no x-user-id fallback.
    const auth = c.get('auth');
    const userId = auth?.userId;
    if (!userId) return Promise.resolve(c.json({ error: 'Unauthorized' }, 401));
    const ok = conversationService.softDelete(c.req.param('id'), userId);
    if (!ok) return Promise.resolve(c.json({ error: 'Not found' }, 404));
    return Promise.resolve(c.json({ ok: true }));
  });

  // ─── Queue-status SSE proxy — canale-posizione coda LLM ────────────
  // L'editor apre questo stream con lo STESSO rid inviato sulla chat
  // (X-FF-Request-Id) per mostrare "N persone prima di te". Pass-through SSE
  // verso il gateway portal (/api/v1/llm/queue-status), che pubblica la
  // posizione dal canale Redis condiviso. Niente Redis nel runtime (potrebbe
  // non condividerlo): la posizione viaggia sulla rete. Vedi admission.
  app.get('/ai-assistant/queue-status', (c) => {
    const auth = c.get('auth');
    if (!auth?.userId) return c.json({ error: 'Unauthorized' }, 401);
    const rid = (c.req.query('rid') ?? '').trim();
    if (!rid) return c.json({ error: 'rid query param required' }, 400);

    const licenseKey = process.env.MEDEA_LICENSE_KEY ?? '';
    const url = `${liaraBaseUrl()}/queue-status?rid=${encodeURIComponent(rid)}`;

    return streamSSE(c, async (stream) => {
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          headers: {
            Accept: 'text/event-stream',
            ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
          },
          // Disconnessione dell'editor → abort → il portal chiude il pump.
          signal: c.req.raw.signal,
        });
      } catch {
        await stream.writeSSE({ event: 'gone', data: '{}' });
        return;
      }
      if (!upstream.ok || !upstream.body) {
        await stream.writeSSE({ event: 'gone', data: '{}' });
        return;
      }
      // Pass-through dei frame SSE del portal (queued/admitted/gone), raw.
      // `getReader()` non porta con sé il tipo dei blocchi letti: senza
      // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
      const reader: ReadableStreamDefaultReader<Uint8Array> = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await stream.write(decoder.decode(value, { stream: true }));
        }
      } catch { /* abort/disconnect — fine stream */ }
    });
  });

  return app;
}
