import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// NB: la difesa DNS-rebinding NON è più una pre-risoluzione nel SUT (rimossa
// 2026-06-10: faceva DNS reale rallentando/rompendo i test). Ora è il dispatcher
// undici `connect.lookup` (testato in secure-dispatcher.test.ts con server reale)
// + installato come dispatcher globale. Qui mockiamo `fetch` → il dispatcher non
// viene invocato → niente DNS reale, test veloci/deterministici.
import { safeOutboundFetch, safeOutboundFetchOk } from './safe-outbound-fetch.js';
import {
  clearBreakerRegistry,
  NetworkError,
  HttpError,
  TimeoutError,
  CircuitOpenError,
} from '@medea/engine-nodes-stdlib';

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  // `RequestInfo` è un tipo del DOM: qui gira Node, dove la firma di `fetch`
  // la danno i tipi di @types/node. Si prende da lì invece di nominarne uno
  // che in questo ambiente non esiste.
  const spy = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return await handler(url, init);
  });
  (globalThis as { fetch?: typeof fetch }).fetch = spy as never;
  return { calls, spy };
}

beforeEach(() => {
  clearBreakerRegistry();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('safeOutboundFetch', () => {
  it('passa attraverso fetch pulito su URL pubblico', async () => {
    const { calls } = mockFetch(() => new Response('{"ok":true}', { status: 200 }));
    const res = await safeOutboundFetch('https://api.example.com/u');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('SSRF block: 127.0.0.1 throwa NetworkError prima di fetch', async () => {
    const { calls } = mockFetch(() => new Response('should not run'));
    await expect(safeOutboundFetch('http://127.0.0.1:6379/leak')).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(calls).toHaveLength(0); // SSRF guard pre-fetch
  });

  it('SSRF block: cloud metadata IMDS 169.254.169.254 bloccato', async () => {
    const { calls } = mockFetch(() => new Response('iam-creds'));
    await expect(
      safeOutboundFetch('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(0);
  });

  it('allowPrivateHost: true → bypassa SSRF per servizio interno trusted (BGE-M3 :5001)', async () => {
    const { calls } = mockFetch(() => new Response('{"embedding":[]}', { status: 200 }));
    const res = await safeOutboundFetch('http://127.0.0.1:5001/embed', { allowPrivateHost: true });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1); // SSRF saltato → fetch eseguito
  });

  it('allowPrivateHost NON disabilita breaker/timeout (resta protetto)', async () => {
    // host interno down → comunque NetworkError tipizzato (breaker attivo), non hang
    mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      safeOutboundFetch('http://127.0.0.1:5004/analyze', { allowPrivateHost: true }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('allowPrivateHost assente → host privato resta BLOCCATO (default sicuro)', async () => {
    const { calls } = mockFetch(() => new Response('nope'));
    await expect(safeOutboundFetch('http://127.0.0.1:5001/embed')).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(calls).toHaveLength(0);
  });

  it('breaker per-host: 5 failures → CircuitOpenError sulla 6a', async () => {
    mockFetch(() => {
      throw new Error('network down');
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(safeOutboundFetch('https://flaky.com/x')).rejects.toBeInstanceOf(NetworkError);
    }
    await expect(safeOutboundFetch('https://flaky.com/x')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('breaker isolato per-host: down su A non rompe B', async () => {
    const mode: 'fail' | 'ok' = 'fail';
    mockFetch((url) => {
      if (url.includes('bad.com') && mode === 'fail') throw new Error('e');
      return new Response('ok');
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(safeOutboundFetch('https://bad.com/x')).rejects.toThrow();
    }
    // bad.com aperto, good.com ancora ok
    const r = await safeOutboundFetch('https://good.com/x');
    expect(r.status).toBe(200);
  });

  it('timeout: abort dopo timeoutMs → TimeoutError', async () => {
    mockFetch(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          // Non risolve mai — solo abort lo termina
        }),
    );
    await expect(
      safeOutboundFetch('https://slow.example.com/x', { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('timeout 0 = nessun timeout (signal solo da external)', async () => {
    mockFetch(() => new Response('ok'));
    const r = await safeOutboundFetch('https://api.example.com/u', { timeoutMs: 0 });
    expect(r.status).toBe(200);
  });

  it('rispetta externalSignal abort esterno', async () => {
    mockFetch(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const ext = new AbortController();
    setTimeout(() => ext.abort(), 20);
    await expect(
      safeOutboundFetch('https://api.example.com/u', {
        timeoutMs: 5000,
        externalSignal: ext.signal,
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('SSRF-via-redirect: 302 → 127.0.0.1 BLOCCATO (re-validate per hop)', async () => {
    const { calls } = mockFetch((url) => {
      if (url === 'https://evil.com/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:5000/v1/chat' },
        });
      }
      return new Response('leaked-internal', { status: 200 });
    });
    await expect(safeOutboundFetch('https://evil.com/start')).rejects.toBeInstanceOf(NetworkError);
    // primo hop eseguito (pubblico), il Location privato NON viene mai fetchato
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://evil.com/start');
  });

  it('SSRF-via-redirect: 302 → metadata 169.254.169.254 BLOCCATO', async () => {
    mockFetch((url) =>
      url.includes('evil.com')
        ? new Response(null, {
            status: 301,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          })
        : new Response('iam-creds', { status: 200 }),
    );
    await expect(safeOutboundFetch('https://evil.com/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it('redirect verso host pubblico → seguito in sicurezza (safe follow)', async () => {
    const { calls } = mockFetch((url) => {
      if (url === 'https://a.com/start') {
        return new Response(null, { status: 302, headers: { location: 'https://b.com/dest' } });
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    const res = await safeOutboundFetch('https://a.com/start');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://b.com/dest');
  });

  it('redirect cross-host → strip Authorization/Cookie (anti Bearer leak)', async () => {
    const { calls } = mockFetch((url) =>
      url === 'https://a.com/start'
        ? new Response(null, { status: 307, headers: { location: 'https://b.com/dest' } })
        : new Response('ok', { status: 200 }),
    );
    await safeOutboundFetch('https://a.com/start', {
      headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'x-keep': 'yes' },
    });
    const hop2 = new Headers(calls[1]!.init!.headers);
    expect(hop2.get('authorization')).toBeNull();
    expect(hop2.get('cookie')).toBeNull();
    expect(hop2.get('x-keep')).toBe('yes');
  });

  it('redirect:manual esplicito → passthrough invariato (caller possiede gli hop)', async () => {
    const { calls } = mockFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } }),
    );
    const res = await safeOutboundFetch('https://api.example.com/u', { redirect: 'manual' });
    expect(res.status).toBe(302); // 3xx restituito al caller, non seguito
    expect(calls).toHaveLength(1);
  });

  it('redirect-loop oltre max hop → NetworkError', async () => {
    mockFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://loop.com/${Math.random().toString(36).slice(2)}` },
        }),
    );
    await expect(safeOutboundFetch('https://loop.com/start')).rejects.toBeInstanceOf(NetworkError);
  });

  it('propaga method/body/headers al fetch nativo (no contamination con custom field)', async () => {
    const { calls } = mockFetch(() => new Response('{}'));
    await safeOutboundFetch('https://api.example.com/u', {
      method: 'POST',
      body: '{"x":1}',
      headers: { 'X-Foo': 'bar' },
      timeoutMs: 5000,
      spanName: 'custom.span',
    });
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"x":1}');
    expect((init.headers as Record<string, string>)['X-Foo']).toBe('bar');
    // I custom field NON devono finire nell'init nativo
    expect((init as Record<string, unknown>).timeoutMs).toBeUndefined();
    expect((init as Record<string, unknown>).spanName).toBeUndefined();
    expect((init as Record<string, unknown>).externalSignal).toBeUndefined();
  });
});

describe('safeOutboundFetchOk', () => {
  it('200 OK → ritorna response', async () => {
    mockFetch(() => new Response('{}', { status: 200 }));
    const r = await safeOutboundFetchOk('https://api.example.com/u');
    expect(r.status).toBe(200);
  });

  it('404 → HttpError tipizzato con bodyExcerpt', async () => {
    mockFetch(() => new Response('not found here', { status: 404, statusText: 'Not Found' }));
    try {
      await safeOutboundFetchOk('https://api.example.com/u');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      if (err instanceof HttpError) {
        expect(err.status).toBe(404);
        expect(err.context.bodyExcerpt).toBe('not found here');
      }
    }
  });

  it('500 → HttpError + retryable=true (server-side fault)', async () => {
    mockFetch(() => new Response('internal', { status: 500 }));
    try {
      await safeOutboundFetchOk('https://api.example.com/u');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      if (err instanceof HttpError) expect(err.retryable).toBe(true);
    }
  });

  it('429 → HttpError + retryable=true (rate-limit)', async () => {
    mockFetch(() => new Response('slow down', { status: 429 }));
    try {
      await safeOutboundFetchOk('https://api.example.com/u');
    } catch (err) {
      if (err instanceof HttpError) expect(err.retryable).toBe(true);
    }
  });

  it('bodyExcerpt truncato a 500 char (anti-leak credenziali grandi)', async () => {
    const big = 'x'.repeat(2000);
    mockFetch(() => new Response(big, { status: 500 }));
    try {
      await safeOutboundFetchOk('https://api.example.com/u');
    } catch (err) {
      if (err instanceof HttpError) expect((err.context.bodyExcerpt as string).length).toBe(500);
    }
  });

  it('🚨 OOM: body d-errore ENORME in streaming → excerpt CAPPATO (~8KB) + stream cancellato, MAI tutto in RAM', async () => {
    // Vettore reale: upstream non-2xx con body gigante. Excerpt via res.text() lo
    // bufferizzava TUTTO → OOM (poi scartato a 500 char). Deve troncare lo stream.
    const chunk = new Uint8Array(10 * 1024).fill(120); // 10KB
    let reads = 0;
    const cancelSpy = vi.fn(async () => undefined);
    const fakeRes = {
      status: 500,
      statusText: 'Server Error',
      ok: false,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads <= 200 ? { done: false, value: chunk } : { done: true, value: undefined };
          },
          cancel: cancelSpy,
        }),
      } as unknown as ReadableStream,
      text: async () => {
        throw new Error('🚨 body d-errore letto in RAM senza cap (OOM)');
      },
    } as unknown as Response;
    mockFetch(() => fakeRes);
    try {
      await safeOutboundFetchOk('https://api.example.com/u');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
    }
    expect(cancelSpy).toHaveBeenCalledTimes(1); // stream cancellato al cap
    expect(reads).toBeLessThanOrEqual(2); // ~8KB → max 1 chunk da 10KB, NON 200
  });
});

describe('safeOutboundFetch — dispatcher anti-SSRF (Layer unico)', () => {
  it('URL non-trusted → passa il dispatcher SICURO al fetch (connect.lookup anti-rebinding)', async () => {
    const { calls } = mockFetch(() => new Response('{}', { status: 200 }));
    await safeOutboundFetch('https://api.realservice.com/u');
    const init = calls[0]!.init as (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(init?.dispatcher).toBeDefined(); // dispatcher sicuro applicato
  });

  it('allowPrivateHost: true (servizio interno) → dispatcher PERMISSIVO (raggiunge IP privato)', async () => {
    const { calls } = mockFetch(() => new Response('ok', { status: 200 }));
    const res = await safeOutboundFetch('http://127.0.0.1:5001/embed', { allowPrivateHost: true });
    expect(res.status).toBe(200);
    const init = calls[0]!.init as (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(init?.dispatcher).toBeDefined(); // permissivo, scavalca il globale sicuro
  });

  it('il dispatcher sicuro e quello permissivo sono ISTANZE DIVERSE', async () => {
    const a = mockFetch(() => new Response('{}'));
    await safeOutboundFetch('https://public.example.com/x');
    const secureDisp = (a.calls[0]!.init as { dispatcher?: unknown }).dispatcher;
    const b = mockFetch(() => new Response('{}'));
    await safeOutboundFetch('http://127.0.0.1:9/x', { allowPrivateHost: true });
    const permissiveDisp = (b.calls[0]!.init as { dispatcher?: unknown }).dispatcher;
    expect(secureDisp).not.toBe(permissiveDisp);
  });
});
