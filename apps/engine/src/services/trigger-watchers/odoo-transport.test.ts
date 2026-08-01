/**
 * Bug-bounty — trigger-watchers/odoo-transport.
 *
 * Il transport era PRIVATO e senza alcun test nel monolite. Qui ne pinniamo le
 * invarianti critiche: passthrough di metodo/headers/body, ritorno status+text,
 * timeout che aborta il fetch, propagazione dell'abort esterno, e cleanup
 * deterministico (nessun timer/listener orfano dopo successo).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeOdooHttpTransport } from './odoo-transport.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** fetch mock: risolve subito con la risposta data; opzionalmente registra le init. */
function stubFetchOk(status: number, text: string, capture?: (url: string, init: RequestInit) => void): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(text, { status });
  }));
}

/** fetch mock: NON risolve mai da solo; rigetta SOLO quando il suo signal aborta. */
function stubFetchAbortable(): void {
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const sig = init.signal;
    if (sig?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    sig?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  })));
}

describe('makeOdooHttpTransport.post', () => {
  it('🚨 OOM: risposta Odoo ENORME in streaming → cap (throw) + stream cancellato, MAI tutta in RAM', async () => {
    // Il transport del NODO odoo era cappato, questo del TRIGGER no → stesso rischio.
    const chunk = new Uint8Array(5 * 1024 * 1024); // 5MB; cap 25MB → sfora al 6°
    let reads = 0;
    const cancelSpy = vi.fn(async () => undefined);
    const hugeRes = {
      status: 200, headers: new Headers(),
      body: { getReader: () => ({
        read: async () => { reads += 1; return reads <= 1000 ? { done: false, value: chunk } : { done: true, value: undefined }; },
        cancel: cancelSpy,
      }) },
      text: async () => { throw new Error('🚨 res.text() = body intero in RAM (OOM)'); },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => hugeRes));
    const t = makeOdooHttpTransport();
    await expect(t.post({ url: 'https://odoo.test/x', body: '<x/>', headers: {}, timeoutMs: 5000 }))
      .rejects.toThrow(/troppo grande/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(reads).toBeLessThanOrEqual(7); // ~25MB/5MB, NON 1000
  });

  it('passthrough method/headers/body + ritorna { status, text }', async () => {
    let seenUrl = ''; let seenInit: RequestInit = {};
    stubFetchOk(200, '<xml>ok</xml>', (u, i) => { seenUrl = u; seenInit = i; });
    const t = makeOdooHttpTransport();
    const res = await t.post({
      url: 'https://odoo.test/xmlrpc/2/object',
      body: '<methodCall/>',
      headers: { 'Content-Type': 'text/xml', 'X-Trace': 'a' },
      timeoutMs: 5000,
    });
    expect(res).toEqual({ status: 200, text: '<xml>ok</xml>' });
    expect(seenUrl).toBe('https://odoo.test/xmlrpc/2/object');
    expect(seenInit.method).toBe('POST');
    expect(seenInit.body).toBe('<methodCall/>');
    expect((seenInit.headers as Record<string, string>)['Content-Type']).toBe('text/xml');
    expect((seenInit.headers as Record<string, string>)['X-Trace']).toBe('a');
  });

  it('🚨 headers è una COPIA (spread) — mutare l\'input dopo non altera la request', async () => {
    let seenInit: RequestInit = {};
    stubFetchOk(200, 'x', (_u, i) => { seenInit = i; });
    const headers = { 'X-Token': 'secret' };
    await makeOdooHttpTransport().post({ url: 'https://odoo.test', body: '', headers, timeoutMs: 5000 });
    expect((seenInit.headers as Record<string, string>)['X-Token']).toBe('secret');
    expect(seenInit.headers).not.toBe(headers); // copia, non riferimento
  });

  it('🚨 ritorna lo status non-2xx senza lanciare (il chiamante decide)', async () => {
    stubFetchOk(500, '<fault/>');
    const res = await makeOdooHttpTransport().post({ url: 'https://odoo.test', body: '', headers: {}, timeoutMs: 5000 });
    expect(res.status).toBe(500);
    expect(res.text).toBe('<fault/>');
  });

  it('🚨 TIMEOUT: se il fetch non risolve entro timeoutMs → abort → post rigetta', async () => {
    stubFetchAbortable();
    await expect(
      makeOdooHttpTransport().post({ url: 'https://odoo.test', body: '', headers: {}, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('🚨 SIGNAL esterno GIÀ abortato → fetch riceve un signal abortato → rigetta subito', async () => {
    stubFetchAbortable();
    const res = makeOdooHttpTransport().post({
      url: 'https://odoo.test', body: '', headers: {}, timeoutMs: 5000,
      signal: AbortSignal.abort(),
    });
    await expect(res).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('🚨 SIGNAL esterno abortato DURANTE il volo → propaga l\'abort al fetch', async () => {
    stubFetchAbortable();
    const ext = new AbortController();
    const p = makeOdooHttpTransport().post({
      url: 'https://odoo.test', body: '', headers: {}, timeoutMs: 5000, signal: ext.signal,
    });
    ext.abort(); // teardown del poller mentre la richiesta è in volo
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('🚨 CLEANUP: dopo successo, il listener sul signal esterno è rimosso (no leak)', async () => {
    stubFetchOk(200, 'ok');
    const ext = new AbortController();
    const remove = vi.spyOn(ext.signal, 'removeEventListener');
    await makeOdooHttpTransport().post({ url: 'https://odoo.test', body: '', headers: {}, timeoutMs: 5000, signal: ext.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    // e abortare DOPO il completamento non deve avere effetti (listener già rimosso)
    expect(() => ext.abort()).not.toThrow();
  });
});
