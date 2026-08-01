/**
 * CONTRACT — anti-OOM STRUTTURALE del chokepoint.
 *
 * `safeFetchWithRedirects` è l'unico punto da cui passa ogni fetch esterno
 * (executor, nodi, integrazioni, codice futuro). La Response che ritorna DEVE
 * cappare il body di per sé: `.json()/.text()/.arrayBuffer()/.blob()` non
 * possono bufferizzare oltre il limite, altrimenti un endpoint enorme/compromesso
 * fa OOM del container tenant. Questo test blinda quella garanzia: se qualcuno
 * rimuove `withCappedBody` o ne rompe la delega, qui diventa rosso.
 *
 * Niente rete reale: si stubba `globalThis.fetch` con una Response vera costruita
 * da uno stream (così il cap streaming è esercitato davvero, non solo il fallback).
 *
 * @module capped-body.contract
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchWithRedirects } from './safe-fetch.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

/** Response reale con body = stream di `size` byte (un chunk da 64KB ripetuto). */
function hugeResponse(size: number, headers: Record<string, string> = {}): Response {
  const CHUNK = 64 * 1024;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) { controller.close(); return; }
      const n = Math.min(CHUNK, size - sent);
      controller.enqueue(new Uint8Array(n).fill(65)); // 'A'
      sent += n;
    },
  });
  return new Response(stream, { status: 200, headers });
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('🚨 contract — safeFetchWithRedirects cappa il body PER COSTRUZIONE', () => {
  it('🚨 .text() oltre il cap → RangeError (non bufferizza tutto)', async () => {
    globalThis.fetch = vi.fn(async () => hugeResponse(2 * 1024 * 1024));
    const res = await safeFetchWithRedirects('https://example.com/big', { maxResponseBytes: 512 * 1024 });
    await expect(res.text()).rejects.toThrow(RangeError);
  });

  it('🚨 .json() oltre il cap → RangeError', async () => {
    globalThis.fetch = vi.fn(async () => hugeResponse(2 * 1024 * 1024));
    const res = await safeFetchWithRedirects('https://example.com/big', { maxResponseBytes: 256 * 1024 });
    await expect(res.json()).rejects.toThrow(RangeError);
  });

  it('🚨 .arrayBuffer() oltre il cap → RangeError', async () => {
    globalThis.fetch = vi.fn(async () => hugeResponse(2 * 1024 * 1024));
    const res = await safeFetchWithRedirects('https://example.com/big', { maxResponseBytes: 128 * 1024 });
    await expect(res.arrayBuffer()).rejects.toThrow(RangeError);
  });

  it('body sotto il cap → letto regolarmente (.json funziona)', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true, n: 42 }));
    const res = await safeFetchWithRedirects('https://example.com/small');
    expect(await res.json()).toEqual({ ok: true, n: 42 });
  });

  it('delega i metadati alla Response reale (ok/status/headers/url) — niente Illegal invocation', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ a: 1 }));
    const res = await safeFetchWithRedirects('https://example.com/x');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('maxResponseBytes più alto → un body grande passa (download dedicati)', async () => {
    globalThis.fetch = vi.fn(async () => hugeResponse(1024 * 1024));
    const res = await safeFetchWithRedirects('https://example.com/asset', { maxResponseBytes: 4 * 1024 * 1024 });
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(1024 * 1024);
  });
});
