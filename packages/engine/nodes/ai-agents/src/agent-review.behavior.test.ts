/**
 * Behavior test — review nodi ai-agents (2026-06-20).
 *
 * Mock del solo transport (safeFetchWithRedirects) + breaker passthrough; i reader
 * di body restano REALI. Verifica i fix:
 *  1. agent_html_extractor / agent_selector_inference: i configField (instruction/
 *     schema/examples) sono ORA iniettati nel prompt (prima buildAgentConfigPreamble
 *     non aveva i case → il modello vedeva solo l'HTML grezzo).
 *  2. maxHtmlChars: l'HTML in input è TRONCATO (prima il campo era aspirazionale).
 *  3. provider gemini: API key nell'header x-goog-api-key, mai in query string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const safeFetch = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('@medea/engine-safe-fetch', async (orig) => ({
  ...(await orig<typeof import('@medea/engine-safe-fetch')>()),
  safeFetchWithRedirects: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock('@medea/engine-nodes-stdlib', async (orig) => {
  const actual = await orig<typeof import('@medea/engine-nodes-stdlib')>();
  return { ...actual, executeWithHostBreaker: (_u: string, fn: () => unknown) => fn() };
});

const { aiAgentNodes } = await import('./index.js');

const okReply = (body: unknown) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body),
});
const openAiText = (text: string) => okReply({ choices: [{ message: { content: text } }] });
const geminiText = (text: string) => okReply({ candidates: [{ content: { parts: [{ text }] } }] });

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const node = (id: string) => {
  const n = aiAgentNodes.find((x) => x.def.id === id);
  if (!n?.executor) throw new Error(`node ${id} non trovato`);
  return n.executor;
};
/** Corpo (parsato) inviato all'LLM nella 1ª chiamata. */
function sentUserContent(): string {
  const body = JSON.parse((safeFetch.mock.calls[0]![1] as { body: string }).body) as {
    messages: { role: string; content: string }[];
  };
  return body.messages.find((m) => m.role === 'user')?.content ?? '';
}

beforeEach(() => { safeFetch.mockReset(); });

describe('agent_html_extractor — instruction+schema iniettati + HTML cappato', () => {
  it('🚨 instruction e schema finiscono nel prompt (prima: assenti → output spazzatura)', async () => {
    safeFetch.mockResolvedValue(openAiText('{"title":"ok"}'));
    await node('agent_html_extractor')({
      provider: 'openai', apiKey: 'k',
      instruction: 'estrai il titolo dell\'articolo', schema: '{"title":"string"}',
      maxHtmlChars: 1000,
    }, '<html><h1>Ciao</h1></html>', ctx);
    const user = sentUserContent();
    expect(user).toContain('estrai il titolo dell\'articolo');
    expect(user).toContain('"title"');
  });

  it('🚨 maxHtmlChars TRONCA l\'HTML in input (prima: campo aspirazionale, mai applicato)', async () => {
    safeFetch.mockResolvedValue(openAiText('{"title":"ok"}'));
    const html = 'X'.repeat(3000) + 'TAILMARKER_NON_DEVE_PASSARE';
    await node('agent_html_extractor')({
      provider: 'openai', apiKey: 'k', instruction: 'x', schema: '{}', maxHtmlChars: 1000,
    }, html, ctx);
    expect(sentUserContent()).not.toContain('TAILMARKER_NON_DEVE_PASSARE');
  });
});

describe('agent_selector_inference — examples iniettati', () => {
  it('🚨 la mappa examples finisce nel prompt (prima: assente)', async () => {
    safeFetch.mockResolvedValue(openAiText('{"selectors":{}}'));
    await node('agent_selector_inference')({
      provider: 'openai', apiKey: 'k',
      examples: '{"price":"€42,50"}', preferDataAttrs: true, maxHtmlChars: 5000,
    }, '<div class="p">€42,50</div>', ctx);
    const user = sentUserContent();
    expect(user).toContain('€42,50');
    expect(user).toContain('preferDataAttrs=true');
  });
});

describe('provider gemini — API key nell\'header, mai in URL', () => {
  it('🚨 x-goog-api-key header; URL senza key= (anti-leak)', async () => {
    safeFetch.mockResolvedValue(geminiText('{"tldr":"x","bullets":[],"detailed":"y","entities":{}}'));
    await node('agent_summarizer')({ provider: 'gemini', apiKey: 'SECRET_G', model: 'gemini-2.0-flash' }, 'testo', ctx);
    const [url, init] = safeFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).not.toContain('key=');
    expect(url).not.toContain('SECRET_G');
    expect(init.headers['x-goog-api-key']).toBe('SECRET_G');
  });
});
