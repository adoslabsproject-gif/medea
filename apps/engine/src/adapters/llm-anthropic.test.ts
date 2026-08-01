/**
 * Bug-bounty UNIT — adapters/llm-anthropic.ts (audit coverage 2026-06-12: 8%).
 * `fetch` mockato: si pinna la TRADUZIONE request/response tra il contratto
 * ILLMProvider e l'API Anthropic, dove i bug stanno nei dettagli:
 *   - i system message vanno nel campo `system` (non in `messages`);
 *   - i ruoli non-assistant collassano a 'user';
 *   - stop_reason → finishReason (end_turn→stop, max_tokens→length,
 *     tool_use→tool_calls);
 *   - 200 con body NON-JSON (CDN error page durante un outage) → Error, NON
 *     crash dell'orchestrator;
 *   - usage tokens sommati; abortSignal propagato.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from './llm-anthropic.js';
import type { LLMCompletionRequest } from '@/ports/llm-provider.js';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

function anthropicOk(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}
const lastBody = (): Record<string, unknown> => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
const req = (over: Partial<LLMCompletionRequest> = {}): LLMCompletionRequest =>
  ({ messages: [{ role: 'user', content: 'ciao' }], ...over } as LLMCompletionRequest);

describe('AnthropicProvider — costruttore', () => {
  it('apiKey vuota → throw (fail-fast, niente provider mezzo-inizializzato)', () => {
    expect(() => new AnthropicProvider('')).toThrow(/apiKey/);
  });
});

describe('complete — costruzione request', () => {
  it('i system message finiscono nel campo `system`, fuori da messages', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    const p = new AnthropicProvider('sk-test');
    await p.complete(req({ messages: [
      { role: 'system', content: 'sei Liara' },
      { role: 'system', content: 'parla italiano' },
      { role: 'user', content: 'ciao' },
    ] }));
    const body = lastBody();
    expect(body.system).toBe('sei Liara\n\nparla italiano'); // join \n\n
    expect((body.messages as unknown[]).length).toBe(1); // solo user, niente system
  });

  it('ruoli non-assistant collassano a user (tool/function → user)', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [], stop_reason: 'end_turn' }));
    const p = new AnthropicProvider('sk-test');
    await p.complete(req({ messages: [
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u' },
      { role: 'tool', content: 't' } as never,
    ] }));
    const roles = (lastBody().messages as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(['assistant', 'user', 'user']);
  });

  it('default model + max_tokens applicati; temperature/stopSequences passati solo se presenti', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [], stop_reason: 'end_turn' }));
    const p = new AnthropicProvider('sk-test', 'claude-test-model');
    await p.complete(req());
    const body = lastBody();
    expect(body.model).toBe('claude-test-model');
    expect(body.max_tokens).toBe(4096);
    expect('temperature' in body).toBe(false);
    expect('stop_sequences' in body).toBe(false);

    fetchMock.mockResolvedValue(anthropicOk({ content: [], stop_reason: 'end_turn' }));
    await p.complete(req({ temperature: 0.3, stopSequences: ['STOP'], maxTokens: 100 }));
    const body2 = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(body2.temperature).toBe(0.3);
    expect(body2.stop_sequences).toEqual(['STOP']);
    expect(body2.max_tokens).toBe(100);
  });

  it('header API key + anthropic-version inviati', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [], stop_reason: 'end_turn' }));
    await new AnthropicProvider('sk-SEGRETA').complete(req());
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('sk-SEGRETA');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('abortSignal propagato a fetch', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [], stop_reason: 'end_turn' }));
    const ac = new AbortController();
    await new AnthropicProvider('sk-test').complete(req({ abortSignal: ac.signal }));
    expect((fetchMock.mock.calls[0]![1] as { signal?: unknown }).signal).toBe(ac.signal);
  });
});

describe('complete — parsing response', () => {
  it('concatena SOLO i blocchi text (ignora non-text)', async () => {
    fetchMock.mockResolvedValue(anthropicOk({
      content: [{ type: 'text', text: 'ciao ' }, { type: 'tool_use' }, { type: 'text', text: 'mondo' }],
      stop_reason: 'end_turn',
    }));
    const out = await new AnthropicProvider('sk-test').complete(req());
    expect(out.text).toBe('ciao mondo');
  });

  it.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['qualcos_altro', 'stop'],
  ])('stop_reason %s → finishReason %s', async (stop, expected) => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [{ type: 'text', text: 'x' }], stop_reason: stop }));
    const out = await new AnthropicProvider('sk-test').complete(req());
    expect(out.finishReason).toBe(expected);
  });

  it('usage tokens mappati e sommati (input+output=total)', async () => {
    fetchMock.mockResolvedValue(anthropicOk({
      content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 25 },
    }));
    const out = await new AnthropicProvider('sk-test').complete(req());
    expect(out.usage).toEqual({ promptTokens: 10, completionTokens: 25, totalTokens: 35 });
  });

  it('senza usage → campo usage assente (non zero finto)', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }));
    const out = await new AnthropicProvider('sk-test').complete(req());
    expect(out.usage).toBeUndefined();
  });
});

describe('complete — resilienza errori', () => {
  it('HTTP non-ok → Error con status + body', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' } as unknown as Response);
    await expect(new AnthropicProvider('sk-test').complete(req())).rejects.toThrow(/429.*rate limited/);
  });

  it('200 ma body NON-JSON (CDN error page durante outage) → Error, NON crash silenzioso', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' } as unknown as Response);
    await expect(new AnthropicProvider('sk-test').complete(req())).rejects.toThrow(/non-JSON/);
  });
});

describe('stream — degrada a single-chunk via complete', () => {
  it('yield un unico chunk done=true col testo completo', async () => {
    fetchMock.mockResolvedValue(anthropicOk({ content: [{ type: 'text', text: 'streamed' }], stop_reason: 'end_turn' }));
    const chunks = [];
    for await (const ch of new AnthropicProvider('sk-test').stream(req())) chunks.push(ch);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ delta: 'streamed', done: true, finishReason: 'stop' });
  });
});
