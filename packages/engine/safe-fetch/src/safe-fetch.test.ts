/**
 * Tests `safeFetchWithRedirects` — N20 audit (LLM-driven SSRF).
 *
 * Coverage:
 *  • SSRF pre-flight: URL iniziale privata → throw senza fetch
 *  • Manual redirect: 302 → Location pubblica → 2° fetch chiamato con URL re-validato
 *  • Redirect bloccato: 302 → Location IP privato (metadata IMDS) → throw
 *  • Auth strip cross-host: Authorization rimosso al 2° fetch su host diverso
 *  • Auth NON strip same-host: stesso host → header preservato
 *  • Max redirects cap: oltre soglia → throw
 *  • Timeout: signal abort propagato
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { safeFetchWithRedirects } from './safe-fetch.js';

const origFetch = globalThis.fetch;

function mockResponse(status: number, headers: Record<string, string> = {}, body = ''): Response {
  return new Response(body, { status, headers });
}

describe('safeFetchWithRedirects — SSRF pre-flight', () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn().mockResolvedValue(mockResponse(200, {}, 'ok'));
    // @ts-expect-error test mock
    globalThis.fetch = spy;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('SECURITY: pre-flight blocca loopback senza fare fetch', async () => {
    await expect(safeFetchWithRedirects('http://127.0.0.1')).rejects.toThrow(/SSRF blocked/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('SECURITY: pre-flight blocca IMDS 169.254.169.254 (cloud metadata)', async () => {
    await expect(
      safeFetchWithRedirects('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
    ).rejects.toThrow(/SSRF blocked/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('SECURITY: pre-flight blocca scheme file://', async () => {
    await expect(safeFetchWithRedirects('file:///etc/passwd')).rejects.toThrow(/SSRF blocked/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('SECURITY: pre-flight blocca metadata.google.internal', async () => {
    await expect(safeFetchWithRedirects('http://metadata.google.internal/')).rejects.toThrow(/SSRF blocked/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('URL pubblica → fetch chiamato', async () => {
    const res = await safeFetchWithRedirects('https://example.com/path');
    expect(spy).toHaveBeenCalledOnce();
    expect(await res.text()).toBe('ok');
  });
});

describe('safeFetchWithRedirects — manual redirect + SSRF re-validate', () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn();
    // @ts-expect-error mock
    globalThis.fetch = spy;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('302 → Location pubblica → 2 fetch + final 200', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: 'https://other-public.com/page' }))
      .mockResolvedValueOnce(mockResponse(200, {}, 'final'));
    const res = await safeFetchWithRedirects('https://example.com/');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await res.text()).toBe('final');
  });

  it('SECURITY: 302 → Location http://169.254.169.254/ (IMDS) → throw senza 2° fetch', async () => {
    spy.mockResolvedValueOnce(mockResponse(302, { location: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(safeFetchWithRedirects('https://example-blog.com/')).rejects.toThrow(/redirect bloccato/);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('SECURITY: 302 → Location http://127.0.0.1/internal-api → throw', async () => {
    spy.mockResolvedValueOnce(mockResponse(302, { location: 'http://127.0.0.1/api/secret' }));
    await expect(safeFetchWithRedirects('https://example.com/')).rejects.toThrow(/redirect bloccato/);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('SECURITY: 302 → Location file:/// → throw', async () => {
    spy.mockResolvedValueOnce(mockResponse(302, { location: 'file:///etc/passwd' }));
    await expect(safeFetchWithRedirects('https://example.com/')).rejects.toThrow(/redirect bloccato/);
  });

  it('REGRESSION: 3xx senza Location header → restituita verbatim (no follow)', async () => {
    // Node Response constructor non accetta 304 (null body status). Uso 300
    // Multiple Choices senza Location — il loop dovrebbe restituirla verbatim.
    spy.mockResolvedValueOnce(mockResponse(300, {}, 'no location'));
    const res = await safeFetchWithRedirects('https://example.com/');
    expect(spy).toHaveBeenCalledOnce();
    expect(res.status).toBe(300);
  });

  it('REGRESSION: Location relativa risolta rispetto a currentUrl', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: '/page2' }))
      .mockResolvedValueOnce(mockResponse(200, {}, 'page2'));
    await safeFetchWithRedirects('https://example.com/page1');
    expect(spy).toHaveBeenNthCalledWith(2, 'https://example.com/page2', expect.anything());
  });

  it('SECURITY: max 5 redirect → 6 hops → throw', async () => {
    for (let i = 0; i < 6; i += 1) {
      spy.mockResolvedValueOnce(mockResponse(302, { location: `https://hop-${String(i + 1)}.example.com/` }));
    }
    await expect(safeFetchWithRedirects('https://example.com/')).rejects.toThrow(/too many redirects/);
  });

  it('maxRedirects override 0 → no follow even su 302', async () => {
    spy.mockResolvedValueOnce(mockResponse(302, { location: 'https://other.com/' }));
    await expect(safeFetchWithRedirects('https://example.com/', { maxRedirects: 0 })).rejects.toThrow(/too many redirects/);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('safeFetchWithRedirects — cross-host auth strip (anti-Bearer-leak)', () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn();
    // @ts-expect-error mock
    globalThis.fetch = spy;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('SECURITY: cross-host redirect → Authorization rimosso al 2° fetch', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: 'https://attacker.com/exfil' }))
      .mockResolvedValueOnce(mockResponse(200, {}, 'leaked'));
    await safeFetchWithRedirects('https://api.example.com/', {
      headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' },
    });
    const secondCallHeaders = spy.mock.calls[1]![1].headers as Record<string, string>;
    expect(secondCallHeaders.Authorization).toBeUndefined();
    expect(secondCallHeaders['Content-Type']).toBe('application/json');
  });

  it('SECURITY: cross-host → Cookie rimosso (SameSite-like enforcement)', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: 'https://attacker.com/exfil' }))
      .mockResolvedValueOnce(mockResponse(200, {}, ''));
    await safeFetchWithRedirects('https://api.example.com/', {
      headers: { Cookie: 'session=abc123', 'X-Custom': 'kept' },
    });
    const secondHeaders = spy.mock.calls[1]![1].headers as Record<string, string>;
    expect(secondHeaders.Cookie).toBeUndefined();
    expect(secondHeaders['X-Custom']).toBe('kept');
  });

  it('SECURITY: lower-case authorization header anche rimosso (case-insensitive)', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: 'https://attacker.com/' }))
      .mockResolvedValueOnce(mockResponse(200, {}, ''));
    await safeFetchWithRedirects('https://api.example.com/', {
      headers: { authorization: 'Bearer x' },
    });
    const secondHeaders = spy.mock.calls[1]![1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBeUndefined();
  });

  it('REGRESSION: same-host redirect → Authorization PRESERVATO', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: 'https://api.example.com/v2/path' }))
      .mockResolvedValueOnce(mockResponse(200, {}, 'ok'));
    await safeFetchWithRedirects('https://api.example.com/v1/path', {
      headers: { Authorization: 'Bearer secret' },
    });
    const secondHeaders = spy.mock.calls[1]![1].headers as Record<string, string>;
    expect(secondHeaders.Authorization).toBe('Bearer secret');
  });

  it('SECURITY: Proxy-Authorization rimosso cross-host', async () => {
    spy
      .mockResolvedValueOnce(mockResponse(302, { location: 'https://attacker.com/' }))
      .mockResolvedValueOnce(mockResponse(200, {}, ''));
    await safeFetchWithRedirects('https://api.example.com/', {
      headers: { 'Proxy-Authorization': 'Basic xyz' },
    });
    const secondHeaders = spy.mock.calls[1]![1].headers as Record<string, string>;
    expect(secondHeaders['Proxy-Authorization']).toBeUndefined();
  });
});

describe('safeFetchWithRedirects — request shape', () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    spy = vi.fn().mockResolvedValue(mockResponse(200, {}, 'ok'));
    // @ts-expect-error mock
    globalThis.fetch = spy;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('passa method, headers, body al fetch underlying', async () => {
    await safeFetchWithRedirects('https://example.com/', {
      method: 'POST',
      headers: { 'X-Test': 'yes' },
      body: '{"a":1}',
    });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['X-Test']).toBe('yes');
  });

  it('REGRESSION: redirect: "manual" FORZATO (no automatic follow)', async () => {
    await safeFetchWithRedirects('https://example.com/');
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('REGRESSION: AbortSignal.timeout impostato (no hang indefinito)', async () => {
    await safeFetchWithRedirects('https://example.com/', { timeoutMs: 5000 });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
  });
});
