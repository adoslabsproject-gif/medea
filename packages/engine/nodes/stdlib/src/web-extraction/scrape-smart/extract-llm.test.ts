/**
 * Test reali extract-llm. NO smoke fake.
 * Asseriscono: sanitize HTML, LLM call, parsing, error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractWithLlm, sanitizeHtmlForLlm, extractJsonLoose } from './extract-llm.js';

vi.mock('@flowforge/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flowforge/safe-fetch')>()),
  safeFetchWithRedirects: vi.fn(),
}));

const { safeFetchWithRedirects } = await import('@flowforge/safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('sanitizeHtmlForLlm', () => {
  it('rimuove script tags', () => {
    expect(sanitizeHtmlForLlm('<p>ok</p><script>evil()</script>')).toBe('<p>ok</p>');
  });

  it('rimuove style tags', () => {
    expect(sanitizeHtmlForLlm('<style>.x{}</style><p>ok</p>')).toBe('<p>ok</p>');
  });

  it('rimuove HTML comments', () => {
    expect(sanitizeHtmlForLlm('<!-- secret --><p>ok</p>')).toBe('<p>ok</p>');
  });

  it('rimuove inline event handlers (onclick, onload)', () => {
    expect(sanitizeHtmlForLlm('<a href="x" onclick="evil()">click</a>')).toBe('<a href="x">click</a>');
    expect(sanitizeHtmlForLlm('<img src="x" onload="bad()" alt="">')).toBe('<img src="x" alt="">');
  });

  it('collapse whitespace', () => {
    expect(sanitizeHtmlForLlm('<p>a   b\n\n c</p>')).toBe('<p>a b c</p>');
  });

  it('clamp a 60k chars', () => {
    const huge = '<p>' + 'x'.repeat(100_000) + '</p>';
    const r = sanitizeHtmlForLlm(huge);
    expect(r.length).toBeLessThanOrEqual(60_000);
  });

  it('vuoto → vuoto', () => {
    expect(sanitizeHtmlForLlm('')).toBe('');
  });
});

describe('extractJsonLoose', () => {
  it('JSON puro', () => {
    expect(extractJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('JSON in fence ```json', () => {
    expect(extractJsonLoose('```json\n{"x":2}\n```')).toEqual({ x: 2 });
  });

  it('trailing commas', () => {
    expect(extractJsonLoose('{"a":1,}')).toEqual({ a: 1 });
  });

  it('JSON dentro testo', () => {
    expect(extractJsonLoose('here: {"k":"v"} cheers')).toEqual({ k: 'v' });
  });

  it('vuoto → throw', () => {
    expect(() => extractJsonLoose('')).toThrow(/empty/);
  });

  it('garbage → throw', () => {
    expect(() => extractJsonLoose('no json here at all')).toThrow(/not parseable/);
  });
});

describe('extractWithLlm', () => {
  it('html empty after sanitize → throw', async () => {
    await expect(
      extractWithLlm({ html: '<script>only</script>', prompt: 'p' }),
    ).rejects.toThrow(/html empty/);
  });

  it('happy: sanitize → LLM → parse JSON', async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"title":"OK","price":99}' } }] }),
    } as unknown as Response);

    const r = await extractWithLlm({
      html: '<html><body><h1>Product</h1><span class="price">99</span></body></html>',
      prompt: 'estrai titolo e prezzo',
    });
    expect(r.extracted).toEqual({ title: 'OK', price: 99 });
    expect(r.parseError).toBeNull();
    expect(r.htmlCharsUsed).toBeGreaterThan(0);
  });

  it('LLM ritorna JSON in fence ```json → parsato', async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }),
    } as unknown as Response);

    const r = await extractWithLlm({ html: '<p>x</p>', prompt: 'p' });
    expect(r.extracted).toEqual({ a: 1 });
  });

  it('LLM 500 → throw', async () => {
    mockedFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'srv err' } as unknown as Response);
    await expect(
      extractWithLlm({ html: '<p>x</p>', prompt: 'p' }),
    ).rejects.toThrow(/LLM extract failed: 500/);
  });

  it('LLM ritorna garbage → parseError set, extracted=null', async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'no json sorry' } }] }),
    } as unknown as Response);

    const r = await extractWithLlm({ html: '<p>x</p>', prompt: 'p' });
    expect(r.extracted).toBeNull();
    expect(r.parseError).toContain('not parseable');
  });

  it('apiKey → Authorization header', async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as unknown as Response);

    await extractWithLlm({ html: '<p>x</p>', prompt: 'p', apiKey: 'sk-liara' });
    const headers = (mockedFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer sk-liara');
  });

  it('schema → user prompt include "SCHEMA JSON TARGET"', async () => {
    mockedFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as unknown as Response);

    await extractWithLlm({ html: '<p>x</p>', prompt: 'p', schemaJson: '{"t":"string"}' });
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as { messages: { role: string; content: string }[]; response_format: { type: string } };
    expect(body.messages[1]?.content).toContain('SCHEMA JSON TARGET');
    expect(body.response_format.type).toBe('json_object');
  });
});

// ─── Fase 2 (#14): routing gateway metered + usage ──────────────────────────
describe('extractWithLlm — gateway metered (Fase 2 #14)', () => {
  const GW = 'http://172.20.0.1:3006/api/v1/llm';
  const okBody = (extra: Record<string, unknown> = {}) => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '{"a":1}' } }], ...extra }),
  } as unknown as Response);

  beforeEach(() => {
    vi.stubEnv('FLOWFORGE_LIARA_BASE_URL', GW);
    vi.stubEnv('FLOWFORGE_LICENSE_KEY', 'lic-123');
    vi.stubEnv('FLOWFORGE_LIARA_ENDPOINT', '');
    vi.stubEnv('FLOWFORGE_LIARA_API_KEY', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('🚨 endpoint assente → gateway metered + Bearer license + host esente dal guard', async () => {
    mockedFetch.mockResolvedValue(okBody());
    await extractWithLlm({ html: '<p>x</p>', prompt: 'p' });
    const [url, opts] = mockedFetch.mock.calls[0] as [string, { headers: Record<string, string>; allowedHosts?: string[] }];
    expect(url).toBe(`${GW}/chat/completions`);
    expect(opts.headers.Authorization).toBe('Bearer lic-123');
    expect(opts.allowedHosts).toEqual(['172.20.0.1:3006']);
  });

  it('🚨 sentinella legacy localhost:3003 salvata in config → trattata come NON impostata (gateway)', async () => {
    mockedFetch.mockResolvedValue(okBody());
    const r = await extractWithLlm({ html: '<p>x</p>', prompt: 'p', endpoint: 'http://localhost:3003/v1/chat/completions', model: 'liara-distilled' });
    expect(mockedFetch.mock.calls[0]![0]).toBe(`${GW}/chat/completions`);
    // model sentinella → campo OMESSO → decide il gateway
    const body = JSON.parse((mockedFetch.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;
    expect('model' in body).toBe(false);
    expect(r.provider).toBe('liara');
  });

  it('endpoint BYOK custom → NESSUNA esenzione guard, provider=custom', async () => {
    mockedFetch.mockResolvedValue(okBody());
    const r = await extractWithLlm({ html: '<p>x</p>', prompt: 'p', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-x', model: 'gpt-4o-mini' });
    const [url, opts] = mockedFetch.mock.calls[0] as [string, { allowedHosts?: string[] }];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.allowedHosts).toBeUndefined();
    expect(r.provider).toBe('custom');
  });

  it('usage dalla risposta API → fromApi:true; modelUsed dal campo model della risposta', async () => {
    mockedFetch.mockResolvedValue(okBody({ model: 'liara', usage: { prompt_tokens: 88, completion_tokens: 14 } }));
    const r = await extractWithLlm({ html: '<p>x</p>', prompt: 'p' });
    expect(r.usage).toEqual({ input: 88, output: 14, fromApi: true });
    expect(r.modelUsed).toBe('liara');
  });

  it('risposta senza usage → stima (fromApi:false, numeri finiti > 0)', async () => {
    mockedFetch.mockResolvedValue(okBody());
    const r = await extractWithLlm({ html: '<p>x</p>', prompt: 'p' });
    expect(r.usage.fromApi).toBe(false);
    expect(r.usage.input).toBeGreaterThan(0);
    expect(Number.isFinite(r.usage.output)).toBe(true);
  });
});
