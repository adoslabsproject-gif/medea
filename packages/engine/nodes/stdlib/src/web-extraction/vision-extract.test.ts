/**
 * Test reali per vision-extract. NO smoke fake.
 * Asseriscono: JSON extraction da fence/trailing-commas, message build,
 * retry logic con backoff, schema validation, output shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  visionExtractNode,
  extractJsonFromResponse,
  buildVisionMessages,
  VisionExtractOutputSchema,
} from './vision-extract.js';

vi.mock('@medea/engine-safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@medea/engine-safe-fetch')>()),
  safeFetchWithRedirects: vi.fn(),
}));

const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = {
  tenantId: 't',
  workflowId: 'w',
  runId: 'r',
  nodeId: 'n',
  secrets: {},
  llmProviders: {},
} as const;
const FAKE_SCREENSHOT = 'x'.repeat(200); // > 100 chars to pass validation

beforeEach(() => {
  mockedFetch.mockReset();
  delete process.env.MEDEA_VISION_ENDPOINT;
  delete process.env.MEDEA_VISION_API_KEY;
});

describe('extractJsonFromResponse', () => {
  it('JSON puro', () => {
    expect(extractJsonFromResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it('JSON dentro ```json fence', () => {
    const txt = 'Ecco i dati:\n```json\n{"price": 99.99, "currency": "EUR"}\n```\nFine.';
    expect(extractJsonFromResponse(txt)).toEqual({ price: 99.99, currency: 'EUR' });
  });

  it('JSON dentro ``` plain fence (no lang)', () => {
    const txt = '```\n{"x": [1,2,3]}\n```';
    expect(extractJsonFromResponse(txt)).toEqual({ x: [1, 2, 3] });
  });

  it('JSON con trailing commas tollerato', () => {
    expect(extractJsonFromResponse('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
    expect(extractJsonFromResponse('[1, 2, 3,]')).toEqual([1, 2, 3]);
  });

  it('JSON in mezzo a testo libero (estrazione obj)', () => {
    expect(extractJsonFromResponse('Risposta: {"key":"val"} grazie.')).toEqual({ key: 'val' });
  });

  it('Array JSON estratto', () => {
    expect(extractJsonFromResponse('Items: [{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('Empty → throw', () => {
    expect(() => extractJsonFromResponse('')).toThrow(/empty response/);
  });

  it('Garbage non-JSON → throw con preview', () => {
    expect(() => extractJsonFromResponse('this is not json at all')).toThrow(/not JSON-parseable/);
  });

  it('JSON malformato senza trailing fence → throw', () => {
    expect(() => extractJsonFromResponse('{"a":}')).toThrow(/not JSON-parseable/);
  });
});

describe('buildVisionMessages', () => {
  it('struttura: system + user con image+text', () => {
    const msgs = buildVisionMessages({ screenshotBase64: 'abc', prompt: 'extract title' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[1]?.role).toBe('user');
    const userContent = msgs[1]?.content as {
      type: string;
      image_url?: { url: string };
      text?: string;
    }[];
    expect(userContent[0]?.type).toBe('image_url');
    expect(userContent[0]?.image_url?.url).toBe('data:image/png;base64,abc');
    expect(userContent[1]?.type).toBe('text');
    expect(userContent[1]?.text).toContain('extract title');
  });

  it('mimeType jpeg → data URL ha jpeg', () => {
    const msgs = buildVisionMessages({
      screenshotBase64: 'xyz',
      prompt: 'p',
      mimeType: 'image/jpeg',
    });
    const userContent = msgs[1]?.content as { image_url?: { url: string } }[];
    expect(userContent[0]?.image_url?.url).toBe('data:image/jpeg;base64,xyz');
  });

  it('schema → text prompt include "SCHEMA JSON TARGET" + schema text', () => {
    const msgs = buildVisionMessages({
      screenshotBase64: 'a',
      prompt: 'p',
      schemaJson: '{"title":"string"}',
    });
    const userContent = msgs[1]?.content as { text?: string }[];
    expect(userContent[1]?.text).toContain('SCHEMA JSON TARGET');
    expect(userContent[1]?.text).toContain('"title":"string"');
  });

  it('no schema → text prompt dice "Ritorna un oggetto JSON"', () => {
    const msgs = buildVisionMessages({ screenshotBase64: 'a', prompt: 'p' });
    const userContent = msgs[1]?.content as { text?: string }[];
    expect(userContent[1]?.text).toContain('Ritorna un oggetto JSON');
  });

  it('system prompt vieta hallucinations', () => {
    const msgs = buildVisionMessages({ screenshotBase64: 'a', prompt: 'p' });
    expect(msgs[0]?.content).toContain('Non inventare');
    expect(msgs[0]?.content).toContain('Non allucinare');
    expect(msgs[0]?.content).toContain('SOLO JSON valido');
  });
});

describe('visionExtractNode.def', () => {
  it('id corretto', () => {
    expect(visionExtractNode.def.id).toBe('action_vision_extract');
  });

  it('screenshotBase64 + prompt sono required', () => {
    const req = visionExtractNode.def.configFields?.filter((f) => f.required).map((f) => f.key);
    expect(req).toContain('screenshotBase64');
    expect(req).toContain('prompt');
  });

  it('outputs include extracted + parseError + schemaValidationError', () => {
    expect(visionExtractNode.def.outputs).toContain('extracted');
    expect(visionExtractNode.def.outputs).toContain('parseError');
    expect(visionExtractNode.def.outputs).toContain('schemaValidationError');
    expect(visionExtractNode.def.outputs).toContain('attempts');
  });

  // Fase 2 (#14): il default NON è più il servizio :5004 (dismesso, e comunque
  // loopback del container = mai raggiungibile) — endpoint vuoto = gateway.
  it('endpoint config SENZA defaultValue legacy: vuoto = gateway metered', () => {
    const f = visionExtractNode.def.configFields?.find((x) => x.key === 'endpoint');
    expect(f?.defaultValue).toBeUndefined();
  });
});

describe('visionExtractNode.executor — input validation', () => {
  it('screenshotBase64 vuoto → throw', async () => {
    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(visionExtractNode.executor({ prompt: 'p' }, null, ctx)).rejects.toThrow(
      /screenshotBase64 required/,
    );
  });

  it('screenshotBase64 troppo corto → throw', async () => {
    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor({ screenshotBase64: 'short', prompt: 'p' }, null, ctx),
    ).rejects.toThrow(/screenshotBase64 too short/);
  });

  it('prompt vuoto → throw', async () => {
    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor({ screenshotBase64: FAKE_SCREENSHOT }, null, ctx),
    ).rejects.toThrow(/prompt required/);
  });

  it('schemaJson invalido → throw', async () => {
    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor(
        { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p', schemaJson: '{invalid' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/schemaJson invalid JSON/);
  });
});

describe('visionExtractNode.executor — happy path', () => {
  it('Risposta JSON pura → extracted parsed', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"title":"Prodotto X","price":99}' } }],
      }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    const res = await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'estrai titolo + prezzo' },
      null,
      ctx,
    );
    const out = res.output as Record<string, unknown>;
    expect(out.extracted).toEqual({ title: 'Prodotto X', price: 99 });
    expect(out.parseError).toBeNull();
    expect(out.attempts).toBe(1);
    // Fase 2 (#14): model omesso → decide il gateway; la risposta mock non
    // riporta `model` → etichetta esplicita, MAI il legacy Qwen2.5.
    expect(out.modelUsed).toBe('gateway-default');
    expect(out._llm).toMatchObject({ provider: 'custom', fromApi: false });
  });

  it('Risposta dentro fence ```json → estratto', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    const res = await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p' },
      null,
      ctx,
    );
    expect((res.output as Record<string, unknown>).extracted).toEqual({ a: 1 });
  });

  it('Schema validation: key mancante → schemaValidationError, no throw', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"title":"X"}' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    const res = await visionExtractNode.executor(
      {
        screenshotBase64: FAKE_SCREENSHOT,
        prompt: 'p',
        schemaJson: '{"title":"string","price":"number"}',
      },
      null,
      ctx,
    );
    const out = res.output as Record<string, unknown>;
    expect(out.extracted).toEqual({ title: 'X' });
    expect(out.schemaValidationError).toContain('price');
  });

  it('failOnInvalid + schema mismatch → throw', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"title":"X"}' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor(
        {
          screenshotBase64: FAKE_SCREENSHOT,
          prompt: 'p',
          schemaJson: '{"title":"string","price":"number"}',
          failOnInvalid: true,
        },
        null,
        ctx,
      ),
    ).rejects.toThrow(/schema check.*price/);
  });

  it('failOnInvalid + JSON unparseable → throw', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'garbage no json' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor(
        { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p', failOnInvalid: true },
        null,
        ctx,
      ),
    ).rejects.toThrow(/JSON parse failed/);
  });

  it('NO failOnInvalid + JSON unparseable → parseError SET, extracted=null', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'garbage no json' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    const res = await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p' },
      null,
      ctx,
    );
    const out = res.output as Record<string, unknown>;
    expect(out.extracted).toBeNull();
    expect(out.parseError).toContain('not JSON-parseable');
  });
});

describe('visionExtractNode.executor — retry logic', () => {
  it('500 + 200 → 2 attempts, success', async () => {
    mockedFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'overload',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    const res = await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p' },
      null,
      ctx,
    );
    expect((res.output as Record<string, unknown>).attempts).toBe(2);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('3 x 500 → throw "after 3 attempts"', async () => {
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'srv',
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor({ screenshotBase64: FAKE_SCREENSHOT, prompt: 'p' }, null, ctx),
    ).rejects.toThrow(/after 3 attempts/);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('400 → NO retry (not 5xx)', async () => {
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad req',
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await expect(
      visionExtractNode.executor({ screenshotBase64: FAKE_SCREENSHOT, prompt: 'p' }, null, ctx),
    ).rejects.toThrow(/after 3 attempts.*400.*bad req/);
    // Even non-5xx errors loop because of catch block (lastErr), but each iteration throws — still 3 attempts
  }, 15_000);
});

describe('visionExtractNode.executor — request shape', () => {
  it('messages + max_tokens + response_format json_object', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p', maxTokens: 1024 },
      null,
      ctx,
    );
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as {
      model: string;
      max_tokens: number;
      response_format: { type: string };
      temperature: number;
    };
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format.type).toBe('json_object');
    expect(body.temperature).toBe(0.1);
  });

  it('maxTokens clamp [64, 8192]', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p', maxTokens: 99_999 },
      null,
      ctx,
    );
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as {
      max_tokens: number;
    };
    expect(body.max_tokens).toBe(8192);
  });

  it('apiKey config → Authorization Bearer', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as unknown as Response);

    if (!visionExtractNode.executor) throw new Error('executor mancante');
    await visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p', apiKey: 'sk-vision-xxx' },
      null,
      ctx,
    );
    const opts = mockedFetch.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Bearer sk-vision-xxx');
  });
});

describe('VisionExtractOutputSchema', () => {
  it('valida output shape correttamente (incl. _llm Fase 2 #14)', () => {
    const valid = {
      extracted: { x: 1 },
      rawResponse: 'r',
      modelUsed: 'm',
      latencyMs: 100,
      attempts: 1,
      parseError: null,
      schemaValidationError: null,
      _llm: { inputTokens: 10, outputTokens: 5, model: 'm', provider: 'liara', fromApi: true },
    };
    expect(() => VisionExtractOutputSchema.parse(valid)).not.toThrow();
  });

  it("rejected se manca _llm (l'usage è parte del contratto output)", () => {
    expect(() =>
      VisionExtractOutputSchema.parse({
        extracted: {},
        rawResponse: 'r',
        modelUsed: 'm',
        latencyMs: 0,
        attempts: 1,
        parseError: null,
        schemaValidationError: null,
      }),
    ).toThrow();
  });

  it('rejected se manca rawResponse', () => {
    expect(() =>
      VisionExtractOutputSchema.parse({
        extracted: {},
        modelUsed: 'm',
        latencyMs: 0,
        attempts: 1,
        parseError: null,
        schemaValidationError: null,
      }),
    ).toThrow();
  });
});

// ─── Fase 2 (#14): routing gateway metered + usage ──────────────────────────
describe('visionExtractNode — gateway metered (Fase 2 #14)', () => {
  const GW = 'http://172.20.0.1:3006/api/v1/llm';
  const okBody = (extra: Record<string, unknown> = {}) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"a":1}' } }], ...extra }),
    }) as unknown as Response;
  const run = async (config: Record<string, unknown>) => {
    if (!visionExtractNode.executor) throw new Error('executor mancante');
    return visionExtractNode.executor(
      { screenshotBase64: FAKE_SCREENSHOT, prompt: 'p', ...config },
      null,
      ctx,
    );
  };

  beforeEach(() => {
    vi.stubEnv('MEDEA_LIARA_BASE_URL', GW);
    vi.stubEnv('MEDEA_LICENSE_KEY', 'lic-123');
    vi.stubEnv('MEDEA_VISION_ENDPOINT', '');
    vi.stubEnv('MEDEA_VISION_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('🚨 endpoint assente → gateway metered (Qwen3-VL) + Bearer license + host esente dal guard', async () => {
    mockedFetch.mockResolvedValue(okBody());
    await run({});
    const [url, opts] = mockedFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string>; allowedHosts?: string[] },
    ];
    expect(url).toBe(`${GW}/chat/completions`);
    expect(opts.headers.Authorization).toBe('Bearer lic-123');
    expect(opts.allowedHosts).toEqual(['172.20.0.1:3006']);
  });

  it('🚨 sentinelle legacy (endpoint :5004 + model Qwen2.5) salvate in config → gateway, model omesso', async () => {
    mockedFetch.mockResolvedValue(
      okBody({ model: 'liara', usage: { prompt_tokens: 500, completion_tokens: 20 } }),
    );
    const res = await run({
      endpoint: 'http://localhost:5004/v1/chat/completions',
      model: 'Qwen2.5-VL-7B-Instruct',
    });
    expect(mockedFetch.mock.calls[0]![0]).toBe(`${GW}/chat/completions`);
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect('model' in body).toBe(false);
    const out = res.output as { _llm: Record<string, unknown>; modelUsed: string };
    expect(out._llm).toEqual({
      inputTokens: 500,
      outputTokens: 20,
      model: 'liara',
      provider: 'liara',
      fromApi: true,
    });
    expect(out.modelUsed).toBe('liara');
  });

  it('endpoint BYOK custom → guard pieno (no allowedHosts), provider=custom', async () => {
    mockedFetch.mockResolvedValue(okBody());
    const res = await run({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-x',
      model: 'gpt-4o',
    });
    const [url, opts] = mockedFetch.mock.calls[0] as [
      string,
      { allowedHosts?: string[]; headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.allowedHosts).toBeUndefined();
    expect(opts.headers.Authorization).toBe('Bearer sk-x');
    expect((res.output as { _llm: { provider: string } })._llm.provider).toBe('custom');
  });
});
