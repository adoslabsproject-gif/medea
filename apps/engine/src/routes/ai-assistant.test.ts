/**
 * Test 2026-grade — ai-assistant route (chat + conversations CRUD).
 *
 * Coverage REALE con tutti i service mockati e LLM dispatch testato e2e:
 *  - POST /chat:
 *    - zod 400 (userMessage > 8000, missing workflow), 401 senza apiKey provider
 *      non-liara/ollama, NoLlmProviderError → httpStatus custom
 *    - conversation findOrCreate throw → 500 "Failed to resolve conversation"
 *    - 🚨 user message inserito SEMPRE (audit anche se LLM fail dopo)
 *    - intent detection + attachment auto-dispatch (image/document/url)
 *    - LLM ritorna JSON valido + patch valido → assistant turn salvato
 *    - LLM ritorna non-JSON → 200 fallback grazioso (message = testo grezzo, MAI 502)
 *    - LLM ritorna JSON ma schema invalido → 200 fallback grazioso (MAI 502)
 *    - prosa + JSON valido in mezzo → estrazione envelope bilanciato
 *    - 🚨 patch vuoto (no ops) → scartato dal response (UX no fake "modifiche")
 *    - patch con ops → preservato + toolEvents popolato
 *    - workflowCallTracker.recordChatBudget chiamato SEMPRE (success E error)
 *  - GET /conversations: 401, lista per userId, title derivato da first user
 *    message se assente
 *  - GET /conversations/:id/messages: 404 cross-user, messages cap 50
 *  - DELETE /conversations/:id: 404 se softDelete false (no leak)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => {
  class NoLlmProviderError extends Error {
    override name = 'NoLlmProviderError';
    httpStatus: number;
    constructor(msg: string, httpStatus = 503) {
      super(msg);
      this.httpStatus = httpStatus;
    }
  }
  return {
    NoLlmProviderError,
    resolve: vi.fn(),
    findOrCreate: vi.fn(),
    appendMessage: vi.fn(),
    buildContext: vi.fn(),
    getById: vi.fn(),
    getRecentMessages: vi.fn(),
    softDelete: vi.fn(),
    needsCompaction: vi.fn(),
    listForUser: vi.fn(),
    dispatchLLM: vi.fn(),
    recordChatBudget: vi.fn(),
    aiInteractionsInsert: vi.fn(),
    detectIntents: vi.fn(),
    executeIntents: vi.fn(),
    formatToolResults: vi.fn(),
    trySummarize: vi.fn(),
  };
});

vi.mock('@/lib/logger.js');

vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock('@/services/llm-resolver.service.js', () => ({
  NoLlmProviderError: m.NoLlmProviderError,
  llmResolver: { resolve: (t: string, opts: unknown) => m.resolve(t, opts) },
}));

vi.mock('@/services/ai-conversations/index.js', () => ({
  conversationService: {
    findOrCreate: (id: string | undefined, opts: unknown) => m.findOrCreate(id, opts),
    appendMessage: (args: unknown) => m.appendMessage(args),
    buildContext: (id: string, opts: unknown) => m.buildContext(id, opts),
    getById: (id: string) => m.getById(id),
    getRecentMessages: (id: string, n: number) => m.getRecentMessages(id, n),
    softDelete: (id: string, userId: string) => m.softDelete(id, userId),
    needsCompaction: (id: string, opts?: unknown) => m.needsCompaction(id, opts),
    listForUser: (u: string, opts: unknown) => m.listForUser(u, opts),
  },
}));

vi.mock('@/services/ai-interactions.service.js', () => ({
  AIInteractionsService: class {
    insert(args: unknown) {
      return m.aiInteractionsInsert(args);
    }
  },
}));

vi.mock('@/services/chat-intent.service.js', () => ({
  detectIntents: (msg: string) => m.detectIntents(msg),
  executeIntents: (intents: unknown) => m.executeIntents(intents),
  formatToolResultsForPrompt: (r: unknown) => m.formatToolResults(r),
}));

vi.mock('@/prompts/ai-assistant.prompt.js', () => ({
  buildAiAssistantSystemPrompt: (catalogBlock: string) => `BASE SYSTEM\n${catalogBlock}`,
  buildAiAssistantUserContent: (_w: unknown, msg: string) => `${msg} [wf]`,
}));
// Catalog retrieval mockato: la route lo importa dinamicamente; restituiamo un
// retriever finto deterministico (no embedder, no buildNodeCatalog reale).
vi.mock('@/services/catalog-retrieval/index.js', () => ({
  getCatalogRetriever: async () => ({
    retrieve: async () => [
      {
        defId: 'trigger_webhook',
        type: 'trigger',
        label: 'WH',
        category: 'triggers',
        shortDesc: 'x',
        score: 1,
      },
    ],
    categoryMap: () => [],
  }),
  formatCatalogForPrompt: () => 'CATALOG_BLOCK',
}));
vi.mock('@/services/catalog-retrieval/marketplace-discovery.js', () => ({
  searchMarketplace: async () => [],
  formatMarketplaceSuggestions: () => '',
}));

vi.mock('../services/llm-chat.service.js', () => ({
  dispatchLLMChat: (...args: unknown[]) => m.dispatchLLM(...args),
  // La chat ora usa il path STRUTTURATO (constrained decoding). Stesso mock fn
  // così i fixture di output guidano entrambi i path.
  dispatchLLMChatStructured: (...args: unknown[]) => m.dispatchLLM(...args),
  // Finestra di contesto — usata dalla route per il contatore (response.context)
  // e per la soglia di compaction token-based.
  getLiaraContextWindow: () => 40960,
  // Esportata perché la route fa `instanceof LlmContextOverflowError` sul path 413.
  LlmContextOverflowError: class LlmContextOverflowError extends Error {
    estimatedTokens = 0;
    contextWindow = 0;
  },
  // Esportata perché la route fa `instanceof LlmProviderUnavailableError` sul path 503.
  LlmProviderUnavailableError: class LlmProviderUnavailableError extends Error {
    provider: string;
    constructor(provider: string) {
      super(`${provider} non è al momento raggiungibile`);
      this.provider = provider;
    }
  },
}));

vi.mock('../services/ai-budget/workflow-call-tracker.service.js', () => ({
  workflowCallTracker: {
    recordChatBudget: (args: unknown) => m.recordChatBudget(args),
  },
}));

vi.mock('@/services/ai-conversations/summary.service.js', () => ({
  trySummarize: (...a: unknown[]) => m.trySummarize(...a),
}));

import { createAiAssistantRoutes } from './ai-assistant.js';
import type { AuthContext } from '@/middleware/auth.js';

function buildApp(auth: Partial<AuthContext> | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) {
      const full: AuthContext = {
        userId: 'u1',
        email: 'e@x',
        tenantId: 't1',
        role: 'owner',
        ...auth,
      } as AuthContext;
      c.set('auth', full);
    }
    await next();
  });
  app.route('/', createAiAssistantRoutes());
  return app;
}

const baseWf = { id: 'wf-1', name: 'WF', nodes: [], edges: [] };
const baseBody = {
  workflow: baseWf,
  userMessage: 'add http_request',
  provider: 'anthropic',
};

beforeEach(() => {
  Object.values(m).forEach((f) => {
    if (typeof f === 'function' && 'mockReset' in f) (f as { mockReset: () => void }).mockReset();
  });
  m.resolve.mockReturnValue({
    provider: 'anthropic',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    baseUrl: undefined,
  });
  m.findOrCreate.mockReturnValue({ id: 'conv-1', userId: 'u1', surface: 'editor_chat' });
  m.buildContext.mockReturnValue({
    messages: [{ role: 'user', content: 'add http_request' }],
    summary: '',
  });
  m.needsCompaction.mockReturnValue(false);
  m.dispatchLLM.mockResolvedValue(
    '{"message": "OK", "patch": {"addNodes": [{"id":"n1","defId":"http_request"}]}}',
  );
  m.detectIntents.mockReturnValue([]);
  m.executeIntents.mockResolvedValue([]);
  m.formatToolResults.mockReturnValue('');
  m.aiInteractionsInsert.mockReturnValue('interaction-1');
});

describe('POST /ai-assistant/chat — input validation', () => {
  it('zod 400 userMessage missing', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: baseWf }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 userMessage > 8000 char', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: baseWf, userMessage: 'a'.repeat(8001) }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 attachments > 10', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        attachments: Array.from({ length: 11 }, (_, i) => ({ kind: 'image', name: `a-${i}` })),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /ai-assistant/chat — provider gating', () => {
  it("🚨 NoLlmProviderError → httpStatus dell'error", async () => {
    m.resolve.mockImplementation(() => {
      throw new m.NoLlmProviderError('no provider', 402);
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(402);
  });

  it('🚨 provider non-liara/ollama senza apiKey → 401', async () => {
    m.resolve.mockReturnValue({
      provider: 'anthropic',
      apiKey: '',
      model: 'x',
      baseUrl: undefined,
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain('API key');
  });

  it('provider=liara senza apiKey OK (no 401)', async () => {
    m.resolve.mockReturnValue({
      provider: 'liara',
      apiKey: '',
      model: 'qwen3',
      baseUrl: undefined,
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
  });

  it('errore generico resolve → THROW', async () => {
    m.resolve.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(500);
  });

  it('🚨 provider giù (Liara offline in gen-mode) → 503 PROVIDER_UNAVAILABLE, NIENTE swap silenzioso', async () => {
    const { LlmProviderUnavailableError } = (await import('../services/llm-chat.service.js')) as {
      LlmProviderUnavailableError: new (p: string) => Error;
    };
    m.resolve.mockReturnValue({
      provider: 'liara',
      apiKey: '',
      model: 'qwen3',
      baseUrl: undefined,
    });
    m.dispatchLLM.mockRejectedValue(new LlmProviderUnavailableError('liara'));
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(503);
    const j = (await res.json()) as { code: string; provider: string; error: string };
    expect(j.code).toBe('PROVIDER_UNAVAILABLE');
    expect(j.provider).toBe('liara');
    expect(j.error).toMatch(/raggiungibile/);
  });
});

describe('POST /ai-assistant/chat — provider echo (avatar veritiero)', () => {
  it('🚨 la risposta riporta provider+model EFFETTIVI usati', async () => {
    m.resolve.mockReturnValue({
      provider: 'anthropic',
      apiKey: 'sk',
      model: 'claude-opus-4-8',
      baseUrl: undefined,
    });
    m.dispatchLLM.mockResolvedValue('{"message": "ciao"}');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { provider: string; model: string };
    expect(j.provider).toBe('anthropic');
    expect(j.model).toBe('claude-opus-4-8');
  });
});

describe('POST /ai-assistant/chat — conversation memory', () => {
  it('findOrCreate throw → 500 "Failed to resolve conversation"', async () => {
    m.findOrCreate.mockImplementation(() => {
      throw new Error('db down');
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('Failed to resolve');
  });

  it('🚨 user message INSERTED prima del LLM (audit anche su LLM fail)', async () => {
    m.dispatchLLM.mockRejectedValue(new Error('LLM crash'));
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    // appendMessage role:user chiamato indipendentemente
    const userCall = m.appendMessage.mock.calls.find(
      (call) => (call[0] as { role: string }).role === 'user',
    );
    expect(userCall).toBeDefined();
  });

  it('conversation summary iniettato nel system prompt', async () => {
    m.buildContext.mockReturnValue({
      messages: [{ role: 'user', content: 'x' }],
      summary: 'PRIOR CONTEXT',
    });
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const system = m.dispatchLLM.mock.calls[0]![3] as string;
    expect(system).toContain('PRIOR CONTEXT');
  });

  it('needsCompaction=true → background summary fire-and-forget', async () => {
    m.needsCompaction.mockReturnValue(true);
    m.trySummarize.mockResolvedValue(undefined);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(m.trySummarize).toHaveBeenCalled();
  });
});

describe('POST /ai-assistant/chat — LLM output parsing', () => {
  it('happy path JSON valido + patch valido', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; patch?: unknown; conversationId: string };
    expect(body.message).toBe('OK');
    expect(body.patch).toBeDefined();
    expect(body.conversationId).toBe('conv-1');
  });

  it('🚨 response espone context { used, window } per il contatore del chatter', async () => {
    // dispatch invoca la usage callback (9° arg, index 8) → chatUsage.input
    // diventa il "contesto usato"; window = getLiaraContextWindow() mock.
    m.dispatchLLM.mockImplementation((...args: unknown[]) => {
      const usageCb = args[8] as (u: { input: number; output: number; fromApi: boolean }) => void;
      usageCb({ input: 1500, output: 300, fromApi: true });
      return Promise.resolve('{"message": "OK"}');
    });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const body = (await res.json()) as {
      usage: { input: number; output: number };
      context: { used: number; window: number };
    };
    expect(body.context).toEqual({ used: 1500, window: 40960 });
    // mutation: used = token del CONTESTO (input), non l'output né il totale
    expect(body.context.used).toBe(body.usage.input);
    expect(body.context.used).not.toBe(body.usage.output);
  });

  it('🚨 compaction token-based: needsCompaction + trySummarize ricevono la soglia (75% finestra)', async () => {
    m.needsCompaction.mockReturnValue(true);
    m.trySummarize.mockResolvedValue(undefined);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    await new Promise((r) => setTimeout(r, 10));
    // 75% di 40960 = 30720
    expect(m.needsCompaction).toHaveBeenCalledWith('conv-1', { maxContextTokens: 30720 });
    const call = m.trySummarize.mock.calls[0] as unknown[];
    expect(call[0]).toBe('conv-1');
    expect(call[5]).toEqual({ maxContextTokens: 30720 }); // soglia propagata come 6° arg
  });

  it('markdown fence ```json stripped', async () => {
    m.dispatchLLM.mockResolvedValue('```json\n{"message": "OK"}\n```');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
  });

  // CAMBIO DI COMPORTAMENTO 2026-06-16 (incident "Liara 502"): la chat NON
  // restituisce più 502 su output non conforme. Strato 2 (fallback grazioso):
  // l'output grezzo diventa un messaggio conversazionale → la chat risponde SEMPRE.
  it('🚨 FIX 2026-06-16: non-JSON (prosa) → 200 con message = testo grezzo (MAI 502)', async () => {
    m.dispatchLLM.mockResolvedValue('this is plain text');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; patch?: unknown };
    expect(body.message).toBe('this is plain text');
    expect(body.patch).toBeUndefined();
  });

  it('🚨 FIX 2026-06-16: JSON valido ma schema invalido (no message) → 200 fallback (MAI 502)', async () => {
    m.dispatchLLM.mockResolvedValue('{"foo": "bar"}');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    // niente campo message nell'output → il fallback usa il testo grezzo come messaggio.
    expect(body.message).toBe('{"foo": "bar"}');
  });

  it("🚨 FIX 2026-06-16: prosa + JSON valido in mezzo → estrae l'envelope (no 502)", async () => {
    m.dispatchLLM.mockResolvedValue(
      'Certo! Ecco la modifica:\n{"message": "Aggiunto", "patch": {"removeEdgeIds": ["e-9"]}}\nFammi sapere.',
    );
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; patch?: { removeEdgeIds?: string[] } };
    expect(body.message).toBe('Aggiunto');
    expect(body.patch?.removeEdgeIds).toEqual(['e-9']);
  });

  it('🚨 patch vuoto {} → scartato dal response (no fake UX)', async () => {
    m.dispatchLLM.mockResolvedValue('{"message": "ciao!", "patch": {}}');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const body = (await res.json()) as { message: string; patch?: unknown };
    expect(body.message).toBe('ciao!');
    expect(body.patch).toBeUndefined();
  });

  it('patch con removeEdgeIds preservato', async () => {
    m.dispatchLLM.mockResolvedValue('{"message": "ok", "patch": {"removeEdgeIds": ["e-1"]}}');
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const body = (await res.json()) as { patch: { removeEdgeIds: string[] } };
    expect(body.patch.removeEdgeIds).toEqual(['e-1']);
  });
});

describe('POST /ai-assistant/chat — budget tracker', () => {
  it('🚨 recordChatBudget chiamato anche se LLM throw (no over-quota silente)', async () => {
    m.dispatchLLM.mockRejectedValue(new Error('LLM died'));
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(m.recordChatBudget).toHaveBeenCalled();
    const args = m.recordChatBudget.mock.calls[0]![0] as { isError: boolean };
    expect(args.isError).toBe(true);
  });

  it('recordChatBudget con isError=false su success', async () => {
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const args = m.recordChatBudget.mock.calls[0]![0] as { isError: boolean };
    expect(args.isError).toBe(false);
  });
});

describe('POST /ai-assistant/chat — attachment auto-dispatch', () => {
  it('image attachment → analyze_image intent', async () => {
    m.executeIntents.mockResolvedValue([
      { intent: { type: 'analyze_image', args: {} }, data: 'OCR result' },
    ]);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        attachments: [{ kind: 'image', name: 'foto.png', dataBase64: 'base64data' }],
      }),
    });
    expect(m.executeIntents).toHaveBeenCalled();
    const intents = m.executeIntents.mock.calls[0]![0] as { type: string }[];
    expect(intents.some((i) => i.type === 'analyze_image')).toBe(true);
  });

  it('document attachment → extract_document intent', async () => {
    m.executeIntents.mockResolvedValue([
      { intent: { type: 'extract_document', args: {} }, data: 'extracted' },
    ]);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        attachments: [
          { kind: 'document', name: 'doc.pdf', dataBase64: 'data', mimeType: 'application/pdf' },
        ],
      }),
    });
    const intents = m.executeIntents.mock.calls[0]![0] as { type: string }[];
    expect(intents.some((i) => i.type === 'extract_document')).toBe(true);
  });

  it('URL attachment → fetch_url intent', async () => {
    m.executeIntents.mockResolvedValue([{ intent: { type: 'fetch_url', args: {} }, data: 'page' }]);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        attachments: [{ kind: 'url', name: 'site', url: 'https://x.com' }],
      }),
    });
    const intents = m.executeIntents.mock.calls[0]![0] as { type: string }[];
    expect(intents.some((i) => i.type === 'fetch_url')).toBe(true);
  });

  it('toolEvents popolato nel response se intent executed', async () => {
    m.detectIntents.mockReturnValue([
      { type: 'fetch_url', args: { url: 'https://x' }, reason: 'inline' },
    ]);
    m.executeIntents.mockResolvedValue([
      { intent: { type: 'fetch_url', args: { url: 'https://x' } }, data: 'page' },
    ]);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const body = (await res.json()) as { toolEvents?: { tool: string; status: string }[] };
    expect(body.toolEvents).toBeDefined();
    expect(body.toolEvents![0]!.status).toBe('ok');
  });
});

describe('GET /ai-assistant/conversations', () => {
  it('401 senza userId (no auth + no header)', async () => {
    const res = await buildApp(null).request('/ai-assistant/conversations');
    expect(res.status).toBe(401);
  });

  /**
   * 🚨 AUDIT FIX BYOK-11 (2026-06-09 HIGH) — REGRESSION GUARD:
   *
   * Pre-fix: `userId = auth?.userId ?? c.req.header('x-user-id')` permetteva
   * impersonation: caller senza auth + header `X-User-Id: <target>` →
   * accesso conversazioni altrui.
   *
   * Post-fix: rimosso fallback header. Senza auth → 401, anche con
   * X-User-Id presente.
   */
  it('🚨 [REGRESSION BYOK-11] X-User-Id header presente MA no auth → 401 (impersonation impossibile)', async () => {
    const res = await buildApp(null).request('/ai-assistant/conversations', {
      headers: { 'x-user-id': 'attacker-target-uid' },
    });
    expect(res.status).toBe(401);
    // CRITICAL: listForUser NON deve essere stato chiamato (no DB query con uid forgiato)
    expect(m.listForUser).not.toHaveBeenCalled();
  });

  it('🚨 [REGRESSION BYOK-11] X-User-Id presente CON auth → header IGNORED, usato auth.userId', async () => {
    m.listForUser.mockReturnValue([]);
    await buildApp({ userId: 'u-real', tenantId: 't1' }).request('/ai-assistant/conversations', {
      headers: { 'x-user-id': 'evil-spoof' },
    });
    expect(m.listForUser).toHaveBeenCalledWith('u-real', expect.anything());
  });

  it('happy path: lista per user, title derivato dal first user msg se assente', async () => {
    m.listForUser.mockReturnValue([
      {
        id: 'c1',
        title: null,
        surface: 'editor_chat',
        messageCount: 3,
        lastMessageAt: '2026',
        createdAt: '2026',
        workspaceId: 'ws-1',
      },
    ]);
    m.getRecentMessages.mockReturnValue([
      { role: 'user', content: 'My first question that is too long to fit' },
    ]);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations',
    );
    const body = (await res.json()) as { conversations: { title: string | null }[] };
    expect(body.conversations[0]!.title).toBeTruthy();
    expect(body.conversations[0]!.title!.length).toBeLessThanOrEqual(80);
  });

  it('title pre-esistente preservato', async () => {
    m.listForUser.mockReturnValue([
      {
        id: 'c1',
        title: 'Existing Title',
        surface: 'editor_chat',
        messageCount: 1,
        lastMessageAt: '2026',
        createdAt: '2026',
        workspaceId: null,
      },
    ]);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations',
    );
    const body = (await res.json()) as { conversations: { title: string }[] };
    expect(body.conversations[0]!.title).toBe('Existing Title');
  });

  it('filter workspaceId + surface propagati', async () => {
    m.listForUser.mockReturnValue([]);
    await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations?workspaceId=ws-1&surface=help_chat',
    );
    expect(m.listForUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ workspaceId: 'ws-1', surface: 'help_chat' }),
    );
  });
});

