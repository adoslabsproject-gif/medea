/**
 * HTTP executor v2.0 — unit tests with stubbed global.fetch.
 *
 * Covers:
 *   • Auth header builders (basic, bearer, apikey-header, custom)
 *   • Body type → Content-Type routing (json, form-urlencoded, multipart, raw-text, binary)
 *   • Query parameters merged into URL
 *   • Pagination modes (page-number, offset-limit, cursor, link-header)
 *   • Retry with exponential backoff on 5xx
 *   • Response format (auto / json / text / binary)
 *   • throwOnError + statusCodeOnly toggles
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpActionNode } from './http.js';
import { defaultIdempotencyStore } from '../core/idempotency.js';
import { clearBreakerRegistry } from '../core/host-circuit-breaker.js';

const executor = httpActionNode.executor!;

const ctx = { tenantId: 't', runId: 'r', workflowId: 'wf', nodeId: 'n' } as unknown as Parameters<typeof executor>[2];

type FetchInit = RequestInit & { url?: string };
interface FetchCall { url: string; init: FetchInit }

function mockFetch(handler: (req: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  // `RequestInfo` è un tipo del DOM: qui gira Node, dove la firma di `fetch`
  // la danno i tipi di @types/node. Si prende da lì invece di nominarne uno
  // che in questo ambiente non esiste.
  const spy = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input).url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return await handler(call);
  });
  globalThis.fetch = spy;
  return { calls, spy };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Isolamento test: clear stato singleton tra test (idempotency store + host breaker registry).
  // Senza questo, POST con stesso runId in test consecutivi hit la cache idempotency,
  // o un breaker aperto da test precedente blocca i fetch del test successivo.
  defaultIdempotencyStore.clear();
  clearBreakerRegistry();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('http executor — auth headers', () => {
  it('basic auth builds the Authorization header', async () => {
    const { calls } = mockFetch(() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await executor({ url: 'https://x.com', method: 'GET', authMode: 'basic', basicUser: 'alice', basicPass: 'hunter2' }, null, ctx);
    const auth = (calls[0]!.init.headers as Headers).get('Authorization');
    expect(auth).toBe(`Basic ${Buffer.from('alice:hunter2').toString('base64')}`);
  });

  it('bearer builds the Authorization header', async () => {
    const { calls } = mockFetch(() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await executor({ url: 'https://x.com', method: 'GET', authMode: 'bearer', bearerToken: 'tok-xyz' }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('Authorization')).toBe('Bearer tok-xyz');
  });

  it('apikey-header writes to the configured header name', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({ url: 'https://x.com', method: 'GET', authMode: 'apikey-header', apiKeyHeaderName: 'X-Auth-Token', apiKeyValue: 'k1' }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('X-Auth-Token')).toBe('k1');
  });

  it('custom writes to a fully custom header', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({ url: 'https://x.com', method: 'GET', authMode: 'custom', customAuthHeaderName: 'X-Foo', customAuthHeaderValue: 'bar' }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('X-Foo')).toBe('bar');
  });
});

describe('http executor — body types', () => {
  it('json sets Content-Type and stringifies the body', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({ url: 'https://x.com', method: 'POST', bodyType: 'json', body: '{"a":1}' }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"a":1}');
  });

  it('form-urlencoded serializes from formFields kv', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({
      url: 'https://x.com',
      method: 'POST',
      bodyType: 'form-urlencoded',
      formFields: JSON.stringify({ user: 'alice', age: 30 }),
    }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.init.body).toBe('user=alice&age=30');
  });

  it('raw-text uses text/plain', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({ url: 'https://x.com', method: 'POST', bodyType: 'raw-text', body: 'hello' }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(calls[0]!.init.body).toBe('hello');
  });

  it('raw-binary-base64 decodes base64 and sets configured content type', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({
      url: 'https://x.com',
      method: 'POST',
      bodyType: 'raw-binary-base64',
      body: Buffer.from('hello pdf').toString('base64'),
      rawBinaryContentType: 'application/pdf',
    }, null, ctx);
    expect((calls[0]!.init.headers as Headers).get('Content-Type')).toBe('application/pdf');
    const buf = calls[0]!.init.body as Buffer;
    expect(buf.toString()).toBe('hello pdf');
  });

  it('none + GET sends no body', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({ url: 'https://x.com', method: 'GET', bodyType: 'none' }, null, ctx);
    expect(calls[0]!.init.body).toBeUndefined();
  });
});

describe('http executor — query parameters', () => {
  it('appends queryParams to the URL', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({
      url: 'https://x.com/api',
      method: 'GET',
      queryParamsJson: JSON.stringify({ q: 'foo bar', limit: 10 }),
    }, null, ctx);
    expect(calls[0]!.url).toBe('https://x.com/api?q=foo+bar&limit=10');
  });

  it('preserves existing query in the URL', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await executor({
      url: 'https://x.com/api?fixed=1',
      method: 'GET',
      queryParamsJson: JSON.stringify({ q: 'x' }),
    }, null, ctx);
    expect(calls[0]!.url).toContain('fixed=1');
    expect(calls[0]!.url).toContain('q=x');
  });
});

describe('http executor — pagination', () => {
  it('page-number walks pages until items < limit', async () => {
    let page = 0;
    const { calls } = mockFetch(() => {
      page += 1;
      const data = page === 1 ? [1, 2, 3] : page === 2 ? [4, 5] : [];
      return new Response(JSON.stringify({ data, page }), { headers: { 'content-type': 'application/json' } });
    });
    const res = await executor({
      url: 'https://x.com/list',
      method: 'GET',
      paginationMode: 'page-number',
      paginationItemsField: 'data',
      paginationPageSize: '3',
      paginationMaxPages: '10',
    }, null, ctx);
    expect(calls.length).toBe(2); // stops because 2nd page has fewer than 3 items
    const out = res.output as { body: number[]; pagesFetched: number };
    expect(out.body).toEqual([1, 2, 3, 4, 5]);
    expect(out.pagesFetched).toBe(2);
  });

  it('cursor follows next_cursor until empty', async () => {
    const seq = [
      { items: ['a', 'b'], next_cursor: 'c1' },
      { items: ['c'], next_cursor: 'c2' },
      { items: ['d'], next_cursor: '' },
    ];
    let i = 0;
    const { calls } = mockFetch(() => new Response(JSON.stringify(seq[i++]!), { headers: { 'content-type': 'application/json' } }));
    const res = await executor({
      url: 'https://x.com/list',
      method: 'GET',
      paginationMode: 'cursor',
      paginationItemsField: 'items',
      paginationCursorField: 'next_cursor',
      paginationMaxPages: '10',
    }, null, ctx);
    expect(calls.length).toBe(3);
    const out = res.output as { body: string[] };
    expect(out.body).toEqual(['a', 'b', 'c', 'd']);
  });

  it('link-header follows rel="next" until absent', async () => {
    const seq = [
      { url: 'https://x.com/list?page=1', link: '<https://x.com/list?page=2>; rel="next"', body: [1] },
      { url: 'https://x.com/list?page=2', link: '<https://x.com/list?page=3>; rel="next"', body: [2] },
      { url: 'https://x.com/list?page=3', link: '', body: [3] },
    ];
    let i = 0;
    mockFetch(() => {
      const item = seq[i++]!;
      return new Response(JSON.stringify(item.body), {
        headers: { 'content-type': 'application/json', link: item.link },
      });
    });
    const res = await executor({
      url: 'https://x.com/list?page=1',
      method: 'GET',
      paginationMode: 'link-header',
      paginationMaxPages: '10',
    }, null, ctx);
    const out = res.output as { body: number[] };
    expect(out.body).toEqual([1, 2, 3]);
  });

  it('max pages caps the loop', async () => {
    const { calls } = mockFetch(() => new Response(JSON.stringify({ data: [1, 2, 3] }), { headers: { 'content-type': 'application/json' } }));
    await executor({
      url: 'https://x.com/list',
      method: 'GET',
      paginationMode: 'page-number',
      paginationItemsField: 'data',
      paginationPageSize: '3',
      paginationMaxPages: '2',
    }, null, ctx);
    expect(calls.length).toBe(2);
  });
});

describe('http executor — retry with backoff', () => {
  it('retries on 503 then succeeds', async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      if (attempt < 3) return new Response('busy', { status: 503 });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const promise = executor({
      url: 'https://x.com',
      method: 'GET',
      retryCount: '5',
      retryInitialDelayMs: '10',
      retryBackoffFactor: '2',
      retryOnStatus: '503',
    }, null, ctx);
    // advance through the retry delays
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(attempt).toBe(3);
    expect((res.output as { status: number }).status).toBe(200);
  });

  it('gives up after retryCount exhausted', async () => {
    mockFetch(() => new Response('still busy', { status: 503 }));
    // Attach catch immediately so the rejection isn't flagged as unhandled
    // when the inner fake-timer advance schedules the throw.
    const captured = executor({
      url: 'https://x.com',
      method: 'GET',
      retryCount: '2',
      retryInitialDelayMs: '10',
      retryOnStatus: '503',
      throwOnError: 'true',
    }, null, ctx).then((v) => ({ ok: true as const, value: v }), (e: unknown) => ({ ok: false as const, error: e }));
    await vi.runAllTimersAsync();
    const result = await captured;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(String(result.error)).toMatch(/503/u);
    }
  });
});

describe('http executor — response format', () => {
  it('auto detects JSON from Content-Type', async () => {
    mockFetch(() => new Response('{"k":"v"}', { headers: { 'content-type': 'application/json' } }));
    const res = await executor({ url: 'https://x.com', method: 'GET', responseFormat: 'auto' }, null, ctx);
    expect((res.output as { body: unknown }).body).toEqual({ k: 'v' });
  });

  it('text returns string verbatim', async () => {
    mockFetch(() => new Response('hello', { headers: { 'content-type': 'text/plain' } }));
    const res = await executor({ url: 'https://x.com', method: 'GET', responseFormat: 'text' }, null, ctx);
    expect((res.output as { body: unknown }).body).toBe('hello');
  });

  it('binary → handle BinaryData (ref-primario; senza store = inline base64)', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    mockFetch(() => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
    const res = await executor({ url: 'https://x.com', method: 'GET', responseFormat: 'binary' }, null, ctx);
    const body = (res.output as { body: { __ffBinary?: boolean; data?: string } }).body;
    expect(body.__ffBinary).toBe(true); // non più stringa base64
    expect(Buffer.from(body.data ?? '', 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('http executor — toggles', () => {
  it('throwOnError throws on 4xx when enabled', async () => {
    mockFetch(() => new Response('bad', { status: 400 }));
    await expect(executor({ url: 'https://x.com', method: 'GET', throwOnError: 'true' }, null, ctx))
      .rejects.toThrow(/400/u);
  });

  it('throwOnError off returns the error body', async () => {
    mockFetch(() => new Response('bad', { status: 400 }));
    const res = await executor({ url: 'https://x.com', method: 'GET', throwOnError: 'false' }, null, ctx);
    expect((res.output as { status: number }).status).toBe(400);
  });

  it('statusCodeOnly omits body', async () => {
    mockFetch(() => new Response('{"big":"payload"}', { headers: { 'content-type': 'application/json' } }));
    const res = await executor({ url: 'https://x.com', method: 'GET', statusCodeOnly: 'true' }, null, ctx);
    const out = res.output as Record<string, unknown>;
    expect(out.status).toBe(200);
    expect(out.body).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// #201 P0-2: allowSelfSigned NON setta NODE_TLS_REJECT_UNAUTHORIZED=0
// (process-wide TLS bypass eliminato per safety).
// ════════════════════════════════════════════════════════════════════
describe('#201 P0-2 — allowSelfSigned è fail-secure (no NODE_TLS_REJECT_UNAUTHORIZED=0)', () => {
  it('allowSelfSigned=true NON tocca process.env.NODE_TLS_REJECT_UNAUTHORIZED', async () => {
    const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    mockFetch(() => new Response('ok'));
    await executor(
      { url: 'https://x.com', method: 'GET', allowSelfSigned: 'true' },
      null,
      ctx,
    );
    // CRITICAL: variabile process-wide MAI settata a '0'.
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0');
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
  });

  it('allowSelfSigned ignorato: la fetch parte comunque verso URL valido', async () => {
    const { calls } = mockFetch(() => new Response('ok'));
    await executor(
      { url: 'https://safe.example.com', method: 'GET', allowSelfSigned: 'true' },
      null,
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://safe.example.com');
  });
});

// ════════════════════════════════════════════════════════════════════
// #202 P0-3: SSRF guard + manual redirect re-validate.
// ════════════════════════════════════════════════════════════════════
describe('#202 P0-3 — SSRF guard blocca IP privati + scheme non-http', () => {
  it('blocca scheme file:// → throw SsrfBlockedError prima della fetch', async () => {
    const { calls } = mockFetch(() => new Response('ok'));
    await expect(
      executor({ url: 'file:///etc/passwd', method: 'GET' }, null, ctx),
    ).rejects.toThrow(/SSRF blocked/i);
    expect(calls).toHaveLength(0);
  });

  it('blocca IP loopback 127.0.0.1 → throw', async () => {
    const { calls } = mockFetch(() => new Response('ok'));
    await expect(
      executor({ url: 'http://127.0.0.1:8080/admin', method: 'GET' }, null, ctx),
    ).rejects.toThrow(/SSRF blocked.*LOOPBACK/i);
    expect(calls).toHaveLength(0);
  });

  it('blocca IMDS link-local 169.254.169.254 → throw', async () => {
    const { calls } = mockFetch(() => new Response('ok'));
    await expect(
      executor({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' }, null, ctx),
    ).rejects.toThrow(/SSRF blocked.*LINK_LOCAL/i);
    expect(calls).toHaveLength(0);
  });

  it('blocca host obfuscated `0177.0.0.1` (octal 127.0.0.1) → throw', async () => {
    await expect(
      executor({ url: 'http://0177.0.0.1/', method: 'GET' }, null, ctx),
    ).rejects.toThrow(/SSRF blocked/i);
  });

  it('blocca *.flowforge-net (Docker internal) → throw', async () => {
    await expect(
      executor({ url: 'http://tenant-abc.flowforge-net:3100/api/v1/admin', method: 'GET' }, null, ctx),
    ).rejects.toThrow(/SSRF blocked/i);
  });

  it('URL pubblica (example.com) passa il guard', async () => {
    const { calls } = mockFetch(() => new Response('ok'));
    await executor({ url: 'https://example.com/api', method: 'GET' }, null, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.com/api');
  });

  it('manual redirect: 302 → URL privata viene bloccata al hop successivo', async () => {
    let hopCount = 0;
    const { calls } = mockFetch(() => {
      hopCount += 1;
      if (hopCount === 1) {
        // Server malicious risponde 302 → IP privato (loopback admin panel)
        return new Response('', {
          status: 302,
          headers: { location: 'http://10.0.0.1/secret' },
        });
      }
      // Hop 2 NON deve mai arrivare (guard blocca prima).
      return new Response('SHOULD NEVER REACH');
    });

    await expect(
      executor({ url: 'https://attacker.example.com', method: 'GET' }, null, ctx),
    ).rejects.toThrow(/redirect bloccato/i);
    // CRITICAL: solo 1 fetch (la prima — l'hop verso 10.0.0.1 NON parte).
    expect(calls).toHaveLength(1);
  });

  it('manual redirect: 302 → URL pubblica viene seguita normalmente', async () => {
    let hopCount = 0;
    const { calls } = mockFetch(() => {
      hopCount += 1;
      if (hopCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://final.example.com/' },
        });
      }
      return new Response('final content', { status: 200 });
    });
    const res = await executor({ url: 'https://entry.example.com', method: 'GET' }, null, ctx);
    expect((res.output as { status: number }).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://final.example.com/');
  });

  it('limite MAX_REDIRECTS (5): chain infinita → stop, no DoS', async () => {
    // Setup: ogni redirect punta a un URL pubblico diverso (no SSRF block).
    let hopCount = 0;
    const { calls } = mockFetch(() => {
      hopCount += 1;
      return new Response('', {
        status: 302,
        headers: { location: `https://example.com/page${String(hopCount)}` },
      });
    });
    const res = await executor({ url: 'https://example.com/start', method: 'GET' }, null, ctx);
    // Dopo 5 redirect, ritorna la 302 finale (no follow extra).
    expect((res.output as { status: number }).status).toBe(302);
    // Max 6 fetch (initial + 5 hops).
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});
