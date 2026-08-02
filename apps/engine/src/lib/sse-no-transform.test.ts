/**
 * Tests per lib/sse-no-transform — SSE wrapper CDN-safe.
 *
 * Invarianti CRITICALI (verificati dai test reali sul prod):
 *  - Headers settati: Cache-Control: no-cache, no-transform + Content-Encoding: identity
 *    (NON sovrascritti — bug originale di Hono streamSSE che li perdeva)
 *  - highWaterMark: 0 → flush IMMEDIATO a ogni enqueue (no buffer accumulation
 *    che causava ERR_HTTP2_PROTOCOL_ERROR su Chrome via Cloudflare)
 *  - writeComment emette righe `:` ignorate dal client SSE per spec
 *  - writeSSE formatta event/id/retry/data con \n\n trailer (RFC 5.2)
 *  - Multi-line data → ogni line con prefix `data:` (RFC compliant)
 *  - Client abort → onAbort handlers chiamati + controller chiuso
 *  - cb throw → onError chiamato; senza onError → controller.error()
 *  - closed=true dopo cb completa → enqueue successivi no-op (no double-close)
 *  - UTF-8 encoding corretto per non-ASCII (emoji, accenti)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { streamSSENoTransform, type SSEStreamSafe } from './sse-no-transform.js';

type FakeCtxHeaders = Record<string, string>;

function makeFakeContext(): {
  ctx: Parameters<typeof streamSSENoTransform>[0];
  headers: FakeCtxHeaders;
  signal: AbortSignal;
  abortController: AbortController;
  capturedBody: Promise<{ stream: ReadableStream<Uint8Array>; status: number }>;
} {
  const headers: FakeCtxHeaders = {};
  const abortController = new AbortController();
  let resolveBody!: (v: { stream: ReadableStream<Uint8Array>; status: number }) => void;
  const capturedBody = new Promise<{ stream: ReadableStream<Uint8Array>; status: number }>((r) => {
    resolveBody = r;
  });

  const ctx = {
    header(name: string, value: string): void {
      headers[name.toLowerCase()] = value;
    },
    body(stream: ReadableStream<Uint8Array>, status: number): Response {
      resolveBody({ stream, status });
      // Per il test ritorniamo una Response fake — il contenuto vero è
      // nel `capturedBody` promise.
      return new Response(stream, { status, headers });
    },
    req: {
      raw: { signal: abortController.signal },
    },
  } as unknown as Parameters<typeof streamSSENoTransform>[0];

  return {
    ctx,
    headers,
    signal: abortController.signal,
    abortController,
    capturedBody,
  };
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc += decoder.decode(value, { stream: true });
    }
    acc += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return acc;
}

async function readChunks(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('streamSSENoTransform — headers CDN-safe', () => {
  it('setta Cache-Control: no-cache, no-transform (NON solo no-cache come Hono streamSSE)', async () => {
    const { ctx, headers, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ event: 'x', data: 'y' });
    });
    await capturedBody;
    expect(headers['cache-control']).toBe('no-cache, no-transform');
  });

  it('setta Content-Encoding: identity (anti CF Brotli)', async () => {
    const { ctx, headers, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async () => {
      /* noop */
    });
    await capturedBody;
    expect(headers['content-encoding']).toBe('identity');
  });

  it('setta Content-Type: text/event-stream', async () => {
    const { ctx, headers, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async () => {
      /* noop */
    });
    await capturedBody;
    expect(headers['content-type']).toBe('text/event-stream');
  });

  it('setta Connection: keep-alive + Transfer-Encoding: chunked + X-Accel-Buffering: no', async () => {
    const { ctx, headers, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async () => {
      /* noop */
    });
    await capturedBody;
    expect(headers.connection).toBe('keep-alive');
    expect(headers['transfer-encoding']).toBe('chunked');
    expect(headers['x-accel-buffering']).toBe('no');
  });

  it('Response ritornata ha status 200', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async () => {
      /* noop */
    });
    const { status } = await capturedBody;
    expect(status).toBe(200);
  });
});

