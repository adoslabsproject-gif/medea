/**
 * Il dispatcher, provider per provider.
 *
 * Invarianti:
 *  - ogni provider riceve la chiave del cliente, sul suo endpoint, col suo
 *    modo di autenticarsi: nessuna chiave condivisa, nessun vendor predefinito
 *  - un provider che non esiste viene rifiutato per nome
 *  - il body di un errore si legge fino a un tetto (anti-OOM)
 *  - un `baseUrl` scelto dall'utente passa dal guard SSRF PRIMA della fetch
 *  - la variante strutturata mostra lo schema al modello nel prompt di sistema
 *  - le varianti «streaming» consegnano la risposta al callback in un pezzo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedReq {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
let captured: CapturedReq[] = [];
let mockResponse: { status: number; body: unknown } = {
  status: 200,
  body: { choices: [{ message: { content: 'hello world' } }] },
};

beforeEach(() => {
  captured = [];
  mockResponse = { status: 200, body: { choices: [{ message: { content: 'hello world' } }] } };
  globalThis.fetch = ((url: string, init: RequestInit) => {
    captured.push({
      url,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve({
      ok: mockResponse.status >= 200 && mockResponse.status < 300,
      status: mockResponse.status,
      text: () => Promise.resolve(JSON.stringify(mockResponse.body)),
      json: () => Promise.resolve(mockResponse.body),
    } as Response);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.resetModules();
});

describe('dispatchLLMChat — ogni provider con la chiave del cliente', () => {
  // FIX 2026-05-30 user requirement: zero hardcoded vendor preference.
  // Tutti i provider devono funzionare alla pari. L'API key arriva da
  // Settings → AI Providers del tenant.

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
    await expect(
      dispatchLLMChat('openrouter', 'k', '', 'sys', 'goal', undefined, []),
    ).rejects.toThrow(/model required/);
  });

  it('OpenRouter con model esplicito (es. "x-ai/grok-2") funziona', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('openrouter', 'or-key', 'x-ai/grok-2', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured[0]?.body.model).toBe('x-ai/grok-2');
    expect(captured[0]?.headers['X-Title']).toBe('FlowForge');
  });

  it('Anthropic: x-api-key porta la chiave del cliente', async () => {
    mockResponse = { status: 200, body: { content: [{ type: 'text', text: 'ok' }] } };
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('anthropic', 'sk-ant-customer-key', '', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toBe('https://api.anthropic.com/v1/messages');
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
    mockResponse = {
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
    };
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('gemini', 'goog-key', 'gemini-2.0-flash', 'sys', 'goal', undefined, []);
    expect(captured[0]?.url).toContain('generativelanguage.googleapis.com');
    expect(captured[0]?.url).toContain('key=goog-key');
    expect(captured[0]?.url).toContain('gemini-2.0-flash');
  });

  it('Mistral usa endpoint api.mistral.ai con Bearer cliente', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat(
      'mistral',
      'mistral-key',
      'mistral-large-latest',
      'sys',
      'goal',
      undefined,
      [],
    );
    expect(captured[0]?.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(captured[0]?.headers.Authorization).toBe('Bearer mistral-key');
  });

  it('Groq (LPU) usa endpoint api.groq.com OpenAI-compatible', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat(
      'groq',
      'groq-key',
      'llama-3.3-70b-versatile',
      'sys',
      'goal',
      undefined,
      [],
    );
    expect(captured[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(captured[0]?.body.model).toBe('llama-3.3-70b-versatile');
  });

  it('conserva la storia dei messaggi precedenti', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('openai', 'k', 'gpt-4o', 'sys', 'terza', undefined, [
      { role: 'user', content: 'prima' },
      { role: 'assistant', content: 'seconda' },
    ]);
    expect(captured[0]?.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prima' },
      { role: 'assistant', content: 'seconda' },
      { role: 'user', content: 'terza' },
    ]);
  });

  it('REGRESSION: provider sconosciuto → throw "Unknown provider"', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(
      dispatchLLMChat('made-up-vendor', 'k', '', 'sys', 'goal', undefined, []),
    ).rejects.toThrow(/Unknown provider/);
  });

  /**
   * Un nome rimasto in un workflow o in una preferenza salvata con una
   * versione che aveva un provider in più deve essere rifiutato per nome, e
   * senza che parta nessuna richiesta.
   */
  it('🚨 un provider che non esiste più non fa partire nessuna richiesta', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(
      dispatchLLMChat('provider-dismesso', '', '', 'sys', 'goal', undefined, []),
    ).rejects.toThrow(/Unknown provider.*provider-dismesso/);
    expect(captured).toHaveLength(0);
  });

  it('un 4xx del provider resta un errore col suo stato, non viene mascherato', async () => {
    mockResponse = { status: 401, body: { error: 'chiave non valida' } };
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await expect(
      dispatchLLMChat('openai', 'k', 'gpt-4o', 'sys', 'goal', undefined, []),
    ).rejects.toThrow(/OpenAI 401/);
  });
});

