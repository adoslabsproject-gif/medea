/**
 * Caratterizzazione + bug-bounty del path STREAMING del dispatcher LLM.
 *
 * Copre due funzioni che condividono il plumbing SSE Liara/vLLM:
 *  - dispatchLLMChatStructuredStreaming  (JSON-schema constraint — usata dallo
 *    scaffold singleshot). Comportamento wire CARATTERIZZATO qui PRIMA del
 *    refactor che estrae lo SSE-reader condiviso → prova di equivalenza.
 *  - dispatchLLMChatStreaming            (PLAIN, niente schema — usata dal
 *    node-generator per la progressione token-by-token).
 *
 * Il loop SSE (reader/decoder/parse-delta/usage/<think>-strip) NON era coperto
 * da test diretti: questi test colmano quel buco e fanno da rete anti-regressione
 * per la condivisione del codice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config.js', () => ({
  isLiaraEnabled: () => true,
  liaraBaseUrl: () => 'http://127.0.0.1:3003/v1',
}));

vi.mock('@/lib/circuit-breaker.js', () => ({
  CircuitBreaker: class {
    async execute<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
  circuitBreakerRegistry: { get: () => null },
}));

interface CapturedReq {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
let captured: CapturedReq[] = [];

/** Costruisce un body SSE leggibile, emesso a "frame" per simulare confini di
 *  read arbitrari (anche righe spezzate a metà). */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]!));
      else controller.close();
    },
  });
}

/** Frame `data: {...}\n\n` OpenAI-compat con un delta.content. */
function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

let streamFramesFor: (body: Record<string, unknown>) => string[] = () => [];
let nonStreamJson: unknown = { choices: [{ message: { content: 'fallback-text' } }] };

beforeEach(() => {
  captured = [];
  streamFramesFor = () => [deltaFrame('hello '), deltaFrame('world'), 'data: [DONE]\n\n'];
  nonStreamJson = { choices: [{ message: { content: 'fallback-text' } }] };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    captured.push({ url, body, headers: (init.headers ?? {}) as Record<string, string> });
    if (body.stream === true) {
      return {
        ok: true,
        status: 200,
        body: sseStream(streamFramesFor(body)),
        text: async () => '',
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(nonStreamJson),
      json: async () => nonStreamJson,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  process.env.MEDEA_LICENSE_KEY = 'lic-key-123';
  delete process.env.MEDEA_LIARA_SINGLESHOT_MAX_TOKENS;
});

afterEach(() => {
  vi.resetModules();
  delete process.env.MEDEA_LICENSE_KEY;
});

const SCHEMA = { type: 'object', properties: { x: { type: 'string' } } };

describe('dispatchLLMChatStructuredStreaming — caratterizzazione wire (Liara)', () => {
  it('body: stream:true + include_usage + no_think + json_schema + temperature 0.1', async () => {
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'SYS',
      'GOAL',
      undefined,
      [],
      SCHEMA,
      () => {
        /* noop */
      },
    );
    const b = captured[0]!.body;
    expect(b.stream).toBe(true);
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.temperature).toBe(0.1);
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(b.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'workflow_scaffold', strict: true, schema: SCHEMA },
    });
    const msgs = b.messages as { role: string; content: string }[];
    expect(msgs[0]?.content).toBe('/no_think\nSYS');
  });

  it("Authorization Bearer = LICENSE KEY (non l'apiKey tenant)", async () => {
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    await dispatchLLMChatStructuredStreaming(
      'liara',
      'TENANT-IGNORED',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      () => {
        /* noop */
      },
    );
    expect(captured[0]!.headers.Authorization).toBe('Bearer lic-key-123');
  });

  it('onChunk per delta in ordine + ritorna accumulato', async () => {
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const chunks: string[] = [];
    const full = await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      (d) => chunks.push(d),
    );
    expect(chunks).toEqual(['hello ', 'world']);
    expect(full).toBe('hello world');
  });

  it('righe SSE spezzate su più read → ricomposte', async () => {
    streamFramesFor = () => {
      const f = deltaFrame('spezzato');
      const mid = Math.floor(f.length / 2);
      return [f.slice(0, mid), f.slice(mid), 'data: [DONE]\n\n'];
    };
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const chunks: string[] = [];
    const full = await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      (d) => chunks.push(d),
    );
    expect(chunks).toEqual(['spezzato']);
    expect(full).toBe('spezzato');
  });

  it('<think>...</think> stripped dal risultato finale (non dai delta)', async () => {
    streamFramesFor = () => [
      deltaFrame('<think>ragiono</think>'),
      deltaFrame('vero'),
      'data: [DONE]\n\n',
    ];
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const chunks: string[] = [];
    const full = await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      (d) => chunks.push(d),
    );
    // i delta arrivano grezzi (UX live), il finale è ripulito
    expect(chunks).toEqual(['<think>ragiono</think>', 'vero']);
    expect(full).toBe('vero');
  });

  it('righe malformate ignorate (stream non si rompe)', async () => {
    streamFramesFor = () => ['data: {non-json\n\n', deltaFrame('ok'), 'data: [DONE]\n\n'];
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const full = await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      () => {
        /* noop */
      },
    );
    expect(full).toBe('ok');
  });

  it('usage dal frame finale → tokenUsageListener fromApi:true', async () => {
    streamFramesFor = () => [
      deltaFrame('abc'),
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const usages: { input: number; output: number; fromApi: boolean }[] = [];
    await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      () => {
        /* noop */
      },
      (u) => usages.push(u),
    );
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ input: 11, output: 7, fromApi: true });
  });

  it('senza usage API → stima locale fromApi:false', async () => {
    streamFramesFor = () => [deltaFrame('abcd'), 'data: [DONE]\n\n'];
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const usages: { fromApi: boolean }[] = [];
    await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      () => {
        /* noop */
      },
      (u) => usages.push(u),
    );
    expect(usages[0]?.fromApi).toBe(false);
  });

  it('callback onChunk che lancia NON rompe lo stream', async () => {
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const full = await dispatchLLMChatStructuredStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      () => {
        throw new Error('boom');
      },
    );
    expect(full).toBe('hello world');
  });
});

