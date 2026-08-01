/**
 * Tests per llm-chat.service — branch Liara con full-power tuning.
 *
 * Invarianti regression-critici:
 *  - Liara: thinking ENABLED by default (Qwen3 reasoning)
 *  - Liara: max_tokens default = 24000 (era 16384 → bump 2026-05-29 per "NO TRONCATURE")
 *  - Liara: model NON hard-coded a 'nha-v1' (LoRA legacy)
 *  - Liara: model omesso quando arg vuoto → backend usa MODEL_NAME env
 *  - Liara: model esplicito override (BYOK enterprise)
 *  - Liara: temperature 0.2
 *  - Liara: <think>...</think> stripped dal response
 *  - Liara: FLOWFORGE_LIARA_THINKING=false → /no_think prefix + enable_thinking=false
 *  - Liara: FLOWFORGE_LIARA_MAX_TOKENS=8192 → applicato
 *  - Liara: disabled (FLOWFORGE_DISABLE_LIARA=true) → throws
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config + circuit breaker prima di importare llm-chat.service
vi.mock('@/config.js', () => ({
  isLiaraEnabled: () => true,
  liaraBaseUrl: () => 'http://127.0.0.1:3003/v1',
}));

vi.mock('@/lib/circuit-breaker.js', () => ({
  CircuitBreaker: class {
    async execute<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  },
  circuitBreakerRegistry: { get: () => null },
}));

interface CapturedReq { url: string; body: Record<string, unknown>; headers: Record<string, string> }
let captured: CapturedReq[] = [];
let mockResponse: { status: number; body: unknown } = { status: 200, body: { choices: [{ message: { content: 'hello world' } }] } };

beforeEach(() => {
  captured = [];
  mockResponse = { status: 200, body: { choices: [{ message: { content: 'hello world' } }] } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.push({
      url,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: mockResponse.status >= 200 && mockResponse.status < 300,
      status: mockResponse.status,
      text: async () => JSON.stringify(mockResponse.body),
      json: async () => mockResponse.body,
    } as Response;
  }) as unknown as typeof fetch;
  delete process.env.FLOWFORGE_LIARA_THINKING;
  delete process.env.FLOWFORGE_LIARA_MAX_TOKENS;
});

afterEach(() => {
  vi.resetModules();
});

describe('dispatchLLMChat — Liara branch', () => {
  it('default: thinking ENABLED + max_tokens 24000 + temperature 0.2', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured).toHaveLength(1);
    const body = captured[0]!.body;
    expect(body.max_tokens).toBe(24000);
    expect(body.temperature).toBe(0.2);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toBe('sys'); // no /no_think prefix
  });

  it('opts.temperature RISPETTATA (fix 2026-07: prima era 0.2 hardcoded, l\'UI ignorata)', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, [], undefined, undefined, { temperature: 0.9 });
    expect(captured[0]!.body.temperature).toBe(0.9);
  });

  it('opts.temperature = 0 è rispettata (non confusa col default via ??)', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, [], undefined, undefined, { temperature: 0 });
    expect(captured[0]!.body.temperature).toBe(0);
  });

  it('NO model field when arg empty (backend MODEL_NAME default)', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured[0]!.body).not.toHaveProperty('model');
  });

  it('NEVER hard-codes nha-v1 LoRA (regression guard)', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured[0]!.body).not.toMatchObject({ model: 'nha-v1' });
  });

  it('model override when explicitly passed (BYOK enterprise)', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', 'qwen3-32b-special', 'sys', 'goal', undefined, []);
    expect(captured[0]!.body.model).toBe('qwen3-32b-special');
  });

  it('FLOWFORGE_LIARA_THINKING=false → /no_think + enable_thinking=false', async () => {
    process.env.FLOWFORGE_LIARA_THINKING = 'false';
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    const body = captured[0]!.body;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toBe('/no_think\nsys');
  });

  it('FLOWFORGE_LIARA_MAX_TOKENS=8192 → applicato', async () => {
    process.env.FLOWFORGE_LIARA_MAX_TOKENS = '8192';
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured[0]!.body.max_tokens).toBe(8192);
  });

  it('FLOWFORGE_LIARA_MAX_TOKENS invalid/zero → fallback 24000', async () => {
    process.env.FLOWFORGE_LIARA_MAX_TOKENS = 'abc';
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured[0]!.body.max_tokens).toBe(24000);
  });

  it('FIX 2026-05-30 — max_tokens DINAMICO cap a (context - input - safety)', async () => {
    // Simula input pesante: SYSTEM_PROMPT ~3.5KB + goal piccolo.
    // Stima 3.5 char/token → input ~1000 token su 40960 → dynamic cap = MIN(24000, 40960-1000-512) = 24000
    const heavySys = 'a'.repeat(3500); // ~1000 token
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', heavySys, 'goal', undefined, []);
    // Per input piccolo il dynamic cap rimane il ceiling 24000.
    expect(captured[0]!.body.max_tokens).toBe(24000);
  });

  it('FIX 2026-05-30 — input MOLTO grande → max_tokens scende sotto 24000 (regression user-reported)', async () => {
    // Bug user-segnalato: Liara 400 "max_tokens too large: 24000. context=40960, input=17516"
    // Sum 17516+24000=41516 > 40960 → rifiuto.
    // Fix: cap dinamico = 40960 - input - 512.
    // Simula 17516 input tokens ≈ 17516 * 3.5 = 61306 char.
    const massiveSys = 'a'.repeat(60000); // ~17142 token stimati
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', massiveSys, 'goal', undefined, []);
    const max = captured[0]!.body.max_tokens as number;
    expect(max).toBeLessThan(24000);
    expect(max).toBeGreaterThan(1024); // mai sotto al floor di sicurezza
    // E la SOMMA input + max_tokens MAI > context window
    // input stimato ~17142 + max stimato ~23306 = 40448 < 40960 ✓
    expect(max + 17500).toBeLessThan(40960);
  });

  it('FIX 2026-05-30 — FLOWFORGE_LIARA_CONTEXT_WINDOW override (es. Qwen3 future 64K)', async () => {
    process.env.FLOWFORGE_LIARA_CONTEXT_WINDOW = '65536';
    const heavySys = 'a'.repeat(60000); // ~17142 token
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', heavySys, 'goal', undefined, []);
    // Con context 65536: cap = MIN(24000, 65536-17142-512) = MIN(24000, 47882) = 24000
    expect(captured[0]!.body.max_tokens).toBe(24000);
    delete process.env.FLOWFORGE_LIARA_CONTEXT_WINDOW;
  });

  // BUG owner 2026-06-12: input > context → PRIMA mandava comunque (floor 1024) e
  // il modello rifiutava con 400 'context length 92408 > 40960' → 500 'Errore
  // interno'. Ora falliamo PRESTO con LlmContextOverflowError (la route → 413
  // chiaro) e NON sprechiamo la chiamata al modello.
  it('🚨 input > context → LlmContextOverflowError + NESSUNA chiamata al modello', async () => {
    const giant = 'a'.repeat(200000); // ~57142 token stimati > context 40960
    const { dispatchLLMChat, LlmContextOverflowError } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('liara', '', '', giant, 'goal', undefined, []))
      .rejects.toBeInstanceOf(LlmContextOverflowError);
    expect(captured, 'il modello NON deve essere chiamato').toHaveLength(0);
  });

  it('🚨 il messaggio dell\'errore overflow è in italiano e cita i numeri', async () => {
    const giant = 'a'.repeat(200000);
    const { dispatchLLMChat } = await import('./llm-chat.service');
    let err: Error | undefined;
    try { await dispatchLLMChat('liara', '', '', giant, 'goal', undefined, []); }
    catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/troppo lunga/i);
    expect(err?.message).toMatch(/40\.?960/);
  });

  it('🚨 il modello rifiuta per context (400) nonostante la stima → tradotto in LlmContextOverflowError', async () => {
    // Difesa in profondità: input borderline che passa la stima ma il modello
    // (tokenizer reale) rifiuta → non deve diventare un 500 grezzo.
    mockResponse = { status: 400, body: { error: { message: "This model's maximum context length is 40960 tokens" } } };
    const { dispatchLLMChat, LlmContextOverflowError } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []))
      .rejects.toBeInstanceOf(LlmContextOverflowError);
  });

  it('<think>...</think> stripped from response', async () => {
    mockResponse = { status: 200, body: { choices: [{ message: { content: '<think>reasoning</think>final answer' } }] } };
    const { dispatchLLMChat } = await import('./llm-chat.service');
    const out = await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(out).toBe('final answer');
  });

  it('Authorization Bearer with FLOWFORGE_LICENSE_KEY', async () => {
    process.env.FLOWFORGE_LICENSE_KEY = 'test-license-abc';
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured[0]!.headers).toMatchObject({ Authorization: 'Bearer test-license-abc' });
    delete process.env.FLOWFORGE_LICENSE_KEY;
  });

  it('preserves prior history messages', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'next question', undefined, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]);
    const messages = captured[0]!.body.messages as { role: string; content: string }[];
    // system + 2 history + 1 user current = 4
    expect(messages.length).toBe(4);
    expect(messages[1]?.content).toBe('first');
    expect(messages[3]?.content).toBe('next question');
  });

  it('routes to LIARA_URL gateway', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []);
    expect(captured[0]!.url).toContain('/chat/completions');
  });

  it('Liara backend 5xx → LlmProviderUnavailableError (errore chiaro per UI/circuit breaker)', async () => {
    mockResponse = { status: 500, body: { error: 'gpu busy' } };
    const { dispatchLLMChat, LlmProviderUnavailableError } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []))
      .rejects.toBeInstanceOf(LlmProviderUnavailableError);
  });
});

describe('dispatchLLMChat — BYOK providers (NO Zeli pays, customer brings own API key)', () => {
  // FIX 2026-05-30 user requirement: zero hardcoded vendor preference.
  // Tutti i provider devono funzionare alla pari. L'API key arriva da
  // Settings → AI Providers del tenant (BYOK).

  it('Grok (X.AI) usa endpoint api.x.ai/v1/chat/completions OpenAI-compatible', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('grok', 'xai-key-test', 'grok-2-latest', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(captured[0]?.headers.Authorization).toBe('Bearer xai-key-test');
    expect(captured[0]?.body.model).toBe('grok-2-latest');
  });

  it('Grok alias "xai" funziona identicamente', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('xai', 'k', '', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(captured[0]?.body.model).toBe('grok-2-latest'); // default model
  });

  it('DeepSeek usa endpoint api.deepseek.com', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('deepseek', 'ds-key', 'deepseek-chat', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(captured[0]?.body.model).toBe('deepseek-chat');
  });

  it('DeepSeek default model "deepseek-chat" se omesso', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('deepseek', 'k', '', 'sys', 'goal', undefined, []);
    expect(captured[0]?.body.model).toBe('deepseek-chat');
  });

  it('REGRESSION: OpenRouter NON ha default vendor hardcoded (es. NO "anthropic/claude-3-5-sonnet")', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    // Senza model esplicito → THROW (provider-agnostic, no default vendor)
    await expect(dispatchLLMChat('openrouter', 'k', '', 'sys', 'goal', undefined, []))
      .rejects.toThrow(/model required/);
  });

  it('OpenRouter con model esplicito (es. "x-ai/grok-2") funziona', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('openrouter', 'or-key', 'x-ai/grok-2', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured[0]?.body.model).toBe('x-ai/grok-2');
    expect(captured[0]?.headers['X-Title']).toBe('FlowForge');
  });

  it('REGRESSION: Anthropic NON è il default fallback di Zeli — solo se cliente lo configura', async () => {
    // Verifica che Anthropic richieda esplicita API key (no shared pool).
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('anthropic', 'sk-ant-customer-key', '', 'sys', 'goal', undefined, []);
    // Header x-api-key porta la CHIAVE DEL CLIENTE, non una pool Zeli.
    expect(captured[0]?.headers['x-api-key']).toBe('sk-ant-customer-key');
  });

  it('OpenAI (ChatGPT) usa header Bearer con chiave cliente', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('openai', 'sk-customer-openai', 'gpt-4o', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured[0]?.headers.Authorization).toBe('Bearer sk-customer-openai');
    expect(captured[0]?.body.model).toBe('gpt-4o');
  });

  it('Gemini (Google) usa key in query string + endpoint generativelanguage', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('gemini', 'goog-key', 'gemini-2.0-flash', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toContain('generativelanguage.googleapis.com');
    expect(captured[0]?.url).toContain('key=goog-key');
    expect(captured[0]?.url).toContain('gemini-2.0-flash');
  });

  it('Mistral usa endpoint api.mistral.ai con Bearer cliente', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('mistral', 'mistral-key', 'mistral-large-latest', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(captured[0]?.headers.Authorization).toBe('Bearer mistral-key');
  });

  it('Groq (LPU) usa endpoint api.groq.com OpenAI-compatible', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('groq', 'groq-key', 'llama-3.3-70b-versatile', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(captured[0]?.body.model).toBe('llama-3.3-70b-versatile');
  });

  it('REGRESSION: provider sconosciuto → throw "Unknown provider"', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('made-up-vendor', 'k', '', 'sys', 'goal', undefined, []))
      .rejects.toThrow(/Unknown provider/);
  });
});

describe('dispatchLLMChat — Liara branch · disabled mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/config.js', () => ({
      isLiaraEnabled: () => false,
      liaraBaseUrl: () => 'http://127.0.0.1:3003/v1',
    }));
    vi.doMock('@/lib/circuit-breaker.js', () => ({
      CircuitBreaker: class {
        async execute<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
      },
      circuitBreakerRegistry: { get: () => null },
    }));
  });

  afterEach(() => {
    vi.doUnmock('@/config.js');
    vi.doUnmock('@/lib/circuit-breaker.js');
  });

  it('throws when isLiaraEnabled()=false (FLOWFORGE_DISABLE_LIARA)', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []))
      .rejects.toThrow(/disabilitata/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Audit coverage 2026-06-12: dispatchLLMChatStructured (era 0%).
// Output JSON-schema-guided per lo scaffold AI. fetch mockato dal beforeEach.
// ════════════════════════════════════════════════════════════════════
describe('dispatchLLMChatStructured — Liara guided_json', () => {
  const SCHEMA = { type: 'object', properties: { nodes: { type: 'array' } }, required: ['nodes'] };

  it('Liara: response_format json_schema con lo schema esatto + strict:true', async () => {
    mockResponse = { status: 200, body: { choices: [{ message: { content: '{"nodes":[]}' } }] } };
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    const out = await dispatchLLMChatStructured('liara', '', '', 'sys', 'crea wf', undefined, [], SCHEMA);
    expect(out).toBe('{"nodes":[]}');
    const rf = captured[0]!.body.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual(SCHEMA);
  });

  it('Liara: single-shot → /no_think prefix + enable_thinking=false + temperature 0.1', async () => {
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured('liara', '', '', 'mySystem', 'goal', undefined, [], SCHEMA);
    const body = captured[0]!.body;
    const sys = (body.messages as { role: string; content: string }[])[0]!;
    expect(sys.content.startsWith('/no_think')).toBe(true);
    expect(body.temperature).toBe(0.1);
    expect((body.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking).toBe(false);
  });

  it('Liara: <think>…</think> rimosso dal content ritornato', async () => {
    mockResponse = { status: 200, body: { choices: [{ message: { content: '<think>ragiono</think>\n{"nodes":[1]}' } }] } };
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    const out = await dispatchLLMChatStructured('liara', '', '', 's', 'g', undefined, [], SCHEMA);
    expect(out).toBe('{"nodes":[1]}');
  });

  it('Liara: token usage listener fromApi=true quando il backend riporta usage', async () => {
    mockResponse = { status: 200, body: { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 100, completion_tokens: 40 } } };
    const usages: { input: number; output: number; fromApi: boolean }[] = [];
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured('liara', '', '', 's', 'g', undefined, [], SCHEMA, (u) => usages.push(u));
    expect(usages[0]).toEqual({ input: 100, output: 40, fromApi: true });
  });

  it('Liara: usage listener fromApi=false (stima) quando il backend NON riporta usage', async () => {
    mockResponse = { status: 200, body: { choices: [{ message: { content: '{"nodes":[]}' } }] } };
    const usages: { fromApi: boolean }[] = [];
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured('liara', '', '', 's', 'g', undefined, [], SCHEMA, (u) => usages.push(u));
    expect(usages[0]!.fromApi).toBe(false);
  });

  it('Liara: HTTP 4xx non-context → throw generico con status + body troncato', async () => {
    // 4xx (≠400-context) = problema di richiesta, non indisponibilità → resta Error generico.
    mockResponse = { status: 404, body: 'not found' };
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await expect(dispatchLLMChatStructured('liara', '', '', 's', 'g', undefined, [], SCHEMA))
      .rejects.toThrow(/structured 404/);
  });

  it('Liara disabilitata → throw', async () => {
    vi.doMock('@/config.js', () => ({ isLiaraEnabled: () => false, liaraBaseUrl: () => 'http://x/v1' }));
    vi.resetModules();
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await expect(dispatchLLMChatStructured('liara', '', '', 's', 'g', undefined, [], SCHEMA))
      .rejects.toThrow(/disabilitata/);
    vi.doUnmock('@/config.js');
  });

  it('BYOK non-liara: delega a dispatchLLMChat con lo schema embeddato nel system + json_object', async () => {
    mockResponse = { status: 200, body: { choices: [{ message: { content: '{"ok":1}' } }] } };
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured('openai', 'sk-byok', 'gpt-x', 'mySys', 'goal', 'https://api.openai.com/v1', [], SCHEMA);
    const sys = (captured[0]!.body.messages as { role: string; content: string }[])[0]!;
    expect(sys.content).toContain('OUTPUT JSON SCHEMA');
    expect(sys.content).toContain(JSON.stringify(SCHEMA));
  });
});

describe('🛡️ dispatchLLMChatStructured — immagini DIRETTE a Liara (Qwen3-VL, pixel)', () => {
  const SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };

  it('🚨 con images → l\'ULTIMO user message ha content ARRAY multimodale (text + image_url data-url)', async () => {
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured(
      'liara', '', '', 'sys', 'descrivi questa foto', undefined, [], SCHEMA,
      undefined, undefined, [{ base64: 'AAAA', mimeType: 'image/png' }],
    );
    const msgs = captured[0]!.body.messages as { role: string; content: unknown }[];
    const lastUser = msgs[msgs.length - 1]!;
    expect(Array.isArray(lastUser.content)).toBe(true);
    const content = lastUser.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: 'text', text: 'descrivi questa foto' });
    // mutation-verify: il pixel-block c'è e punta al data-url corretto.
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });

  it('più immagini → un image_url per ciascuna, nell\'ordine', async () => {
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured(
      'liara', '', '', 'sys', 'confronta', undefined, [], SCHEMA,
      undefined, undefined, [{ base64: 'AAAA', mimeType: 'image/png' }, { base64: 'BBBB', mimeType: 'image/jpeg' }],
    );
    const msgs = captured[0]!.body.messages as { role: string; content: unknown }[];
    const content = (msgs[msgs.length - 1]!).content as Record<string, unknown>[];
    expect(content).toHaveLength(3); // text + 2 immagini
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } });
  });

  it('🚨 SENZA images → content STRINGA (retrocompat: identico al comportamento testuale)', async () => {
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured('liara', '', '', 'sys', 'solo testo', undefined, [], SCHEMA);
    const msgs = captured[0]!.body.messages as { role: string; content: unknown }[];
    const lastUser = msgs[msgs.length - 1]!;
    expect(typeof lastUser.content).toBe('string');
    expect(lastUser.content).toBe('solo testo');
  });
});

describe('LlmProviderUnavailableError — Liara giù → errore CHIARO, mai 500 opaco', () => {
  const SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };

  it('🚨 la classe porta provider + messaggio leggibile (Liara, offline/GPU)', async () => {
    const { LlmProviderUnavailableError } = await import('./llm-chat.service');
    const e = new LlmProviderUnavailableError('liara', 'gateway 502');
    expect(e.provider).toBe('liara');
    expect(e.name).toBe('LlmProviderUnavailableError');
    expect(e.message).toMatch(/Liara non è al momento raggiungibile/);
    expect(e.message).toMatch(/gateway 502/);
    expect(e.message).toMatch(/Settings → AI Providers/);
  });

  it('🚨 structured: gateway 5xx → LlmProviderUnavailableError (non Error generico → 500)', async () => {
    mockResponse = { status: 502, body: 'Bad Gateway' };
    const { dispatchLLMChatStructured, LlmProviderUnavailableError } = await import('./llm-chat.service');
    await expect(dispatchLLMChatStructured('liara', '', '', 'sys', 'goal', undefined, [], SCHEMA))
      .rejects.toBeInstanceOf(LlmProviderUnavailableError);
  });

  it('🚨 structured: connessione rifiutata (vLLM morto in gen-mode) → LlmProviderUnavailableError', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const { dispatchLLMChatStructured, LlmProviderUnavailableError } = await import('./llm-chat.service');
    await expect(dispatchLLMChatStructured('liara', '', '', 'sys', 'goal', undefined, [], SCHEMA))
      .rejects.toBeInstanceOf(LlmProviderUnavailableError);
  });

  it('🚨 non-structured (help-chat/run-explain): gateway 5xx → LlmProviderUnavailableError', async () => {
    mockResponse = { status: 503, body: 'unavailable' };
    const { dispatchLLMChat, LlmProviderUnavailableError } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []))
      .rejects.toBeInstanceOf(LlmProviderUnavailableError);
  });

  it('🚨 un 4xx NON-context resta errore generico (non maschera bug di richiesta)', async () => {
    mockResponse = { status: 401, body: 'unauthorized' };
    const { dispatchLLMChatStructured, LlmProviderUnavailableError } = await import('./llm-chat.service');
    const err = await dispatchLLMChatStructured('liara', '', '', 'sys', 'goal', undefined, [], SCHEMA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LlmProviderUnavailableError);
  });
});

describe('dispatchLLMChat — anti-OOM: body d\'errore cappato (bug-bounty)', () => {
  /** Stream lazy: 8KB per pull (fino a 512 chunk = 4MB) che REGISTRA il max chunk
   *  tirati. Fixato (readTextTruncated 64KB) → ~8-9 pull. Pre-fix (res.text()) → 512.
   *  Stream FINITO → con la mutazione il test FALLISCE l'asserzione (non va in hang). */
  function countingStream(stats: { maxChunks: number }): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 512) { c.close(); return; }
        sent += 1;
        stats.maxChunks = Math.max(stats.maxChunks, sent);
        c.enqueue(new Uint8Array(8 * 1024));
      },
    });
  }

  it('🚨 ATTACCO: provider 500 con body d\'errore ENORME → la lettura si ferma al cap', async () => {
    const stats = { maxChunks: 0 };
    globalThis.fetch = (async () => new Response(countingStream(stats), { status: 500 })) as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    const err = await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error); // la 500 produce comunque un errore
    // 64KB / 8KB ≈ 8 pull col cap; senza cap (res.text()) tirerebbe tutti i 512.
    expect(stats.maxChunks).toBeLessThan(30);
  });
});