describe('streamSSENoTransform — formato SSE RFC', () => {
  it('writeSSE con event + data → "event: x\\ndata: y\\n\\n"', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ event: 'hello', data: 'world' });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toBe('event: hello\ndata: world\n\n');
  });

  it('writeSSE con id propagato', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ event: 'x', data: 'y', id: '42' });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    // Ordine RFC: event → id → retry → data
    expect(out).toBe('event: x\nid: 42\ndata: y\n\n');
  });

  it('writeSSE con retry propagato (riconnessione client)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ data: 'x', retry: 5000 });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toContain('retry: 5000');
  });

  it('writeSSE multi-line data → ogni line prefissata con "data: " (RFC compliant)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ data: 'line1\nline2\nline3' });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toBe('data: line1\ndata: line2\ndata: line3\n\n');
  });

  it('writeSSE senza event = data-only event (RFC default)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ data: 'unnamed' });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toBe('data: unnamed\n\n');
  });

  it('writeSSE UTF-8 encoding emoji e accenti (no mojibake)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ event: 'è', data: '🚀 città àèìòù' });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toContain('è');
    expect(out).toContain('🚀');
    expect(out).toContain('àèìòù');
  });
});

describe('streamSSENoTransform — writeComment (SSE comments per CF padding)', () => {
  it('writeComment emette riga ":" + testo + \\n\\n (spec SSE)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeComment('hello world');
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toBe(':hello world\n\n');
  });

  it('writeComment multi-line → ogni line prefissata con ":"', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeComment('a\nb\nc');
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out).toBe(':a\n:b\n:c\n\n');
  });

  it('writeComment(" ".repeat(16384)) → 16384 byte payload per CF buffer padding', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeComment(' '.repeat(16_384));
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    // `:` + 16384 spazi + \n\n = 16387 bytes
    expect(out.length).toBe(16_387);
    expect(out.startsWith(':')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(true);
  });
});

describe('streamSSENoTransform — flush immediato (highWaterMark: 0)', () => {
  it('ogni writeSSE produce un chunk separato (no buffer accumulation)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeSSE({ event: 'a', data: '1' });
      await s.writeSSE({ event: 'b', data: '2' });
      await s.writeSSE({ event: 'c', data: '3' });
    });
    const { stream } = await capturedBody;
    const chunks = await readChunks(stream);
    // CRITICAL: con highWaterMark 0 ogni enqueue è un chunk distinto.
    // Se Hono `stream()` accumulasse, vedremmo 1 chunk gigante.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const joined = chunks.join('');
    expect(joined).toContain('event: a\ndata: 1\n\n');
    expect(joined).toContain('event: b\ndata: 2\n\n');
    expect(joined).toContain('event: c\ndata: 3\n\n');
  });

  it('write piccoli (~30 byte ping) NON vengono accumulati', async () => {
    // Regression test del bug originale: ping ~30 byte stavano nel buffer
    // V8 senza essere flushati. Con highWaterMark 0 ogni ping è un chunk.
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      for (let i = 0; i < 5; i++) {
        await s.writeSSE({ event: 'ping', data: String(i) });
      }
    });
    const { stream } = await capturedBody;
    const chunks = await readChunks(stream);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });

  it('padding 16KB + ping piccolo successivo → entrambi nel output', async () => {
    // Scenario reale che causava ERR_HTTP2_PROTOCOL_ERROR:
    // padding 16KB triggerava flush, ping 30B successivo restava bloccato.
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async (s) => {
      await s.writeComment(' '.repeat(16_384));
      await s.writeSSE({ event: 'ping', data: '1' });
    });
    const { stream } = await capturedBody;
    const out = await readAllText(stream);
    expect(out.length).toBeGreaterThan(16_384);
    expect(out).toContain('event: ping\ndata: 1\n\n');
  });
});

