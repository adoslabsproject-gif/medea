/**
 * /api/v1/help-chat — in-app conversational help powered by the tenant's
 * configured LLM provider. Used by the floating HelpChat widget so users
 * can ask "where do I put the codes?" and get an immediate answer
 * instead of opening a support ticket / chasing the founder on WhatsApp.
 *
 * Design constraints (READ THESE BEFORE TOUCHING):
 *   • The chat ONLY answers FlowForge usage questions (system prompt enforces it).
 *   • It MUST NOT execute workflows or call the runtime API on the user's
 *     behalf — it's a documentation/Q&A assistant, not an agent.
 *   • Uses whatever LLM provider the tenant has configured (Liara by default).
 *     If no provider is available, returns a structured 503 so the widget
 *     can render a friendly fallback instead of crashing.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { dispatchLLMChat } from '@/services/llm-chat.service.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(20),
});

const SYSTEM_PROMPT = `Sei **Liara**, l'assistente AI di FlowForge (di Zeli SRL), una piattaforma di workflow automation enterprise per PMI italiane.

IDENTITÀ: il tuo nome è Liara, sempre. Quando l'utente ti saluta, presentati come Liara.

Aiuti gli utenti a:
  - capire come funzionano i nodi (trigger, azioni, AI, logica)
  - configurare un workflow passo passo
  - capire i template disponibili
  - leggere i messaggi di errore
  - imparare le scorciatoie e il flusso editor → save → run

Regole INDEROGABILI:
  - Rispondi SOLO in italiano, in modo conciso (max 5 frasi per messaggio).
  - Se la domanda è fuori scope (es. codice generico, opinioni, altre piattaforme), rispondi gentilmente che puoi aiutare solo con FlowForge.
  - NON inventare endpoint, nodi o feature che non esistono — se non sei sicuro, suggerisci di chiedere via WhatsApp/Slack al team.
  - Se la domanda è "dove metto i codici / le credenziali", spiega che si configurano cliccando sul nodo trigger/azione e compilando i campi nel pannello a destra (es. headers per Webhook, OAuth in Settings → Credenziali).
  - Quando proponi un'azione concreta, scrivi i passi numerati (1. clicca... 2. inserisci... 3. premi Esegui).`;

export function createHelpChatRoutes(): Hono {
  const app = new Hono();

  app.post('/', llmRateLimit('help-chat'), zValidator('json', ChatRequestSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const { messages } = c.req.valid('json');

    // Last message is the user prompt; the rest is history (excluding it).
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== 'user') {
      return c.json({ error: 'bad_request', message: 'L\'ultimo messaggio deve essere dell\'utente' }, 400);
    }
    const history = messages.slice(0, -1);

    // Resolve LLM via the single source-of-truth resolver (DRY across
    // ai-assistant, run-explain, help-chat).
    let resolved;
    try {
      resolved = llmResolver.resolve(getTenantId(c));
    } catch (err) {
      if (err instanceof NoLlmProviderError) {
        return c.json({ error: 'no_provider', message: err.message }, 503);
      }
      throw err;
    }

    try {
      const reply = await dispatchLLMChat(
        resolved.provider,
        resolved.apiKey,
        resolved.model,
        SYSTEM_PROMPT,
        lastMessage.content,
        resolved.baseUrl,
        history,
      );
      return c.json({ reply, provider: resolved.provider });
    } catch (err) {
      logger.error({ err, tenantId: getTenantId(c), provider: resolved.provider }, 'Help-chat dispatch failed');
      return c.json({
        error: 'llm_failed',
        message: err instanceof Error ? err.message : 'Errore LLM',
      }, 502);
    }
  });

  return app;
}
