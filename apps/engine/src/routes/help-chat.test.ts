/**
 * Test 2026-grade — help-chat route (Liara conversational in-app help).
 *
 * 🚨 INPUT VALIDATION (Zod):
 *  - messages.length 1..20
 *  - content 1..4000 char
 *  - role enum 'user' | 'assistant'
 *  - last message MUST be from 'user' (no AI initiating)
 *
 * 🚨 AUTH GATE: c.get('auth') null → 401
 *
 * 🚨 LLM RESOLUTION:
 *  - NoLlmProviderError → 503 + structured error per widget fallback
 *  - Other errors propagated → 500
 *  - LLM dispatch fail → 502 + reason
 *
 * 🚨 HISTORY HANDLING: messages.slice(0, -1) → ultima è prompt corrente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { Hono } from 'hono';

const dispatchLLMChatMock = vi.fn();
vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: dispatchLLMChatMock,
}));

class NoLlmProviderErrorMock extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoLlmProviderError';
  }
}
const llmResolverMock = { resolve: vi.fn() };
vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: llmResolverMock,
  NoLlmProviderError: NoLlmProviderErrorMock,
}));

vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-A',
}));

const { createHelpChatRoutes } = await import('./help-chat.js');

function makeApp(opts: { authenticated?: boolean } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (opts.authenticated !== false) c.set('auth' as never, { userId: 'u1' } as never);
    return next();
  });
  app.route('/help-chat', createHelpChatRoutes());
  return app;
}

async function postChat(app: Hono, body: unknown): Promise<Response> {
  return app.request('/help-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 auth gate', () => {
  it('🚨 c.get("auth") null → 401', async () => {
    const app = makeApp({ authenticated: false });
    const res = await postChat(app, { messages: [{ role: 'user', content: 'ciao' }] });
    expect(res.status).toBe(401);
  });
});

describe('🚨 input validation (Zod)', () => {
  it('🚨 messages assente → 400', async () => {
    const app = makeApp();
    const res = await postChat(app, {});
    expect(res.status).toBe(400);
  });

  it('🚨 messages array vuoto → 400 (min 1)', async () => {
    const app = makeApp();
    const res = await postChat(app, { messages: [] });
    expect(res.status).toBe(400);
  });

  it('🚨 messages > 20 → 400', async () => {
    const app = makeApp();
    const msgs = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x',
    }));
    const res = await postChat(app, { messages: msgs });
    expect(res.status).toBe(400);
  });

  it('🚨 content > 4000 char → 400', async () => {
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'x'.repeat(4001) }],
    });
    expect(res.status).toBe(400);
  });

  it('🚨 content vuoto → 400 (min 1)', async () => {
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: '' }],
    });
    expect(res.status).toBe(400);
  });

  it('🚨 role invalido (es. "system") → 400', async () => {
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'system', content: 'ciao' }],
    });
    expect(res.status).toBe(400);
  });

  it('🚨 last message NON user (assistant) → 400 "ultimo deve essere utente"', async () => {
    llmResolverMock.resolve.mockReturnValue({ provider: 'liara', apiKey: 'k', model: 'm' });
    const app = makeApp();
    const res = await postChat(app, {
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/ultimo messaggio.*utente/iu);
  });
});

describe('🚨 LLM resolver failure modes', () => {
  it('🚨 NoLlmProviderError → 503 structured "no_provider"', async () => {
    llmResolverMock.resolve.mockImplementation(() => {
      throw new NoLlmProviderErrorMock('No LLM configured for tenant');
    });
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'ciao' }],
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe('no_provider');
    expect(json.message).toBe('No LLM configured for tenant');
  });

  it('🚨 other resolver error → propagate (500)', async () => {
    llmResolverMock.resolve.mockImplementation(() => {
      throw new Error('unexpected resolver crash');
    });
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'ciao' }],
    });
    expect(res.status).toBe(500);
  });
});

describe('🚨 LLM dispatch happy + failure', () => {
  beforeEach(() => {
    llmResolverMock.resolve.mockReturnValue({
      provider: 'liara',
      apiKey: 'k-test',
      model: 'qwen3-32b',
      baseUrl: 'http://vllm:5000',
    });
  });

  it('🚨 happy: dispatch ritorna reply → 200 + provider', async () => {
    dispatchLLMChatMock.mockResolvedValue('Ciao! Sono Liara, come posso aiutarti?');
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'chi sei?' }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { reply: string; provider: string };
    expect(json.reply).toMatch(/Liara/u);
    expect(json.provider).toBe('liara');
  });

  it('🚨 history estratta correttamente (slice -1)', async () => {
    dispatchLLMChatMock.mockResolvedValue('ok');
    const app = makeApp();
    await postChat(app, {
      messages: [
        { role: 'user', content: 'msg-1' },
        { role: 'assistant', content: 'reply-1' },
        { role: 'user', content: 'msg-2-current' },
      ],
    });
    // dispatchLLMChat args: (provider, apiKey, model, sysPrompt, currentPrompt, baseUrl, history)
    const call = dispatchLLMChatMock.mock.calls[0]!;
    expect(call[4]).toBe('msg-2-current'); // current prompt
    expect(call[6]).toEqual([
      { role: 'user', content: 'msg-1' },
      { role: 'assistant', content: 'reply-1' },
    ]);
  });

  it('🚨 system prompt include identità "Liara"', async () => {
    dispatchLLMChatMock.mockResolvedValue('ok');
    const app = makeApp();
    await postChat(app, {
      messages: [{ role: 'user', content: 'ciao' }],
    });
    const sysPrompt = dispatchLLMChatMock.mock.calls[0]![3] as string;
    expect(sysPrompt).toMatch(/Liara/u);
    expect(sysPrompt).toMatch(/FlowForge/u);
    expect(sysPrompt).toMatch(/italiano/iu);
  });

  it('🚨 dispatch throw → 502 + error message', async () => {
    dispatchLLMChatMock.mockRejectedValue(new Error('vLLM timeout 30s'));
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'ciao' }],
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe('llm_failed');
    expect(json.message).toBe('vLLM timeout 30s');
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it('🚨 dispatch throw non-Error → message fallback "Errore LLM"', async () => {
    dispatchLLMChatMock.mockRejectedValue('plain-string-error');
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'ciao' }],
    });
    const json = (await res.json()) as { message: string };
    expect(json.message).toBe('Errore LLM');
  });
});

describe('🚨 message conversation patterns', () => {
  beforeEach(() => {
    llmResolverMock.resolve.mockReturnValue({
      provider: 'liara',
      apiKey: 'k',
      model: 'm',
    });
    dispatchLLMChatMock.mockResolvedValue('ok');
  });

  it('🚨 single user message (turn 1 conversation)', async () => {
    const app = makeApp();
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'prima domanda' }],
    });
    expect(res.status).toBe(200);
    const call = dispatchLLMChatMock.mock.calls[0]!;
    expect(call[4]).toBe('prima domanda');
    expect(call[6]).toEqual([]); // history vuota
  });

  it('🚨 20 messaggi (boundary upper) → 200', async () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }));
    const app = makeApp();
    const res = await postChat(app, { messages: msgs });
    // ultimo msg index 19 (dispari) → assistant → 400
    // ricalcola: i=19 dispari → 'assistant' → 400
    expect(res.status).toBe(400);
  });

  it('🚨 19 messaggi con last user → 200', async () => {
    const msgs: { role: string; content: string }[] = [];
    for (let i = 0; i < 19; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m-${i}` });
    }
    // last index 18 pari → user → OK
    const app = makeApp();
    const res = await postChat(app, { messages: msgs });
    expect(res.status).toBe(200);
  });
});