describe('dispatchLLMChatStructuredStreaming — non-Liara fallback', () => {
  it('provider openai → non-stream + un solo pseudo-chunk col testo intero', async () => {
    nonStreamJson = { choices: [{ message: { content: 'STRUCT-FALLBACK' } }] };
    const { dispatchLLMChatStructuredStreaming } = await import('./llm-chat.service');
    const chunks: string[] = [];
    const full = await dispatchLLMChatStructuredStreaming(
      'openai',
      'sk-x',
      'gpt-4o',
      'S',
      'G',
      undefined,
      [],
      SCHEMA,
      (d) => chunks.push(d),
    );
    expect(full).toBe('STRUCT-FALLBACK');
    expect(chunks).toEqual(['STRUCT-FALLBACK']);
    // nessuna richiesta stream:true partita
    expect(captured.every((c) => c.body.stream !== true)).toBe(true);
  });
});

describe('dispatchLLMChatStreaming — PLAIN streaming (node-generator)', () => {
  it('Liara: body senza response_format ma stream:true + no_think', async () => {
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    await dispatchLLMChatStreaming('liara', '', '', 'SYS', 'GOAL', undefined, [], () => {
      /* noop */
    });
    const b = captured[0]!.body;
    expect(b.stream).toBe(true);
    expect(b).not.toHaveProperty('response_format');
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    const msgs = b.messages as { role: string; content: string }[];
    expect(msgs[0]?.content).toBe('/no_think\nSYS');
  });

  it('Liara: onChunk in ordine + ritorna accumulato + Bearer license', async () => {
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    const chunks: string[] = [];
    const full = await dispatchLLMChatStreaming('liara', 'IGN', '', 'S', 'G', undefined, [], (d) =>
      chunks.push(d),
    );
    expect(chunks).toEqual(['hello ', 'world']);
    expect(full).toBe('hello world');
    expect(captured[0]!.headers.Authorization).toBe('Bearer lic-key-123');
  });

  it('Liara: usage API → tokenUsageListener fromApi:true', async () => {
    streamFramesFor = () => [
      deltaFrame('z'),
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 9 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    const usages: { input: number; output: number; fromApi: boolean }[] = [];
    await dispatchLLMChatStreaming(
      'liara',
      '',
      '',
      'S',
      'G',
      undefined,
      [],
      () => {
        /* noop */
      },
      (u) => usages.push(u),
    );
    expect(usages[0]).toEqual({ input: 3, output: 9, fromApi: true });
  });

  it('non-Liara (openai) → fallback non-stream dispatchLLMChat + 1 pseudo-chunk', async () => {
    nonStreamJson = { choices: [{ message: { content: 'PLAIN-FALLBACK' } }] };
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    const chunks: string[] = [];
    const full = await dispatchLLMChatStreaming(
      'openai',
      'sk-x',
      'gpt-4o',
      'S',
      'G',
      undefined,
      [],
      (d) => chunks.push(d),
    );
    expect(full).toBe('PLAIN-FALLBACK');
    expect(chunks).toEqual(['PLAIN-FALLBACK']);
    expect(captured.every((c) => c.body.stream !== true)).toBe(true);
  });

  it('Liara disabilitata → throws', async () => {
    vi.doMock('@/config.js', () => ({
      isLiaraEnabled: () => false,
      liaraBaseUrl: () => 'http://x/v1',
    }));
    vi.resetModules();
    const { dispatchLLMChatStreaming } = await import('./llm-chat.service');
    await expect(
      dispatchLLMChatStreaming('liara', '', '', 'S', 'G', undefined, [], () => {
        /* noop */
      }),
    ).rejects.toThrow(/disabilitata/u);
    vi.doUnmock('@/config.js');
  });
});
