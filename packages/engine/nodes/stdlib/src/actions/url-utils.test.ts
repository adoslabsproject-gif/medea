/**
 * Test bug-bounty — url-utils (action_url). Era SENZA test (gap gate).
 * Copre parse/build/setQuery/removeQuery/encode/decode + encoding corretto +
 * URL non valido → throw chiaro + uso dell'input quando url vuoto.
 */
import { describe, it, expect } from 'vitest';
import { urlNode } from './url-utils.js';

const url = urlNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const out = async (cfg: Record<string, unknown>, input?: unknown) =>
  (await url(cfg, input, ctx)).output as Record<string, unknown>;

describe('action_url', () => {
  it('parse scompone tutte le parti + query come oggetto', async () => {
    const r = await out({ operation: 'parse', url: 'https://api.x.it:8443/v1/o?code=ABC&x=1#frag' });
    expect(r.protocol).toBe('https');
    expect(r.hostname).toBe('api.x.it');
    expect(r.port).toBe('8443');
    expect(r.pathname).toBe('/v1/o');
    expect(r.query).toEqual({ code: 'ABC', x: '1' });
    expect(r.hash).toBe('frag');
  });
  it('🚨 parse URL non valido → throw chiaro', async () => {
    await expect(url({ operation: 'parse', url: 'non-un-url' }, undefined, ctx)).rejects.toThrow(/URL non valido/);
  });
  it('build compone base+path+params con encoding corretto (accenti/spazi)', async () => {
    const r = await out({ operation: 'build', base: 'https://api.x.it', path: 'cerca', params: { q: 'caffè è', page: 2 } });
    expect(String(r.href)).toContain('https://api.x.it/cerca?');
    expect(String(r.href)).toContain('q=caff%C3%A8+%C3%A8');
    expect(String(r.href)).toContain('page=2');
  });
  it('setQuery aggiunge/sovrascrive; removeQuery toglie', async () => {
    const set = await out({ operation: 'setQuery', url: 'https://x.it/?a=1', params: { b: '2', a: '9' } });
    expect(r2q(set.href)).toMatchObject({ a: '9', b: '2' });
    const rem = await out({ operation: 'removeQuery', url: 'https://x.it/?a=1&b=2', params: { a: '' } });
    expect(r2q(rem.href)).toEqual({ b: '2' });
  });
  it('encode/decode round-trip', async () => {
    const enc = await out({ operation: 'encode', url: 'a b&c' });
    expect(enc.result).toBe('a%20b%26c');
    const dec = await out({ operation: 'decode', url: 'a%20b%26c' });
    expect(dec.result).toBe('a b&c');
  });
  it.each(['%', '%ZZ', '%E0%A4%A', 'abc%'])('🚨 decode di percent-encoding malformato "%s" → errore CHIARO (no URIError grezzo)', async (bad) => {
    // MUTATION: senza il try/catch, decodeURIComponent lancia URIError non gestito.
    await expect(url({ operation: 'decode', url: bad }, undefined, ctx)).rejects.toThrow(/percent-encoding non valida/);
  });
  it('usa input quando url vuoto', async () => {
    const r = await out({ operation: 'parse', url: '' }, 'https://y.it/p');
    expect(r.hostname).toBe('y.it');
  });
  it('🚨 operazione sconosciuta → throw', async () => {
    await expect(url({ operation: 'nope', url: 'https://x.it' }, undefined, ctx)).rejects.toThrow(/sconosciuta/);
  });
});

function r2q(href: unknown): Record<string, string> {
  return Object.fromEntries(new URL(String(href)).searchParams);
}
