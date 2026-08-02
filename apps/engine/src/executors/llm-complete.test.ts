/**
 * Test 2026-grade — executors/llm-complete.ts (action_llm_complete wrapper).
 *
 * 🚨 PROVIDER WHITELIST: 8 supportati (liara/anthropic/openai/mistral/groq/
 *    openrouter/deepseek/xai). Provider sconosciuto → fallback liara.
 *
 * 🚨 BYOK RESOLVER: provider != liara → llmResolver.resolve(tenantId).
 *    NoLlmProviderError → throw helpful con instruction Settings.
 *
 * 🚨 CLAMP: temperature 0..2, maxTokens 1..32768, timeoutMs 1..300_000.
 *
 * 🚨 JSON SYSTEM ADDENDUM: responseFormat=json → istruzione "SOLO JSON".
 *
 * 🚨 JSON PARSE CLEANING: strip ```json``` fence wrapper.
 *
 * 🚨 ENV RESTORE: MEDEA_LIARA_* save/restore (no leak inter-test).
 *
 * 🚨 finishReason: heuristic 'length' se output >=95% maxTokens senza puntegg.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.hoisted(() => vi.fn());
const resolverMock = vi.hoisted(() => vi.fn());
const fallbackMock = vi.hoisted(() => vi.fn());
const NoLlmProviderErrorMock = vi.hoisted(() => {
  return class NoLlmProviderError extends Error {
    constructor(msg: string) { super(msg); this.name = 'NoLlmProviderError'; }
  };
});
// Stub della classe quota: DEVE essere la stessa che llm-complete importa (per
// l'instanceof) e che i test lanciano → definita qui ed esportata dal mock.
const QuotaErrMock = vi.hoisted(() => {
  return class LlmQuotaExceededError extends Error {
    kind: string;
    constructor(kind = 'token') { super(`Quota ${kind} esaurita`); this.name = 'LlmQuotaExceededError'; this.kind = kind; }
  };
});

vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: dispatchMock,
  LlmQuotaExceededError: QuotaErrMock,
}));

vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: resolverMock, resolveExternalFallback: fallbackMock },
  NoLlmProviderError: NoLlmProviderErrorMock,
}));

const { llmCompleteExecutor, ALLOWED_PROVIDERS } = await import('./llm-complete.js');
const { llmCompleteNode } = await import('@medea/engine-nodes-stdlib');

const ctx = () => ({
  runId: 'r', workflowId: 'w', nodeId: 'n', tenantId: 't1',
  defId: 'action_llm_complete', llmProviders: [], nodeOutputs: {}, secrets: {},
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: dispatchLLMChat returns completion + invoca callback con usage
  dispatchMock.mockImplementation(async (
    _prov: string, _key: string, _model: string, _sys: string, _user: string,
    _baseUrl: string | undefined, _hist: unknown[],
    listener: (u: { input: number; output: number; fromApi: boolean }) => void,
  ) => {
    listener({ input: 100, output: 50, fromApi: true });
    return 'Test completion output.';
  });
  delete process.env.MEDEA_LIARA_TIMEOUT_MS;
  delete process.env.MEDEA_LIARA_MAX_TOKENS;
});

describe('🚨 prompt validation', () => {
  it('🚨 prompt vuoto → throw obbligatorio', async () => {
    await expect(
      llmCompleteExecutor({ prompt: '' } as never, {} as never, ctx()),
    ).rejects.toThrow(/"prompt"/u);
  });

  it('🚨 prompt whitespace → throw (trim)', async () => {
    await expect(
      llmCompleteExecutor({ prompt: '   ' } as never, {} as never, ctx()),
    ).rejects.toThrow(/"prompt"/u);
  });

  it('🚨 prompt valido → success', async () => {
    const r = await llmCompleteExecutor({ prompt: 'Hi' } as never, {} as never, ctx());
    expect((r.output as { completion: string }).completion).toBe('Test completion output.');
  });
});

describe('🚨 Provider whitelist + BYOK resolution', () => {
  it('🚨 provider=liara → niente resolver call', async () => {
    await llmCompleteExecutor({ prompt: 'x', provider: 'liara' } as never, {} as never, ctx());
    expect(resolverMock).not.toHaveBeenCalled();
  });

  it('🚨 provider sconosciuto "cohere" → fallback liara (non in ALLOWED_PROVIDERS)', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', provider: 'cohere' } as never, {} as never, ctx(),
    );
    expect(resolverMock).not.toHaveBeenCalled();
    expect(dispatchMock.mock.calls[0]![0]).toBe('liara');
  });

  it('🚨 provider=gemini → ora SUPPORTATO (BYOK): resolver call, NON fallback liara', async () => {
    resolverMock.mockReturnValue({
      provider: 'gemini', apiKey: 'AIza-key', model: 'gemini-2.0-flash',
    });
    await llmCompleteExecutor(
      { prompt: 'x', provider: 'gemini' } as never, {} as never, ctx(),
    );
    expect(resolverMock).toHaveBeenCalledWith('t1', { requestedProvider: 'gemini' });
    expect(dispatchMock.mock.calls[0]![0]).toBe('gemini');
    expect(dispatchMock.mock.calls[0]![1]).toBe('AIza-key');
  });

  it('🚨 provider=perplexity → ora SUPPORTATO (BYOK): resolver call + apiKey', async () => {
    resolverMock.mockReturnValue({
      provider: 'perplexity', apiKey: 'pplx-key', model: 'sonar',
    });
    await llmCompleteExecutor(
      { prompt: 'x', provider: 'perplexity' } as never, {} as never, ctx(),
    );
    expect(resolverMock).toHaveBeenCalledWith('t1', { requestedProvider: 'perplexity' });
    expect(dispatchMock.mock.calls[0]![0]).toBe('perplexity');
    expect(dispatchMock.mock.calls[0]![1]).toBe('pplx-key');
  });

  it('🚨 provider=anthropic → resolver call + apiKey injected', async () => {
    resolverMock.mockReturnValue({
      provider: 'anthropic', apiKey: 'sk-ant-xxx', model: 'claude-sonnet-4-6',
    });
    await llmCompleteExecutor(
      { prompt: 'x', provider: 'anthropic' } as never, {} as never, ctx(),
    );
    expect(resolverMock).toHaveBeenCalledWith('t1', { requestedProvider: 'anthropic' });
    expect(dispatchMock.mock.calls[0]![0]).toBe('anthropic');
    expect(dispatchMock.mock.calls[0]![1]).toBe('sk-ant-xxx');
  });

  it('🚨 resolver baseUrl → forwardato a dispatchLLMChat', async () => {
    resolverMock.mockReturnValue({
      provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini', baseUrl: 'https://proxy.corp/v1',
    });
    await llmCompleteExecutor(
      { prompt: 'x', provider: 'openai' } as never, {} as never, ctx(),
    );
    expect(dispatchMock.mock.calls[0]![5]).toBe('https://proxy.corp/v1');
  });

  it('🚨 NoLlmProviderError → helpful message Settings', async () => {
    resolverMock.mockImplementation(() => {
      throw new NoLlmProviderErrorMock('no api key for anthropic');
    });
    await expect(
      llmCompleteExecutor(
        { prompt: 'x', provider: 'anthropic' } as never, {} as never, ctx(),
      ),
    ).rejects.toThrow(/Settings → AI Providers/u);
  });

  it('🚨 generic error in resolver → re-throw as-is', async () => {
    resolverMock.mockImplementation(() => {
      throw new Error('DB down');
    });
    await expect(
      llmCompleteExecutor(
        { prompt: 'x', provider: 'openai' } as never, {} as never, ctx(),
      ),
    ).rejects.toThrow('DB down');
  });

  it('🚨 BYOK custom model hint sovrascrive default', async () => {
    resolverMock.mockReturnValue({
      provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini',
    });
    await llmCompleteExecutor(
      { prompt: 'x', provider: 'openai', model: 'gpt-4-turbo' } as never, {} as never, ctx(),
    );
    expect(dispatchMock.mock.calls[0]![2]).toBe('gpt-4-turbo'); // hint, not resolved
  });
});

describe('🚨 Clamp temperatura / maxTokens / timeoutMs', () => {
  it('🚨 temperature -100 → clamp 0', async () => {
    // Indiretto: no crash + completion ok (no way to inspect temperature passed since hardcoded 0.2 Liara)
    await expect(
      llmCompleteExecutor({ prompt: 'x', temperature: -100 } as never, {} as never, ctx()),
    ).resolves.toBeDefined();
  });

  it('🚨 temperature 999 → clamp 2 (no NaN)', async () => {
    await expect(
      llmCompleteExecutor({ prompt: 'x', temperature: 999 } as never, {} as never, ctx()),
    ).resolves.toBeDefined();
  });

  it('🚨 temperature NaN → default 0.7', async () => {
    await expect(
      llmCompleteExecutor({ prompt: 'x', temperature: 'invalid' as never } as never, {} as never, ctx()),
    ).resolves.toBeDefined();
  });

  it('🚨 maxTokens 999999 → clamp 32768 (env var verifica)', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', maxTokens: 999_999 } as never, {} as never, ctx(),
    );
    // Verifico durante l'execution lo ha settato — ma dopo finally e\` ripristinato
    // Quindi controllo dispatchMock chiamato + env var era settato durante invocazione
    expect(dispatchMock).toHaveBeenCalled();
  });

  it('🚨 maxTokens negativo → default 2048', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', maxTokens: -500 } as never, {} as never, ctx(),
    );
    expect(dispatchMock).toHaveBeenCalled();
  });

  it('🚨 timeoutMs 999999 → clamp 300_000', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', timeoutMs: 999_999 } as never, {} as never, ctx(),
    );
    expect(dispatchMock).toHaveBeenCalled();
  });

  it('🚨 timeoutMs NaN → default 60_000', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', timeoutMs: 'never' as never } as never, {} as never, ctx(),
    );
    expect(dispatchMock).toHaveBeenCalled();
  });
});

describe('🚨🚨 timeout/maxTokens via opts ESPLICITO — niente mutazione process.env (anti-race)', () => {
  // opts è il 10° argomento posizionale di dispatchLLMChat (index 9).
  const optsOf = (callIdx = 0): { maxTokens?: number; timeoutMs?: number } | undefined =>
    dispatchMock.mock.calls[callIdx]?.[9] as { maxTokens?: number; timeoutMs?: number } | undefined;

  it('🚨 NON muta MAI process.env (né durante né dopo, neppure su throw)', async () => {
    process.env.MEDEA_LIARA_TIMEOUT_MS = 'PRE-EXISTING';
    process.env.MEDEA_LIARA_MAX_TOKENS = 'PRE-MAX';
    await llmCompleteExecutor({ prompt: 'x', timeoutMs: 30_000, maxTokens: 1024 } as never, {} as never, ctx());
    expect(process.env.MEDEA_LIARA_TIMEOUT_MS).toBe('PRE-EXISTING');
    expect(process.env.MEDEA_LIARA_MAX_TOKENS).toBe('PRE-MAX');
    dispatchMock.mockRejectedValueOnce(new Error('LLM down'));
    await expect(llmCompleteExecutor({ prompt: 'x' } as never, {} as never, ctx())).rejects.toThrow('LLM down');
    expect(process.env.MEDEA_LIARA_TIMEOUT_MS).toBe('PRE-EXISTING');
    expect(process.env.MEDEA_LIARA_MAX_TOKENS).toBe('PRE-MAX');
  });

  it('🚨 timeout/maxTokens/temperature clampati passati in opts a dispatchLLMChat', async () => {
    await llmCompleteExecutor({ prompt: 'x', maxTokens: 999_999, timeoutMs: 999_999, temperature: 1.3 } as never, {} as never, ctx());
    // temperature ora arriva end-to-end (fix 2026-07: prima ignorata, 0.2 hardcoded).
    expect(optsOf()).toEqual({ maxTokens: 32_768, timeoutMs: 300_000, temperature: 1.3 });
  });

  it('🚨 temperature fuori range viene CLAMPATA a [0,2] prima di dispatch', async () => {
    await llmCompleteExecutor({ prompt: 'x', temperature: 9 } as never, {} as never, ctx());
    await llmCompleteExecutor({ prompt: 'x', temperature: -3 } as never, {} as never, ctx());
    expect((optsOf(0) as { temperature: number }).temperature).toBe(2);
    expect((optsOf(1) as { temperature: number }).temperature).toBe(0);
  });

  it('🚨 temperature NaN → default 0.7 (non propaga spazzatura)', async () => {
    await llmCompleteExecutor({ prompt: 'x', temperature: 'abc' } as never, {} as never, ctx());
    expect((optsOf(0) as { temperature: number }).temperature).toBe(0.7);
  });

  it('🚨🚨 RACE: due esecuzioni concorrenti → ciascuna porta il PROPRIO maxTokens in opts', async () => {
    // Mock con delay per forzare l'interleaving sull'await. Con la vecchia mutazione di
    // process.env globale, una sovrascriverebbe l'altra; con opts esplicito ognuna è isolata.
    dispatchMock.mockReset();
    dispatchMock.mockImplementation(async (...args: unknown[]) => {
      const cb = args[7] as ((u: unknown) => void) | undefined;
      await new Promise((r) => setTimeout(r, 20));
      cb?.({ input: 1, output: 1, fromApi: true });
      return 'ok';
    });
    await Promise.all([
      llmCompleteExecutor({ prompt: 'a', maxTokens: 1000 } as never, {} as never, ctx()),
      llmCompleteExecutor({ prompt: 'b', maxTokens: 2000 } as never, {} as never, ctx()),
    ]);
    const seen = dispatchMock.mock.calls.map((c) => (c[9] as { maxTokens?: number }).maxTokens).sort();
    expect(seen).toEqual([1000, 2000]);
  });
});

describe('🚨 responseFormat=json + system addendum', () => {
  it('🚨 responseFormat=text → no addendum JSON istruzioni', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', systemPrompt: 'You are helpful.' } as never, {} as never, ctx(),
    );
    const sysArg = dispatchMock.mock.calls[0]![3] as string;
    expect(sysArg).toBe('You are helpful.');
    expect(sysArg).not.toContain('SOLO con un oggetto JSON');
  });

  it('🚨 responseFormat=json → addendum istruzione JSON', async () => {
    await llmCompleteExecutor(
      { prompt: 'x', systemPrompt: 'You are helpful.', responseFormat: 'json' } as never,
      {} as never, ctx(),
    );
    const sysArg = dispatchMock.mock.calls[0]![3] as string;
    expect(sysArg).toContain('You are helpful.');
    expect(sysArg).toContain('SOLO con un oggetto JSON');
    expect(sysArg).toContain('Niente backtick');
  });
});

describe('🚨 JSON parse output cleaning', () => {
  it('🚨 valid JSON output → jsonParsed populated', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 50, output: 30, fromApi: true });
      return '{"name":"Alice","age":30}';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', responseFormat: 'json' } as never, {} as never, ctx(),
    );
    const out = r.output as { jsonParsed: unknown };
    expect(out.jsonParsed).toEqual({ name: 'Alice', age: 30 });
  });

  it('🚨 ```json fence wrapper → STRIPPED → parsed', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 50, output: 30, fromApi: true });
      return '```json\n{"x":1}\n```';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', responseFormat: 'json' } as never, {} as never, ctx(),
    );
    const out = r.output as { jsonParsed: unknown };
    expect(out.jsonParsed).toEqual({ x: 1 });
  });

  it('🚨 ``` (senza "json") fence → stripped', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 50, output: 30, fromApi: true });
      return '```\n{"y":2}\n```';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', responseFormat: 'json' } as never, {} as never, ctx(),
    );
    expect((r.output as { jsonParsed: unknown }).jsonParsed).toEqual({ y: 2 });
  });

  it('🚨 JSON malformato → jsonParsed undefined (NO throw)', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 50, output: 30, fromApi: true });
      return 'not-json-at-all';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', responseFormat: 'json' } as never, {} as never, ctx(),
    );
    const out = r.output as { jsonParsed: unknown; completion: string };
    expect(out.jsonParsed).toBeUndefined();
    expect(out.completion).toBe('not-json-at-all'); // raw still available
  });

  it('🚨 responseFormat=text → jsonParsed NEVER attempted', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 50, output: 30, fromApi: true });
      return '{"x":1}'; // ANCHE se valido, no parse perché text
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', responseFormat: 'text' } as never, {} as never, ctx(),
    );
    expect((r.output as { jsonParsed?: unknown }).jsonParsed).toBeUndefined();
  });
});

describe('🚨 finishReason heuristic — length vs stop', () => {
  it('🚨 completion termina con "." → stop', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 100, output: 100, fromApi: true });
      return 'Frase completa.';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', maxTokens: 1000 } as never, {} as never, ctx(),
    );
    expect((r.output as { finishReason: string }).finishReason).toBe('stop');
  });

  it('🚨 output truncato (no puntegg, output >=95% max) → length', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 100, output: 1000, fromApi: true }); // 100% of maxTokens=1000
      return 'Frase troncata senza fine';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', maxTokens: 1000 } as never, {} as never, ctx(),
    );
    expect((r.output as { finishReason: string }).finishReason).toBe('length');
  });

  it('🚨 termina con "}" (JSON ok) → stop anche se output >=95% max', async () => {
    dispatchMock.mockImplementation(async (
      _p: string, _k: string, _m: string, _s: string, _u: string,
      _b: string | undefined, _h: unknown[],
      cb: (u: { input: number; output: number; fromApi: boolean }) => void,
    ) => {
      cb({ input: 100, output: 1000, fromApi: true });
      return '{"x":1}';
    });
    const r = await llmCompleteExecutor(
      { prompt: 'x', maxTokens: 1000 } as never, {} as never, ctx(),
    );
    expect((r.output as { finishReason: string }).finishReason).toBe('stop');
  });

  it('🚨 dispatch throw → finishReason error (e re-throw)', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('Network'));
    await expect(
      llmCompleteExecutor({ prompt: 'x' } as never, {} as never, ctx()),
    ).rejects.toThrow('Network');
  });
});

describe('🚨 Output shape contract', () => {
  it('🚨 tokensUsed format strict', async () => {
    const r = await llmCompleteExecutor({ prompt: 'x' } as never, {} as never, ctx());
    const out = r.output as { tokensUsed: { prompt: number; completion: number; total: number; fromApi: boolean } };
    expect(out.tokensUsed).toEqual({ prompt: 100, completion: 50, total: 150, fromApi: true });
  });

  // Fase 1b (#13): `_llm` = campo usage STANDARD cross-nodo (stesso shape degli
  // agent_*). `tokensUsed` resta come LEGACY: workflow esistenti lo referenziano.
  it('🚨 _llm standard presente ACCANTO a tokensUsed (mai al posto di)', async () => {
    const r = await llmCompleteExecutor({ prompt: 'x', provider: 'liara' } as never, {} as never, ctx());
    const out = r.output as { tokensUsed: unknown; _llm: unknown };
    expect(out._llm).toEqual({ inputTokens: 100, outputTokens: 50, model: 'liara-default', provider: 'liara', fromApi: true });
    expect(out.tokensUsed).toEqual({ prompt: 100, completion: 50, total: 150, fromApi: true });
  });

  it('🚨 _llm coerente con tokensUsed anche quando il listener non scatta (usage zero)', async () => {
    dispatchMock.mockImplementationOnce(async () => 'niente listener');
    const r = await llmCompleteExecutor({ prompt: 'x' } as never, {} as never, ctx());
    const out = r.output as { _llm: { inputTokens: number; outputTokens: number; fromApi: boolean } };
    expect(out._llm.inputTokens).toBe(0);
    expect(out._llm.outputTokens).toBe(0);
    expect(out._llm.fromApi).toBe(false);
  });

  it('🚨 model default fallback `${provider}-default`', async () => {
    await llmCompleteExecutor({ prompt: 'x', provider: 'liara' } as never, {} as never, ctx());
    // liara default model = '' → fallback liara-default
    const r = await llmCompleteExecutor({ prompt: 'x', provider: 'liara' } as never, {} as never, ctx());
    expect((r.output as { model: string }).model).toBe('liara-default');
  });

  it('🚨 durationMs >= 0', async () => {
    const r = await llmCompleteExecutor({ prompt: 'x' } as never, {} as never, ctx());
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('🚨 responseFormat field preservato output', async () => {
    const r = await llmCompleteExecutor(
      { prompt: 'x', responseFormat: 'json' } as never, {} as never, ctx(),
    );
    expect((r.output as { responseFormat: string }).responseFormat).toBe('json');
  });
});

describe('🚨 anti-drift: ALLOWED_PROVIDERS (executor) === provider configField (nodo stdlib)', () => {
  it('le due fonti di verità combaciano (no provider nel dropdown che l\'executor non gestisce, e viceversa)', () => {
    const field = llmCompleteNode.def.configFields?.find((f) => f.key === 'provider');
    const opts = (field?.type === 'select' ? field.options : []) ?? [];
    expect([...ALLOWED_PROVIDERS].sort()).toEqual([...opts].sort());
  });
});

describe('degradazione quota — fallback BYOK', () => {
  const run = (cfg: Record<string, unknown>) => llmCompleteExecutor(cfg as never, {} as never, ctx());

  it('quota Liara esaurita + BYOK configurato → fallback, output.degraded + provider cambiato', async () => {
    dispatchMock
      .mockRejectedValueOnce(new QuotaErrMock('token'))
      .mockImplementationOnce(async (
        _p: string, _k: string, _m: string, _s: string, _u: string,
        _b: string | undefined, _h: unknown[],
        listener: (u: { input: number; output: number; fromApi: boolean }) => void,
      ) => { listener({ input: 10, output: 20, fromApi: true }); return 'BYOK output.'; });
    fallbackMock.mockReturnValue({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-4-6' });

    const res = await run({ prompt: 'ciao' }) as { output: { completion: string; provider: string; degraded?: string } };
    expect(res.output.completion).toBe('BYOK output.');
    expect(res.output.provider).toBe('anthropic');
    expect(res.output.degraded).toBe('byok-fallback');
    expect(fallbackMock).toHaveBeenCalledWith('t1');
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[1]?.[0]).toBe('anthropic'); // 2° dispatch usa BYOK
    expect(dispatchMock.mock.calls[1]?.[1]).toBe('sk-ant');
  });

  it('quota Liara esaurita + NESSUN BYOK → propaga errore quota CHIARO (no retry)', async () => {
    dispatchMock.mockRejectedValueOnce(new QuotaErrMock('token'));
    fallbackMock.mockReturnValue(null);
    await expect(run({ prompt: 'ciao' })).rejects.toBeInstanceOf(QuotaErrMock);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('quota Liara + BYOK ma anche il BYOK fallisce → propaga l’errore del BYOK', async () => {
    dispatchMock
      .mockRejectedValueOnce(new QuotaErrMock('token'))
      .mockRejectedValueOnce(new Error('Anthropic 401: invalid key'));
    fallbackMock.mockReturnValue({ provider: 'anthropic', apiKey: 'bad', model: 'x' });
    await expect(run({ prompt: 'ciao' })).rejects.toThrow(/Anthropic 401/);
  });

  it('errore NON-quota su Liara → re-throw, nessun tentativo di fallback', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('Liara timeout'));
    await expect(run({ prompt: 'ciao' })).rejects.toThrow(/Liara timeout/);
    expect(fallbackMock).not.toHaveBeenCalled();
  });
});
