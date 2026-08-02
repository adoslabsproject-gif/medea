import { describe, it, expect, vi } from 'vitest';
import {
  readTextCapped,
  readJsonCapped,
  readTextTruncated,
  readBytesCapped,
  DEFAULT_RESPONSE_CAP_BYTES,
} from './capped-response.js';

/** ReadableStream che emette i chunk dati e poi chiude. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new Uint8Array(Buffer.from(ch, 'utf-8')));
      c.close();
    },
  });
}

/** Response con body-stream reale (percorso di produzione). */
function streamRes(headers: Record<string, string>, ...chunks: string[]): Response {
  return new Response(streamOf(...chunks), { headers });
}

describe('readTextCapped', () => {
  it('content-length dichiarato oltre il cap → throw SUBITO, stream cancellato (zero read)', async () => {
    const cancel = vi.fn(async () => undefined);
    const fakeBody = { cancel } as unknown as ReadableStream<Uint8Array>;
    const res = {
      headers: new Headers({ 'content-length': String(DEFAULT_RESPONSE_CAP_BYTES + 1) }),
      body: fakeBody,
    } as unknown as Response;
    await expect(readTextCapped(res)).rejects.toThrow(/troppo grande/u);
    expect(cancel).toHaveBeenCalledTimes(1); // l'FD viene liberato senza leggere
  });

  it('stream oltre il cap SENZA content-length → throw durante il download', async () => {
    // cap=10 byte, stream ne emette 24 → deve fermarsi e lanciare.
    const res = streamRes({}, 'aaaaaaaaaa', 'bbbbbbbbbbbbbb');
    await expect(readTextCapped(res, 10)).rejects.toThrow(/durante il download/u);
  });

  it('stream sotto il cap → ritorna il testo completo', async () => {
    const res = streamRes({}, 'ciao ', 'mondo');
    await expect(readTextCapped(res, 1024)).resolves.toBe('ciao mondo');
  });

  it('boundary: total === cap (esatto) → OK, non è "oltre"', async () => {
    const res = streamRes({}, '12345'); // 5 byte, cap 5
    await expect(readTextCapped(res, 5)).resolves.toBe('12345');
  });

  it('fallback senza body-stream (mock): sotto cap ok, sopra cap throw', async () => {
    const small = {
      headers: new Headers(),
      body: null,
      text: async () => 'piccolo',
    } as unknown as Response;
    await expect(readTextCapped(small, 1024)).resolves.toBe('piccolo');

    const big = {
      headers: new Headers(),
      body: null,
      text: async () => 'x'.repeat(50),
    } as unknown as Response;
    await expect(readTextCapped(big, 10)).rejects.toThrow(/oltre il limite/u);
  });

  it('cap custom rispettato (non usa il default)', async () => {
    const res = streamRes({}, 'abcdef'); // 6 byte
    await expect(readTextCapped(res, 3)).rejects.toThrow(/durante il download/u);
  });

  it('robustezza: Response-like SENZA headers (mock minimale) → non crasha, usa text()', async () => {
    const res = { body: null, text: async () => 'ok' } as unknown as Response;
    await expect(readTextCapped(res, 1024)).resolves.toBe('ok');
  });

  it('robustezza: Response-like json()-only (mock) → ri-serializza e cappa', async () => {
    const res = {
      headers: new Headers(),
      body: null,
      json: async () => ({ a: 1 }),
    } as unknown as Response;
    await expect(readTextCapped(res, 1024)).resolves.toBe('{"a":1}');
    await expect(readJsonCapped<{ a: number }>(res)).resolves.toEqual({ a: 1 });
  });
});

describe('readJsonCapped', () => {
  it('json valido → parsato', async () => {
    const res = streamRes({}, JSON.stringify({ ok: true, n: 7 }));
    await expect(readJsonCapped<{ ok: boolean; n: number }>(res)).resolves.toEqual({
      ok: true,
      n: 7,
    });
  });

  it('body vuoto (2xx senza payload) → null, NON lancia su JSON.parse', async () => {
    const res = streamRes({});
    await expect(readJsonCapped(res)).resolves.toBeNull();
  });

  it('body solo whitespace → null', async () => {
    const res = streamRes({}, '   \n  ');
    await expect(readJsonCapped(res)).resolves.toBeNull();
  });

  it('json oltre il cap → throw (non parsa nulla)', async () => {
    const huge = JSON.stringify({ blob: 'z'.repeat(200) });
    const res = streamRes({}, huge);
    await expect(readJsonCapped(res, 50)).rejects.toThrow(/troppo grande|durante il download/u);
  });
});

describe('readTextTruncated', () => {
  it('body sotto il limite → testo intero, truncated=false', async () => {
    const res = streamRes({}, 'ciao ', 'mondo');
    await expect(readTextTruncated(res, 1024)).resolves.toEqual({
      text: 'ciao mondo',
      truncated: false,
    });
  });

  it('body oltre il limite → tagliato a maxBytes, truncated=true, NON lancia', async () => {
    const res = streamRes({}, 'aaaaa', 'bbbbb', 'ccccc'); // 15 byte
    const out = await readTextTruncated(res, 7);
    expect(out.text).toBe('aaaaabb'); // primi 7 byte
    expect(out.truncated).toBe(true);
  });

  it('fit ESATTO (total === maxBytes, niente altro dopo) → NON è troncamento', async () => {
    const res = streamRes({}, '12345'); // 5 byte, max 5
    await expect(readTextTruncated(res, 5)).resolves.toEqual({ text: '12345', truncated: false });
  });

  it("fit esatto MA c'è altro dopo → truncated=true", async () => {
    const res = streamRes({}, '12345', 'X'); // 5 + 1
    const out = await readTextTruncated(res, 5);
    expect(out.text).toBe('12345');
    expect(out.truncated).toBe(true);
  });

  it('fallback senza body-stream (mock) → tronca a posteriori', async () => {
    const res = {
      headers: new Headers(),
      body: null,
      text: async () => 'abcdefghij',
    } as unknown as Response;
    await expect(readTextTruncated(res, 4)).resolves.toEqual({ text: 'abcd', truncated: true });
  });
});

describe('readBytesCapped', () => {
  it('sotto cap → Buffer coi byte ESATTI (fedeltà binaria, non utf8-mangled)', async () => {
    const raw = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0xfe]); // byte non-UTF8-validi
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(raw);
          c.close();
        },
      }),
    );
    const buf = await readBytesCapped(res, 1024);
    expect(Buffer.from(raw).equals(buf)).toBe(true);
  });

  it('🚨 content-length dichiarato oltre cap → throw SUBITO (zero read)', async () => {
    const cancel = vi.fn(async () => undefined);
    const res = {
      headers: new Headers({ 'content-length': String(DEFAULT_RESPONSE_CAP_BYTES + 1) }),
      body: { cancel } as unknown as ReadableStream<Uint8Array>,
    } as unknown as Response;
    await expect(readBytesCapped(res)).rejects.toThrow(/troppo grande/u);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('🚨 ATTACCO: stream oltre cap → throw DURANTE il download (no arrayBuffer integrale)', async () => {
    let pulled = 0;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 64 * 1024;
          c.enqueue(new Uint8Array(64 * 1024));
        }, // infinito
      }),
    );
    await expect(readBytesCapped(res, 256 * 1024)).rejects.toThrow(/durante il download/u);
    expect(pulled).toBeLessThan(1024 * 1024); // si è fermato presto, NON ha tirato tutto
  });
});