describe("dispatchLLMChat — anti-OOM: body d'errore cappato (bug-bounty)", () => {
  /** Stream lazy: 8KB per pull (fino a 512 chunk = 4MB) che REGISTRA il max chunk
   *  tirati. Fixato (readTextTruncated 64KB) → ~8-9 pull. Pre-fix (res.text()) → 512.
   *  Stream FINITO → con la mutazione il test FALLISCE l'asserzione (non va in hang). */
  function countingStream(stats: { maxChunks: number }): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 512) {
          c.close();
          return;
        }
        sent += 1;
        stats.maxChunks = Math.max(stats.maxChunks, sent);
        c.enqueue(new Uint8Array(8 * 1024));
      },
    });
  }

  it("🚨 ATTACCO: provider 500 con body d'errore ENORME → la lettura si ferma al cap", async () => {
    const stats = { maxChunks: 0 };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(countingStream(stats), { status: 500 }),
      )) as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    const err = await dispatchLLMChat('openai', 'k', '', 'sys', 'goal', undefined, []).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error); // la 500 produce comunque un errore
    // 64KB / 8KB ≈ 8 pull col cap; senza cap (res.text()) tirerebbe tutti i 512.
    expect(stats.maxChunks).toBeLessThan(30);
  });
});

describe('🔴 SSRF runtime — guardCustomBaseUrl: baseUrl custom interno → throw PRIMA del fetch', () => {
  it.each([
    'http://172.20.0.1:6379', // Redis su una rete Docker
    'http://172.20.0.1:3006', // un servizio interno qualsiasi: nessun host è esente
    'http://127.0.0.1:8080', // loopback
    'http://localhost:11434', // Ollama-locale (no senso cloud)
    'http://169.254.169.254/latest/meta-data/', // cloud IMDS
    'http://10.0.0.5', // RFC1918
    'http://[::1]:11434', // IPv6 loopback
  ])(
    'dispatchLLMChat baseUrl "%s" → reject, fetch NON parte (difesa in profondità)',
    async (baseUrl) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const { dispatchLLMChat } = await import('./llm-chat.service');
      await expect(
        dispatchLLMChat('ollama', '', 'llama3.2', 'sys', 'goal', baseUrl, []),
      ).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('🟢 baseUrl PUBBLICO → il guard NON blocca, fetch parte', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat(
      'ollama',
      '',
      'llama3.2',
      'sys',
      'goal',
      'https://ollama.example.com',
      [],
    ).catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('🟢 senza baseUrl (provider a indirizzo fisso) il guard non ha niente da controllare', async () => {
    const { dispatchLLMChat } = await import('./llm-chat.service');
    await dispatchLLMChat('openai', 'k', 'gpt-4o', 'sys', 'goal', undefined, []);
    expect(captured).toHaveLength(1);
  });
});

describe('dispatchLLMChatStructured — lo schema viaggia nel prompt', () => {
  const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

  it('mette lo schema esatto nel prompt di sistema, per qualunque provider', async () => {
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    await dispatchLLMChatStructured(
      'openai',
      'k',
      'gpt-4o',
      'regole',
      'goal',
      undefined,
      [],
      SCHEMA,
    );
    const messages = captured[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('regole');
    expect(messages[0]?.content).toContain(JSON.stringify(SCHEMA));
    expect(messages[0]?.content).toMatch(/SOLO con JSON valido/);
  });

  it('riporta i token al listener come la chiamata semplice', async () => {
    mockResponse = {
      status: 200,
      body: {
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    };
    const { dispatchLLMChatStructured } = await import('./llm-chat.service');
    const visti: unknown[] = [];
    await dispatchLLMChatStructured(
      'openai',
      'k',
      'gpt-4o',
      'sys',
      'goal',
      undefined,
      [],
      SCHEMA,
      (u) => visti.push(u),
    );
    expect(visti).toEqual([{ input: 5, output: 2, fromApi: true }]);
  });
});

describe('le varianti con callback consegnano la risposta in un pezzo', () => {
  it('dispatchLLMChatStreaming: un solo chunk, col testo intero, e lo stesso testo in uscita', async () => {
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    const pezzi: string[] = [];
    const out = await dispatchLLMChatStreaming(
      'openai',
      'k',
      'gpt-4o',
      'sys',
      'goal',
      undefined,
      [],
      (d) => pezzi.push(d),
    );
    expect(pezzi).toEqual(['hello world']);
    expect(out).toBe('hello world');
  });

  it('dispatchLLMChatStructuredStreaming: un solo chunk, e lo schema nel prompt', async () => {
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const pezzi: string[] = [];
    const out = await dispatchLLMChatStructuredStreaming(
      'openai',
      'k',
      'gpt-4o',
      'sys',
      'goal',
      undefined,
      [],
      { type: 'object' },
      (d) => pezzi.push(d),
    );
    expect(pezzi).toEqual(['hello world']);
    expect(out).toBe('hello world');
    const messages = captured[0]?.body.messages as { content: string }[];
    expect(messages[0]?.content).toContain('OUTPUT JSON SCHEMA');
  });

  it('se il provider fallisce il callback non riceve niente', async () => {
    mockResponse = { status: 500, body: {} };
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    const pezzi: string[] = [];
    await expect(
      dispatchLLMChatStreaming('openai', 'k', 'gpt-4o', 'sys', 'goal', undefined, [], (d) =>
        pezzi.push(d),
      ),
    ).rejects.toThrow();
    expect(pezzi).toEqual([]);
  });
});

describe('LlmProviderUnavailableError — messaggio chiaro, mai un 500 opaco', () => {
  it('porta il provider e dice dove sceglierne un altro', async () => {
    const { LlmProviderUnavailableError } = await import('./llm-chat.service');
    const err = new LlmProviderUnavailableError('openai', 'connessione fallita');
    expect(err.provider).toBe('openai');
    expect(err.message).toContain('OpenAI non è al momento raggiungibile');
    expect(err.message).toContain('connessione fallita');
    expect(err.message).toContain('Settings → AI Providers');
  });
});

describe('getContextWindowBudget', () => {
  afterEach(() => {
    delete process.env.MEDEA_LLM_CONTEXT_WINDOW;
  });

  it('vale 40960 se nessuno dice altro', async () => {
    const { getContextWindowBudget } = await import('./llm-chat.service');
    expect(getContextWindowBudget()).toBe(40960);
  });

  it('si alza da MEDEA_LLM_CONTEXT_WINDOW', async () => {
    process.env.MEDEA_LLM_CONTEXT_WINDOW = '128000';
    const { getContextWindowBudget } = await import('./llm-chat.service');
    expect(getContextWindowBudget()).toBe(128000);
  });

  it('un valore inservibile non rompe il conto: resta il predefinito', async () => {
    process.env.MEDEA_LLM_CONTEXT_WINDOW = 'zero';
    const { getContextWindowBudget } = await import('./llm-chat.service');
    expect(getContextWindowBudget()).toBe(40960);
  });
});