describe('🔴 SSRF runtime — guardCustomBaseUrl: baseUrl custom interno → throw PRIMA del fetch', () => {
  it.each([
    'http://172.20.0.1:6379',                   // Redis su flowforge-net
    'http://127.0.0.1:8080',                    // loopback
    'http://localhost:11434',                   // Ollama-locale (no senso cloud)
    'http://169.254.169.254/latest/meta-data/', // cloud IMDS
    'http://10.0.0.5',                          // RFC1918
    'http://[::1]:11434',                       // IPv6 loopback
  ])('dispatchLLMChat baseUrl "%s" → reject, fetch NON parte (difesa in profondità)', async (baseUrl) => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('ollama', '', 'llama3.2', 'sys', 'goal', baseUrl, [])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('🟢 baseUrl PUBBLICO → il guard NON blocca, fetch parte', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('ollama', '', 'llama3.2', 'sys', 'goal', 'https://ollama.example.com', []).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('🟢 Liara (baseUrl undefined = gateway interno legittimo) → NON bloccato', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', undefined, []).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });

  // REGRESSIONE PROD (2026-06-22): il resolver Liara passa SEMPRE il gateway interno
  // come baseUrl ESPLICITO (IP privato 172.20.0.1, non undefined) → assertUrlSafe lo
  // bloccava (BLOCKED_PRIVATE_IP) → chat editor + gateway /api/v1/liara/chat in 500
  // 'Errore interno'. Il guard ora esenta l'origin == liaraBaseUrl().
  it('🟢 baseUrl = gateway interno ESPLICITO (= liaraBaseUrl) → NON bloccato', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    const { liaraBaseUrl } = await import('@/config.js');
    // Passa ESATTAMENTE il gateway interno come baseUrl esplicito (è ciò che fa il
    // resolver in prod). MUTATION: togliendo l'esenzione origin in guardCustomBaseUrl,
    // assertUrlSafe blocca l'IP privato → throw → fetchSpy non chiamato → rosso.
    await dispatchLLMChat('liara', '', '', 'sys', 'goal', liaraBaseUrl(), []).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('🔴 stesso IP del gateway ma PORTA diversa (Redis 172.20.0.1:6379-like) → ancora bloccato', async () => {
    // L'esenzione è per ORIGIN esatto (host+porta), non per IP → un altro servizio
    // sullo stesso host privato resta SSRF-bloccato.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(dispatchLLMChat('ollama', '', 'm', 'sys', 'goal', 'http://127.0.0.1:6379', [])).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
