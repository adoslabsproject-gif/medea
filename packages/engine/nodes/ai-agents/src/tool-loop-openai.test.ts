/**
 * Test del loop tool-calling OpenAI-format (Fase 2 #14) — il percorso Liara
 * default di ai_agent_tool_loop (tool_calls Qwen3-VL validati live 2026-07-06)
 * e dei provider BYOK OpenAI-compat. Bug-bounty: arguments garbage, errori
 * HTTP a metà loop (token già spesi → _llm comunque), cancel, sentinelle
 * model legacy, provider non supportato.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const safeFetch = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock('@medea/engine-safe-fetch', async (orig) => ({
  ...(await orig<typeof import('@medea/engine-safe-fetch')>()),
  safeFetchWithRedirects: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock('@medea/engine-nodes-stdlib', async (orig) => {
  const actual = await orig<typeof import('@medea/engine-nodes-stdlib')>();
  return { ...actual, executeWithHostBreaker: (_u: string, fn: () => unknown) => fn() };
});

const { agentToolLoopNode } = await import('./tool-loop.js');
const { openAiLoopEndpoint, toOpenAiTools } = await import('./tool-loop-openai.js');

const GW = 'http://172.20.0.1:3006/api/v1/llm';
const ctx = { tenantId: 't1', runId: 'r1', nodeId: 'n1', workflowId: 'w1' };

const okReply = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const assistantFinal = (text: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) =>
  okReply({
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    model: 'liara',
    usage,
  });
const assistantToolCall = (
  name: string,
  args: string,
  usage = { prompt_tokens: 150, completion_tokens: 30 },
) =>
  okReply({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name, arguments: args } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    model: 'liara',
    usage,
  });

const run = (config: Record<string, unknown>, c: Record<string, unknown> = ctx) =>
  agentToolLoopNode.executor!(config, undefined, c as never);

function sentBody(i = 0): Record<string, unknown> {
  const call = safeFetch.mock.calls[i];
  if (!call) throw new Error(`nessuna chiamata #${String(i)}`);
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

beforeEach(() => {
  safeFetch.mockReset();
  vi.stubEnv('MEDEA_LIARA_BASE_URL', GW);
  vi.stubEnv('MEDEA_LICENSE_KEY', 'lic-abc');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('openAiLoopEndpoint — routing + auth', () => {
  it('liara: gateway da env, Bearer license, host esente, model claude-* legacy → omesso', () => {
    const e = openAiLoopEndpoint('liara', '', 'claude-sonnet-4-5', undefined);
    expect(e.url).toBe(`${GW}/chat/completions`);
    expect(e.headers.Authorization).toBe('Bearer lic-abc');
    expect(e.trustedHost).toBe('172.20.0.1:3006');
    expect(e.effectiveModel).toBe('');
  });

  it('openai BYOK: endpoint pubblico, Bearer apiKey, NESSUNA esenzione guard', () => {
    const e = openAiLoopEndpoint('openai', 'sk-x', '', undefined);
    expect(e.url).toContain('api.openai.com');
    expect(e.headers.Authorization).toBe('Bearer sk-x');
    expect(e.trustedHost).toBeUndefined();
    expect(e.effectiveModel).toBe('gpt-4o-mini');
  });

  it('gemini: endpoint OpenAI-COMPAT di Google (tools inclusi), Bearer apiKey', () => {
    const e = openAiLoopEndpoint('gemini', 'g-key', '', undefined);
    expect(e.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(e.headers.Authorization).toBe('Bearer g-key');
    expect(e.effectiveModel).toBe('gemini-2.0-flash');
    expect(e.trustedHost).toBeUndefined();
  });

  it('ollama: /v1/chat/completions OpenAI-compat, host esente (endpoint di sistema loopback)', () => {
    const e = openAiLoopEndpoint('ollama', '', '', 'http://localhost:11434');
    expect(e.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(e.trustedHost).toBe('localhost:11434');
    expect(e.effectiveModel).toBe('llama3.2');
    expect(e.headers.Authorization).toBeUndefined();
  });

  it.each([
    ['deepseek', 'https://api.deepseek.com/chat/completions', 'deepseek-chat'],
    ['xai', 'https://api.x.ai/v1/chat/completions', 'grok-2-latest'],
  ])('%s: OpenAI-compat con tools, Bearer apiKey, default %s', (provider, url, defModel) => {
    const e = openAiLoopEndpoint(provider, 'k-1', '', undefined);
    expect(e.url).toBe(url);
    expect(e.headers.Authorization).toBe('Bearer k-1');
    expect(e.effectiveModel).toBe(defModel);
  });

  it('provider ignoto → throw difensivo con messaggio esplicito', () => {
    expect(() => openAiLoopEndpoint('perplexity', 'k', '', undefined)).toThrow(
      /non supporta il tool-calling/,
    );
  });
});

describe('toOpenAiTools — conversione formato', () => {
  it('input_schema Anthropic → function.parameters OpenAI', () => {
    const out = toOpenAiTools([
      { name: 't', description: 'd', input_schema: { type: 'object', properties: {} } },
    ]) as { type: string; function: { name: string; parameters: unknown } }[];
    expect(out[0]?.type).toBe('function');
    expect(out[0]?.function.name).toBe('t');
    expect(out[0]?.function.parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('ai_agent_tool_loop — ramo Liara (default senza apiKey)', () => {
  it('🚨 config VUOTA (no provider, no key) → chiama il GATEWAY con tools OpenAI + tool_choice auto', async () => {
    safeFetch.mockResolvedValueOnce(assistantFinal('fatto'));
    const r = await run({ goal: 'dimmi ciao' });
    expect(safeFetch.mock.calls[0]![0] as string).toBe(`${GW}/chat/completions`);
    const body = sentBody();
    expect(body.tool_choice).toBe('auto');
    const tools = body.tools as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['http_request', 'flowforge_invoke', 'get_time', 'rag_search']),
    );
    const out = (r as { output: Record<string, unknown> }).output;
    expect(out.finalAnswer).toBe('fatto');
  });

  it('round-trip tool_calls: get_time eseguito, tool_call_id ricablato, poi finalAnswer + trace', async () => {
    safeFetch
      .mockResolvedValueOnce(assistantToolCall('get_time', '{}'))
      .mockResolvedValueOnce(assistantFinal('sono le 10'));
    const r = await run({ goal: 'che ore sono?' });
    const out = (
      r as { output: { finalAnswer: string; iterations: number; trace: { tool: string }[] } }
    ).output;
    expect(out.finalAnswer).toBe('sono le 10');
    expect(out.iterations).toBe(2);
    expect(out.trace).toHaveLength(1);
    expect(out.trace[0]?.tool).toBe('get_time');
    // La 2ª richiesta contiene il messaggio assistant CON tool_calls + il tool result
    const msgs = sentBody(1).messages as {
      role: string;
      tool_call_id?: string;
      tool_calls?: unknown;
    }[];
    expect(msgs.some((m) => m.role === 'assistant' && m.tool_calls !== undefined)).toBe(true);
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('tc-1');
  });

  it('🚨 _llm CUMULATIVO sulle iterazioni (usage API di entrambe le chiamate)', async () => {
    safeFetch
      .mockResolvedValueOnce(
        assistantToolCall('get_time', '{}', { prompt_tokens: 150, completion_tokens: 30 }),
      )
      .mockResolvedValueOnce(assistantFinal('ok', { prompt_tokens: 200, completion_tokens: 10 }));
    const r = await run({ goal: 'x' });
    const llm = (r as { output: { _llm: Record<string, unknown> } }).output._llm;
    expect(llm).toEqual({
      inputTokens: 350,
      outputTokens: 40,
      model: 'liara',
      provider: 'liara',
      fromApi: true,
    });
  });

  it("arguments GARBAGE dal modello → tool-result d'errore strutturato, il loop prosegue", async () => {
    safeFetch
      .mockResolvedValueOnce(assistantToolCall('get_time', '{{{non-json'))
      .mockResolvedValueOnce(assistantFinal('recuperato'));
    const r = await run({ goal: 'x' });
    const out = (r as { output: { finalAnswer: string; trace: { output: string }[] } }).output;
    expect(out.finalAnswer).toBe('recuperato');
    expect(out.trace[0]?.output).toContain('invalid tool arguments');
    // Il modello ha ricevuto l'errore come tool message (può correggersi)
    const msgs = sentBody(1).messages as { role: string; content?: string }[];
    expect(msgs.find((m) => m.role === 'tool')?.content).toContain('invalid tool arguments');
  });

  it('HTTP error a metà loop → output.error MA _llm presente (token della 1ª chiamata spesi)', async () => {
    safeFetch.mockResolvedValueOnce(assistantToolCall('get_time', '{}')).mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => 'bad gateway',
    });
    const r = await run({ goal: 'x' });
    const out = (r as { output: { error: string; _llm?: Record<string, unknown> } }).output;
    expect(out.error).toMatch(/Liara 502/);
    expect(out._llm).toMatchObject({ inputTokens: 150, outputTokens: 30 });
  });

  it('maxIterations superato → error + _llm cumulativo', async () => {
    safeFetch.mockResolvedValue(assistantToolCall('get_time', '{}'));
    const r = await run({ goal: 'x', maxIterations: '2' });
    const out = (r as { output: { error: string; _llm: { inputTokens: number } } }).output;
    expect(out.error).toMatch(/exceeded maxIterations=2/);
    expect(out._llm.inputTokens).toBe(300); // 2 iterazioni × 150
  });

  it('cancel già abortito → cancelled SENZA chiamare il gateway', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await run({ goal: 'x' }, { ...ctx, abortSignal: ac.signal });
    const out = (r as { output: { cancelled?: boolean } }).output;
    expect(out.cancelled).toBe(true);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("provider gemini esplicito → loop OpenAI-format verso l'endpoint compat di Google", async () => {
    safeFetch.mockResolvedValueOnce(assistantFinal('da gemini'));
    const r = await run({ provider: 'gemini', apiKey: 'g-key', goal: 'x' });
    expect(safeFetch.mock.calls[0]![0]).toContain(
      'generativelanguage.googleapis.com/v1beta/openai',
    );
    expect((r as { output: { finalAnswer: string } }).output.finalAnswer).toBe('da gemini');
  });

  it('🚨 provider senza tools (perplexity da Settings) → fallback DICHIARATO su Liara, il nodo FUNZIONA', async () => {
    safeFetch.mockResolvedValueOnce(assistantFinal('eseguito su liara'));
    const r = await run({ provider: 'perplexity', apiKey: 'k', goal: 'x' });
    const out = (
      r as {
        output: {
          finalAnswer: string;
          providerFallback: { from: string; reason: string };
          _llm: { provider: string };
        };
      }
    ).output;
    // La chiamata è andata al GATEWAY Liara, non a perplexity
    expect(safeFetch.mock.calls[0]![0]).toBe(`${GW}/chat/completions`);
    expect(out.finalAnswer).toBe('eseguito su liara');
    // Mai swap nascosto: fallback dichiarato + _llm mostra il provider REALE
    expect(out.providerFallback).toEqual({
      from: 'perplexity',
      reason: expect.stringContaining('non supporta il tool-calling') as string,
    });
    expect(out._llm.provider).toBe('liara');
  });
});

describe('ai_agent_tool_loop — retrocompatibilità config esistenti', () => {
  it('🚨 LEGACY: apiKey compilata SENZA provider → resta ANTHROPIC (formato tool_use nativo)', async () => {
    safeFetch.mockResolvedValueOnce(
      okReply({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'risposta claude' }],
        usage: { input_tokens: 80, output_tokens: 15 },
      }),
    );
    const r = await run({ apiKey: 'sk-ant-xyz', goal: 'x', model: 'claude-sonnet-4-5' });
    expect(safeFetch.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/messages');
    const headers = (safeFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('sk-ant-xyz');
    const out = (r as { output: { finalAnswer: string; _llm: Record<string, unknown> } }).output;
    expect(out.finalAnswer).toBe('risposta claude');
    // Fase 2: anche il ramo anthropic espone _llm dai campi usage API
    expect(out._llm).toEqual({
      inputTokens: 80,
      outputTokens: 15,
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      fromApi: true,
    });
  });
});