describe('streamSSENoTransform — abort signal + cleanup', () => {
  it('client abort → onAbort handlers chiamati', async () => {
    const { ctx, abortController, capturedBody } = makeFakeContext();
    const cleanup = vi.fn();
    let resolveCb!: () => void;
    const cbDone = new Promise<void>((r) => {
      resolveCb = r;
    });

    streamSSENoTransform(ctx, async (s) => {
      s.onAbort(cleanup);
      // Aspetta abort (mai resolve naturalmente)
      await new Promise<void>(() => {
        resolveCb();
      });
    });
    await capturedBody;
    await cbDone;

    // Simula abort del client
    abortController.abort();
    // Lascia tempo agli event listener async
    await new Promise((r) => setTimeout(r, 10));

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('abort handler async errori → swallow (no crash, altri handler eseguiti)', async () => {
    const { ctx, abortController, capturedBody } = makeFakeContext();
    const ok = vi.fn();
    const boom = vi.fn().mockRejectedValue(new Error('cleanup boom'));

    streamSSENoTransform(ctx, async (s) => {
      s.onAbort(boom);
      s.onAbort(ok);
      await new Promise<void>(() => {
        /* noop */
      });
    });
    await capturedBody;

    abortController.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(boom).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
  });

  it('dopo abort, writeSSE è no-op (closed=true)', async () => {
    const { ctx, abortController, capturedBody } = makeFakeContext();
    let sseRef: SSEStreamSafe | null = null;

    streamSSENoTransform(ctx, async (s) => {
      sseRef = s;
      await new Promise<void>(() => {
        /* noop */
      });
    });
    await capturedBody;

    abortController.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(sseRef).not.toBeNull();
    expect(sseRef!.closed).toBe(true);
    // Non deve throw
    await expect(sseRef!.writeSSE({ data: 'after-close' })).resolves.toBeUndefined();
    await expect(sseRef!.writeComment('after-close')).resolves.toBeUndefined();
  });
});

describe('streamSSENoTransform — error handling cb', () => {
  it('cb throw + onError fornito → onError chiamato con error', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    const onError = vi.fn();
    const err = new Error('cb boom');

    streamSSENoTransform(
      ctx,
      async () => {
        throw err;
      },
      onError,
    );
    const { stream } = await capturedBody;
    await readAllText(stream); // drain

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err, expect.any(Object));
  });

  it('cb throw senza onError → controller.error() propaga', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(ctx, async () => {
      throw new Error('unhandled');
    });
    const { stream } = await capturedBody;
    // Reading the stream deve rejectare (controller.error propagato)
    await expect(readAllText(stream)).rejects.toThrow('unhandled');
  });

  it('onError throw → swallow (no crash di server)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    streamSSENoTransform(
      ctx,
      async () => {
        throw new Error('cb-err');
      },
      async () => {
        throw new Error('handler-err');
      },
    );
    const { stream } = await capturedBody;
    // Nessuna eccezione propagata fuori — il finally chiude il controller
    await readAllText(stream);
  });
});

describe('streamSSENoTransform — cleanup post-cb', () => {
  it('cb completa normalmente → stream chiuso (closed=true)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    let sseRef: SSEStreamSafe | null = null;

    streamSSENoTransform(ctx, async (s) => {
      sseRef = s;
      await s.writeSSE({ event: 'done', data: '' });
    });
    const { stream } = await capturedBody;
    await readAllText(stream);

    expect(sseRef!.closed).toBe(true);
  });

  it('write dopo cb completa → no-op (no double-close error)', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    let sseRef: SSEStreamSafe | null = null;

    streamSSENoTransform(ctx, async (s) => {
      sseRef = s;
    });
    const { stream } = await capturedBody;
    await readAllText(stream);

    await expect(sseRef!.writeSSE({ data: 'late' })).resolves.toBeUndefined();
    await expect(sseRef!.writeComment('late')).resolves.toBeUndefined();
  });

  it('consumer cancel (es. response chiusa lato Node) → cb abort handlers chiamati', async () => {
    const { ctx, capturedBody } = makeFakeContext();
    const cleanup = vi.fn();

    streamSSENoTransform(ctx, async (s) => {
      s.onAbort(cleanup);
      await new Promise<void>(() => {
        /* noop */
      }); // mai resolve
    });
    const { stream } = await capturedBody;

    // Cancella il consumer → invoca .cancel() del ReadableStream
    const reader = stream.getReader();
    await reader.cancel('consumer-gone');

    await new Promise((r) => setTimeout(r, 10));
    expect(cleanup).toHaveBeenCalled();
  });
});

describe('streamSSENoTransform — integration scenario reale', () => {
  it('flow dashboard tipico: padding 16KB + hello + 3 ping → tutti chunk distinti', async () => {
    const { ctx, capturedBody } = makeFakeContext();

    streamSSENoTransform(ctx, async (s) => {
      await s.writeComment(' '.repeat(16_384));
      await s.writeSSE({ event: 'hello', data: JSON.stringify({ id: 't-1' }) });
      for (let i = 0; i < 3; i++) {
        await s.writeSSE({ event: 'ping', data: String(i) });
      }
    });

    const { stream } = await capturedBody;
    const out = await readAllText(stream);

    // Padding (16387 byte) + hello (~50) + 3 ping (~25 each)
    expect(out.length).toBeGreaterThan(16_384);
    expect(out).toContain(':');
    expect(out).toContain('event: hello\ndata: {"id":"t-1"}\n\n');
    expect(out).toContain('event: ping\ndata: 0\n\n');
    expect(out).toContain('event: ping\ndata: 1\n\n');
    expect(out).toContain('event: ping\ndata: 2\n\n');
  });
});
