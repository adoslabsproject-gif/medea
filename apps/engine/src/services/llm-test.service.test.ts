/**
 * Test 2026-grade — dispatchLLMForTest (9 provider × happy + 4xx + 5xx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { at } from '@/__testkit__/assert.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

const { dispatchLLMForTest } = await import('./llm-test.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 provider che non esiste', () => {
  /**
   * Il bottone «Test» non deve mai partire verso un indirizzo per un nome che
   * il registro non conosce: né uno inventato, né uno rimasto da una versione
   * che aveva un provider in più.
   */
  it('🚨 un nome sconosciuto → errore per nome, e nessuna richiesta parte', async () => {
    await expect(dispatchLLMForTest('provider-dismesso' as never, { apiKey: 'k' })).rejects.toThrow(
      /provider-dismesso/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('🚨 Anthropic', () => {
  it('🚨 happy: content text block extracted + joined', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            { type: 'text', text: 'OK' },
            { type: 'image', text: 'should-skip' },
          ],
        }),
    });
    const r = await dispatchLLMForTest('anthropic', {
      apiKey: 'sk-ant',
      defaultModel: 'claude-3-5',
    });
    expect(r).toBe('OK');
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as any;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('🚨 default model claude-haiku-5-5', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ content: [] }) });
    await dispatchLLMForTest('anthropic', { apiKey: 'k', defaultModel: '' });
    const body = JSON.parse(
      (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).body as string,
    );
    expect(body.model).toBe('claude-haiku-5-5');
  });
});

describe('🚨 OpenAI', () => {
  it('🚨 happy + Authorization Bearer', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] }),
    });
    await dispatchLLMForTest('openai', { apiKey: 'sk-key' });
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as any;
    expect(headers.Authorization).toBe('Bearer sk-key');
  });
});

describe('🚨 Gemini', () => {
  it('🚨 key in URL query (Google convention)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        }),
    });
    const r = await dispatchLLMForTest('gemini', { apiKey: 'AIzaXYZ', defaultModel: 'gemini-pro' });
    expect(r).toBe('OK');
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('?key=AIzaXYZ');
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('gemini-pro:generateContent');
  });

  it('🚨 default model gemini-3.8-flash', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await dispatchLLMForTest('gemini', { apiKey: 'k' });
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('gemini-3.8-flash');
  });
});

describe('🚨 Mistral / Groq / OpenRouter / Ollama / Voyage', () => {
  it('🚨 Mistral', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] }),
    });
    await dispatchLLMForTest('mistral', { apiKey: 'k' });
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('api.mistral.ai');
  });

  it('🚨 Groq', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] }),
    });
    await dispatchLLMForTest('groq', { apiKey: 'k' });
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('groq.com');
  });

  it('🚨 OpenRouter + X-Title header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] }),
    });
    await dispatchLLMForTest('openrouter', { apiKey: 'k' });
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as any;
    expect(headers['X-Title']).toBe('FlowForge');
  });

  it('🚨 Ollama localhost default', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: { content: 'OK' } }),
    });
    const r = await dispatchLLMForTest('ollama', null);
    expect(r).toBe('OK');
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('localhost:11434');
  });

  it('🚨 Voyage embeddings → static OK message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const r = await dispatchLLMForTest('voyage', { apiKey: 'k' });
    expect(r).toBe('OK (embeddings provider)');
  });
});

// GAP CHIUSO 2026-06-14: grok e deepseek erano dichiarati nel service ma NON
// pingabili (mancavano del tutto in dispatchLLMForTest). Ora coperti dal ramo
// generico OpenAI-compat del provider-registry.
describe('🚨 Grok / DeepSeek (gap chiuso)', () => {
  it('🚨 Grok → api.x.ai + grok-4.7 + Bearer', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] }),
    });
    const r = await dispatchLLMForTest('grok', { apiKey: 'xai-k' });
    expect(r).toBe('OK');
    const [url, opts] = at(fetchMock.mock.calls, 0, 'fetch-calls');
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.model).toBe('grok-4.7');
    expect(((opts as RequestInit).headers as any).Authorization).toBe('Bearer xai-k');
  });

  it('🚨 DeepSeek → api.deepseek.com + deepseek-flash', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'OK' } }] }),
    });
    await dispatchLLMForTest('deepseek', { apiKey: 'ds-k' });
    const [url, opts] = at(fetchMock.mock.calls, 0, 'fetch-calls');
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(JSON.parse((opts as RequestInit).body as string).model).toBe('deepseek-flash');
  });

  it('🚨 Grok 5xx → throw con label Grok + preview body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
    });
    await expect(dispatchLLMForTest('grok', { apiKey: 'k' })).rejects.toThrow(/Grok 500.*boom/u);
  });
});

describe('🚨 unknown provider', () => {
  it('🚨 throw', async () => {
    await expect(dispatchLLMForTest('bogus' as any, null)).rejects.toThrow(/Unknown provider/u);
  });
});

describe("🚨 anti-OOM: body d'errore cappato (bug-bounty)", () => {
  function countingStream(stats: { maxChunks: number }): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 512) {
          c.close();
          return;
        } // stream FINITO → la mutazione fa fallire l'assert, non hang
        sent += 1;
        stats.maxChunks = Math.max(stats.maxChunks, sent);
        c.enqueue(new Uint8Array(8 * 1024));
      },
    });
  }

  it("🚨 ATTACCO: provider 500 con body d'errore ENORME → readOpenAiText si ferma al cap", async () => {
    const stats = { maxChunks: 0 };
    fetchMock.mockResolvedValueOnce(new Response(countingStream(stats), { status: 500 }));
    await expect(dispatchLLMForTest('openai', { apiKey: 'k', defaultModel: '' })).rejects.toThrow();
    // 64KB / 8KB ≈ 8 pull col cap; senza cap (res.text()) tirerebbe tutti i 512.
    expect(stats.maxChunks).toBeLessThan(30);
  });
});
