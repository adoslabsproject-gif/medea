import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComfyClient, ComfyError, mimeForFilename, kindForFilename } from './client.js';

/** Costruisce una Response-like minimale per il mock di fetch. */
function res(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  text?: string;
  bytes?: Buffer;
  contentType?: string;
}): Response {
  const status = opts.status ?? (opts.ok === false ? 500 : 200);
  return {
    ok: opts.ok ?? status < 400,
    status,
    text: async () => opts.text ?? JSON.stringify(opts.body ?? {}),
    json: async () => opts.body ?? {},
    arrayBuffer: async () => opts.bytes ?? Buffer.alloc(0),
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? (opts.contentType ?? null) : null),
    },
  } as unknown as Response;
}

describe('ComfyClient — costruttore', () => {
  it('rigetta URL non http', () => {
    expect(() => new ComfyClient('ftp://x')).toThrow(ComfyError);
    expect(() => new ComfyClient('')).toThrow(/non valido/i);
  });
  it('accetta http(s) e normalizza la trailing slash', () => {
    expect(() => new ComfyClient('http://host:8188/')).not.toThrow();
  });
});

describe('ComfyClient.submitPrompt', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('ritorna prompt_id su 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ body: { prompt_id: 'abc' } })));
    const c = new ComfyClient('http://h:8188');
    expect(await c.submitPrompt({}, 'cid')).toBe('abc');
  });

  it('rigetta se node_errors non vuoto', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res({ body: { prompt_id: 'a', node_errors: { '3': 'bad' } } })),
    );
    await expect(new ComfyClient('http://h:8188').submitPrompt({}, 'c')).rejects.toThrow(
      /node_errors/,
    );
  });

  it('rigetta su HTTP non ok col motivo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res({ ok: false, status: 400, text: 'nope' })),
    );
    await expect(new ComfyClient('http://h:8188').submitPrompt({}, 'c')).rejects.toThrow(
      /rifiutato il grafo/,
    );
  });

  it('rigetta su errore di rete con messaggio "non raggiungibile"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(new ComfyClient('http://h:8188').submitPrompt({}, 'c')).rejects.toThrow(
      /non raggiungibile/,
    );
  });

  it('rigetta se manca prompt_id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ body: {} })));
    await expect(new ComfyClient('http://h:8188').submitPrompt({}, 'c')).rejects.toThrow(
      /prompt_id/,
    );
  });
});

describe('ComfyClient.waitForOutputs (polling)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ritorna gli outputs al primo poll utile', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          res({ body: { p1: { outputs: { '9': { images: [{ filename: 'a.png' }] } } } } }),
        ),
    );
    const c = new ComfyClient('http://h:8188');
    const promise = c.waitForOutputs('p1', 5000);
    await vi.advanceTimersByTimeAsync(1100);
    await expect(promise).resolves.toMatchObject({ '9': { images: [{ filename: 'a.png' }] } });
  });

  it('rigetta se lo status del backend è error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          res({ body: { p1: { status: { status_str: 'error', messages: ['boom'] } } } }),
        ),
    );
    const c = new ComfyClient('http://h:8188');
    const promise = c.waitForOutputs('p1', 5000);
    const assertion = expect(promise).rejects.toThrow(/fallita sul backend/);
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  });

  it('va in timeout se non arrivano mai outputs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ body: { p1: {} } })));
    const c = new ComfyClient('http://h:8188');
    const promise = c.waitForOutputs('p1', 2000);
    const assertion = expect(promise).rejects.toThrow(/Timeout/);
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
  });
});

describe('ComfyClient.fetchMedia', () => {
  beforeEach(() => vi.restoreAllMocks());

  it("scarica i byte e usa il content-type dell'header", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res({ bytes: Buffer.from('PNG'), contentType: 'image/png' })),
    );
    const m = await new ComfyClient('http://h:8188').fetchMedia({
      filename: 'a.png',
      subfolder: '',
      type: 'output',
      kind: 'image',
    });
    expect(m.bytes.toString()).toBe('PNG');
    expect(m.mimeType).toBe('image/png');
  });

  it("fallback mime dall'estensione se manca l'header", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ bytes: Buffer.from('x') })));
    const m = await new ComfyClient('http://h:8188').fetchMedia({
      filename: 'clip.mp4',
      subfolder: '',
      type: 'output',
      kind: 'video',
    });
    expect(m.mimeType).toBe('video/mp4');
  });

  it('rigetta su HTTP non ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({ ok: false, status: 404 })));
    await expect(
      new ComfyClient('http://h:8188').fetchMedia({
        filename: 'a.png',
        subfolder: '',
        type: 'output',
        kind: 'image',
      }),
    ).rejects.toThrow(/Download/);
  });
});

describe('helper mime/kind', () => {
  it('mimeForFilename', () => {
    expect(mimeForFilename('a.png')).toBe('image/png');
    expect(mimeForFilename('a.unknown')).toBe('application/octet-stream');
  });
  it('kindForFilename', () => {
    expect(kindForFilename('a.webm')).toBe('video');
    expect(kindForFilename('a.jpg')).toBe('image');
  });
});