describe('GET /ai-assistant/conversations/:id/messages', () => {
  it('401 senza userId', async () => {
    const res = await buildApp(null).request('/ai-assistant/conversations/c1/messages');
    expect(res.status).toBe(401);
  });

  it('🚨 404 cross-user (no leak)', async () => {
    m.getById.mockReturnValue({ id: 'c1', userId: 'u-other' });
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations/c1/messages',
    );
    expect(res.status).toBe(404);
  });

  it('404 se conv inesistente', async () => {
    m.getById.mockReturnValue(null);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations/fake/messages',
    );
    expect(res.status).toBe(404);
  });

  it('happy path: messages cap 50', async () => {
    m.getById.mockReturnValue({ id: 'c1', userId: 'u1' });
    m.getRecentMessages.mockReturnValue([{ role: 'user', content: 'hi' }]);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations/c1/messages',
    );
    expect(res.status).toBe(200);
    expect(m.getRecentMessages).toHaveBeenCalledWith('c1', 50);
  });
});

describe('DELETE /ai-assistant/conversations/:id', () => {
  it('401 senza userId', async () => {
    const res = await buildApp(null).request('/ai-assistant/conversations/c1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('happy path → ok:true', async () => {
    m.softDelete.mockReturnValue(true);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations/c1',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(m.softDelete).toHaveBeenCalledWith('c1', 'u1');
  });

  it('🚨 404 se softDelete returns false (cross-user no leak)', async () => {
    m.softDelete.mockReturnValue(false);
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/conversations/c1',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /ai-assistant/chat — constrained decoding + propagazione X-FF-Request-Id', () => {
  // dispatchLLMChatStructured(provider, apiKey, model, system, user, baseUrl,
  //   history, JSON_SCHEMA[7], tokenListener[8], requestId[9]).
  it('🚨 wiring guided_json: il JSON schema è passato come 8° argomento (strato 1)', async () => {
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const schemaArg = m.dispatchLLM.mock.calls[0]![7] as { required?: string[]; type?: string };
    expect(schemaArg.type).toBe('object');
    expect(schemaArg.required).toContain('message');
  });

  it('header rid → passato a dispatchLLMChatStructured come 10° argomento', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ff-request-id': 'rid-abc' },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    expect(m.dispatchLLM).toHaveBeenCalledTimes(1);
    expect(m.dispatchLLM.mock.calls[0]![9]).toBe('rid-abc'); // requestId
  });

  it('senza header rid → 10° argomento undefined (no propagazione)', async () => {
    await buildApp({ userId: 'u1', tenantId: 't1' }).request('/ai-assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    expect(m.dispatchLLM.mock.calls[0]![9]).toBeUndefined();
  });
});

describe('GET /ai-assistant/queue-status — proxy SSE canale-posizione', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  function sseBody(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(enc.encode(text));
        ctrl.close();
      },
    });
  }

  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/ai-assistant/queue-status?rid=x');
    expect(res.status).toBe(401);
  });

  it('400 senza rid', async () => {
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/queue-status',
    );
    expect(res.status).toBe(400);
  });

  it('inoltra al portal con Bearer license + rid, e fa pass-through dei frame SSE', async () => {
    process.env.MEDEA_LICENSE_KEY = 'ZFL-TEST';
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(sseBody('event: queued\ndata: {"position":2,"ahead":1}\n\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/queue-status?rid=rid-9',
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/queue-status?rid=rid-9');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ZFL-TEST');
    const body = await res.text();
    expect(body).toContain('event: queued');
    expect(body).toContain('"position":2');
  });

  it('upstream non-ok → emette gone (no crash)', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 502 })) as unknown as typeof fetch;
    const res = await buildApp({ userId: 'u1', tenantId: 't1' }).request(
      '/ai-assistant/queue-status?rid=z',
    );
    expect(res.status).toBe(200); // SSE aperto
    expect(await res.text()).toContain('event: gone');
  });
});
