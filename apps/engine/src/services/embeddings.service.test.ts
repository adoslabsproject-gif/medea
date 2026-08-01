/**
 * Test 2026-grade — Embeddings switchboard (OpenAI/Voyage/Ollama).
 *
 * SECURITY: API key required for paid providers; SSRF-safe (allowPrivateHost ollama only).
 * SAFE: empty text → zero vector (no API call wasted).
 * RATE-LIMIT FRIENDLY: embedBatch serial (no Promise.all storm).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { at } from '@/__testkit__/assert.js';

const safeFetchMock = vi.fn();
vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));

const { embedText, embedBatch, dimensionsForModel } = await import('./embeddings.service.js');

beforeEach(() => { vi.clearAllMocks(); });

describe('🚨 dimensionsForModel', () => {
  it.each([
    ['text-embedding-3-small', 1536],
    ['text-embedding-3-large', 3072],
    ['text-embedding-ada-002', 1536],
    ['voyage-3', 1024],
    ['voyage-3-lite', 512],
    ['voyage-large-2', 1536],
    ['nomic-embed-text', 768],
    ['mxbai-embed-large', 1024],
  ])('🚨 %s → %i', (model, dim) => {
    expect(dimensionsForModel(model)).toBe(dim);
  });

  it('🚨 unknown model → 1536 default', () => {
    expect(dimensionsForModel('bogus-model-xyz')).toBe(1536);
  });
});

describe('🚨 embedText — empty text fast path', () => {
  it('🚨 empty string → zero vector, no fetch', async () => {
    const r = await embedText({ provider: 'openai', apiKey: 'k', model: 'text-embedding-3-small', text: '' });
    expect(r.length).toBe(1536);
    expect(r.every((v) => v === 0)).toBe(true);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 whitespace only → zero vector', async () => {
    const r = await embedText({ provider: 'openai', apiKey: 'k', model: 'text-embedding-3-large', text: '   \n  ' });
    expect(r.length).toBe(3072);
  });
});

describe('🚨 OpenAI provider', () => {
  it('🚨 no apiKey → throw', async () => {
    await expect(embedText({ provider: 'openai', model: 'm', text: 'hi' }))
      .rejects.toThrow(/OpenAI embeddings require an API key/u);
  });

  it('🚨 happy: POST con Authorization Bearer', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });
    const r = await embedText({ provider: 'openai', apiKey: 'sk-xxx', model: 'text-embedding-3-small', text: 'hello' });
    expect(r).toEqual([0.1, 0.2, 0.3]);
    const [url, opts] = at(safeFetchMock.mock.calls, 0, 'fetch-calls');
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((opts.headers as any).Authorization).toBe('Bearer sk-xxx');
    expect(JSON.parse(opts.body as string).input).toBe('hello');
  });

  it('🚨 model vuoto → default text-embedding-3-small', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ data: [{ embedding: [] }] }),
    });
    await embedText({ provider: 'openai', apiKey: 'k', model: '', text: 'x' });
    expect(JSON.parse(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[1].body as string).model).toBe('text-embedding-3-small');
  });

  it('🚨 fetch !ok → throw con status + body slice 300', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: false, status: 429, text: () => Promise.resolve('rate-limited'.repeat(100)),
    });
    await expect(embedText({ provider: 'openai', apiKey: 'k', model: 'm', text: 't' }))
      .rejects.toThrow(/OpenAI embed 429/u);
  });

  it('🚨 response data vuoto → return []', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ data: [] }),
    });
    const r = await embedText({ provider: 'openai', apiKey: 'k', model: 'm', text: 't' });
    expect(r).toEqual([]);
  });
});

describe('🚨 Voyage provider', () => {
  it('🚨 no apiKey → throw', async () => {
    await expect(embedText({ provider: 'voyage', model: 'voyage-3', text: 'hi' }))
      .rejects.toThrow(/Voyage embeddings require/u);
  });

  it('🚨 happy: POST voyageai.com/v1/embeddings', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [0.5] }] }),
    });
    await embedText({ provider: 'voyage', apiKey: 'pa-xxx', model: 'voyage-3', text: 'x' });
    expect(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[0]).toBe('https://api.voyageai.com/v1/embeddings');
  });

  it('🚨 model vuoto → default voyage-3', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ data: [{ embedding: [] }] }),
    });
    await embedText({ provider: 'voyage', apiKey: 'k', model: '', text: 't' });
    expect(JSON.parse(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[1].body as string).model).toBe('voyage-3');
  });
});

describe('🚨 Ollama provider', () => {
  it('🚨 baseUrl default localhost:11434', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ embedding: [1, 2] }),
    });
    await embedText({ provider: 'ollama', model: 'nomic-embed-text', text: 'x' });
    expect(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[0]).toBe('http://localhost:11434/api/embeddings');
  });

  it('🚨 baseUrl custom + allowPrivateHost true (SSRF guard relax)', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ embedding: [1] }),
    });
    await embedText({ provider: 'ollama', baseUrl: 'http://192.168.1.5:8080', model: 'm', text: 'x' });
    expect(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[0]).toBe('http://192.168.1.5:8080/api/embeddings');
    expect((at(safeFetchMock.mock.calls, 0, 'fetch-calls')[1] as any).allowPrivateHost).toBe(true);
  });

  it('🚨 model vuoto → default nomic-embed-text', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ embedding: [] }),
    });
    await embedText({ provider: 'ollama', model: '', text: 't' });
    expect(JSON.parse(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[1].body as string).model).toBe('nomic-embed-text');
  });

  it('🚨 NO apiKey richiesta (self-hosted)', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: true, json: () => Promise.resolve({ embedding: [0.99] }),
    });
    const r = await embedText({ provider: 'ollama', model: 'm', text: 't' });
    expect(r).toEqual([0.99]);
  });
});

describe('🚨 unknown provider', () => {
  it('🚨 provider non in switch → throw', async () => {
    await expect(embedText({ provider: 'bogus' as any, model: 'm', text: 't' }))
      .rejects.toThrow(/Unknown embedding provider: bogus/u);
  });
});

describe('🚨 embedBatch — serial (rate-limit friendly)', () => {
  it('🚨 batch [a,b,c] → 3 chiamate sequenziali', async () => {
    safeFetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [{ embedding: [1] }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [{ embedding: [2] }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [{ embedding: [3] }] }) });
    const out = await embedBatch(
      { provider: 'openai', apiKey: 'k', model: 'm' },
      ['a', 'b', 'c'],
    );
    expect(out).toEqual([[1], [2], [3]]);
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
  });

  it('🚨 onProgress callback emette done/total per ogni step', async () => {
    safeFetchMock
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [{ embedding: [0] }] }) });
    const progress: [number, number][] = [];
    await embedBatch(
      { provider: 'openai', apiKey: 'k', model: 'm' },
      ['a', 'b'],
      (done, total) => progress.push([done, total]),
    );
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it('🚨 empty array → []', async () => {
    expect(await embedBatch({ provider: 'openai', apiKey: 'k', model: 'm' }, [])).toEqual([]);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
