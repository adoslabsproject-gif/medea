import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@medea/engine-safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@medea/engine-safe-fetch')>()),
  assertUrlSafe: vi.fn(async () => {
    /* allow */
  }),
}));

import { openapiExecutor } from './executor.js';

const spec = JSON.stringify({
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [
          { name: 'id', in: 'path', required: true },
          { name: 'fields', in: 'query', required: false },
        ],
      },
    },
    '/users': { post: { operationId: 'createUser', requestBody: { content: {} } } },
  },
});
const ctx = { abortSignal: undefined } as never;

describe('openapiExecutor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("esegue l'operation: path param sostituito + query + data parsata", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ name: 'Ada' }), { status: 200 }),
    );
    global.fetch = fetchMock;
    const r = await openapiExecutor(
      { specJson: spec, operationId: 'getUser', paramsJson: '{"id":"42","fields":"name"}' },
      undefined,
      ctx,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/users/42?fields=name');
    expect(r.output).toMatchObject({ status: 200, operationId: 'getUser', data: { name: 'Ada' } });
  });

  it('POST con body → invia il body + Content-Type json', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    global.fetch = fetchMock;
    await openapiExecutor(
      { specJson: spec, operationId: 'createUser', bodyJson: '{"name":"X"}' },
      undefined,
      ctx,
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"X"}');
    expect((init.headers as Headers).get('Content-Type')).toMatch(/json/u);
  });

  it('header di auth applicato', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
    await openapiExecutor(
      {
        specJson: spec,
        operationId: 'getUser',
        paramsJson: '{"id":"1"}',
        authHeader: 'Authorization',
        authValue: 'Bearer t',
      },
      undefined,
      ctx,
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
  });

  it('operationId inesistente → ValidationError', async () => {
    await expect(
      openapiExecutor({ specJson: spec, operationId: 'nope' }, undefined, ctx),
    ).rejects.toThrow(/non trovata/u);
  });

  it('spec non JSON → ValidationError', async () => {
    await expect(
      openapiExecutor({ specJson: 'not json', operationId: 'x' }, undefined, ctx),
    ).rejects.toThrow(/non è JSON/u);
  });

  it('path param required mancante → errore', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(
      openapiExecutor({ specJson: spec, operationId: 'getUser', paramsJson: '{}' }, undefined, ctx),
    ).rejects.toThrow(/path param "id" mancante/u);
  });

  it('response non-ok → HttpError', async () => {
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      openapiExecutor(
        { specJson: spec, operationId: 'getUser', paramsJson: '{"id":"9"}' },
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('429 con Retry-After → HttpError porta retryAfterMs (header parsato)', async () => {
    global.fetch = vi.fn(
      async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    try {
      await openapiExecutor(
        { specJson: spec, operationId: 'getUser', paramsJson: '{"id":"1"}' },
        undefined,
        ctx,
      );
      throw new Error('atteso throw');
    } catch (e) {
      expect((e as { context?: { retryAfterMs?: number } }).context?.retryAfterMs).toBe(120_000);
    }
  });

  it('503 senza Retry-After → HttpError senza retryAfterMs', async () => {
    global.fetch = vi.fn(async () => new Response('down', { status: 503 }));
    try {
      await openapiExecutor(
        { specJson: spec, operationId: 'getUser', paramsJson: '{"id":"1"}' },
        undefined,
        ctx,
      );
      throw new Error('atteso throw');
    } catch (e) {
      expect((e as { context?: { retryAfterMs?: number } }).context?.retryAfterMs).toBeUndefined();
    }
  });
});
