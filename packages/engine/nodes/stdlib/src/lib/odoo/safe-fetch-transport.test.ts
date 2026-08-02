import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@medea/engine-safe-fetch', () => ({
  assertUrlSafe: vi.fn(),
  safeFetchWithRedirects: vi.fn(),
}));

import { makeSafeFetchOdooTransport } from './safe-fetch-transport.js';

const CAP = 25 * 1024 * 1024; // deve combaciare con ODOO_MAX_RESPONSE_BYTES
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });
beforeEach(() => { vi.clearAllMocks(); });

function mkRes(opts: { headers?: Record<string, string>; text: () => Promise<string> }): Response {
  return { status: 200, headers: new Headers(opts.headers ?? {}), text: opts.text } as unknown as Response;
}
// followRedirects=false → usa fetch() diretto (path testabile senza safeFetchWithRedirects)
const post = (res: Response): Promise<{ status: number; text: string }> => {
  globalThis.fetch = async () => res;
  const t = makeSafeFetchOdooTransport(false);
  return t.post({ url: 'https://odoo.example.com/xmlrpc/2/object', body: '<x/>', headers: {}, timeoutMs: 5000 });
};

describe('🚨 makeSafeFetchOdooTransport — cap anti-OOM (fix 2026-06-17)', () => {
  it('🚨 content-length OLTRE il cap → throw SUBITO, body MAI letto', async () => {
    const text = vi.fn(async () => 'x');
    await expect(post(mkRes({ headers: { 'content-length': String(CAP + 1) }, text })))
      .rejects.toThrow(/troppo grande/i);
    expect(text).not.toHaveBeenCalled(); // niente read → niente OOM
  });

  it('🚨 testo oltre il cap (content-length assente/bugiardo) → throw', async () => {
    const huge = 'a'.repeat(CAP + 10);
    await expect(post(mkRes({ text: async () => huge })))
      .rejects.toThrow(/troppo grande/i);
  });

  it('risposta entro il cap → { status, text } corretto', async () => {
    const r = await post(mkRes({ headers: { 'content-length': '20' }, text: async () => '{"result":42}' }));
    expect(r).toEqual({ status: 200, text: '{"result":42}' });
  });

  it('🔒 content-length assente + testo piccolo → ok (no falso positivo)', async () => {
    const r = await post(mkRes({ text: async () => 'ok' }));
    expect(r.text).toBe('ok');
  });

  it('🚨 OOM REALE: body in STREAMING oltre il cap (content-length assente/bugiardo) → throw MID-download + stream cancellato', async () => {
    // Il path di PRODUZIONE (Response con body-stream): la versione post-hoc faceva
    // res.text() bufferizzando TUTTO il body PRIMA del check → OOM. Ora deve fermarsi
    // durante il download. Mock: chunk da 5MB, cap 25MB → sfora al 6° chunk.
    const chunk = new Uint8Array(5 * 1024 * 1024);
    let reads = 0;
    const cancelSpy = vi.fn(async () => undefined);
    const streamRes = {
      status: 200,
      headers: new Headers(), // niente content-length → il layer-1 NON aiuta
      body: { getReader: () => ({
        read: async () => { reads += 1; return reads <= 1000 ? { done: false, value: chunk } : { done: true, value: undefined }; },
        cancel: cancelSpy,
      }) },
      text: async () => { throw new Error('🚨 post-hoc res.text() = body intero in RAM (OOM)'); },
    } as unknown as Response;
    await expect(post(streamRes)).rejects.toThrow(/troppo grande/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);  // stream cancellato al cap
    expect(reads).toBeLessThanOrEqual(7);          // ~25MB/5MB = 6 chunk, NON 1000
  });
});
