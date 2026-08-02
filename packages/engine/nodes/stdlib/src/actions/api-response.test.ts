/**
 * Test REALI di action_api_response — eseguono l'executor vero, niente stub.
 * Verificano il contratto del sentinel `__webhookResponse` (status/contentType/
 * body/headers) ESATTAMENTE come lo legge il runtime (extractWebhookResponse:
 * status number + contentType string + body string), l'envelope REST, la mappa
 * codice→status, CORS e la guardia anti header-injection.
 */
import { describe, it, expect } from 'vitest';
import { apiResponseNode } from './api-response.js';

const api = apiResponseNode.executor!;
const ctx = {} as never;

/** Replica la validazione del runtime (apps/engine/src/routes/webhooks.ts). */
function asSentinel(output: unknown): {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
} {
  const o = output as Record<string, unknown>;
  const p = o.__webhookResponse as Record<string, unknown>;
  expect(typeof p.status).toBe('number');
  expect(typeof p.contentType).toBe('string');
  expect(typeof p.body).toBe('string'); // il runtime RICHIEDE body stringa
  return p as {
    status: number;
    contentType: string;
    body: string;
    headers: Record<string, string>;
  };
}

describe('action_api_response — success', () => {
  it('envelope { ok:true, data } + status 200 + content-type json', async () => {
    const r = await api(
      { mode: 'success', data: '{"id":1,"nome":"Anna"}', statusSuccess: '200' },
      undefined,
      ctx,
    );
    const s = asSentinel(r.output);
    expect(s.status).toBe(200);
    expect(s.contentType).toContain('application/json');
    expect(JSON.parse(s.body)).toEqual({ ok: true, data: { id: 1, nome: 'Anna' } });
  });
  it('status 201 Created', async () => {
    const r = await api(
      { mode: 'success', data: '{"created":true}', statusSuccess: '201' },
      undefined,
      ctx,
    );
    expect(asSentinel(r.output).status).toBe(201);
  });
  it("meta paginazione inclusa nell'envelope", async () => {
    const r = await api(
      { mode: 'success', data: '[1,2,3]', meta: '{"page":1,"total":3}' },
      undefined,
      ctx,
    );
    const body = JSON.parse(asSentinel(r.output).body);
    expect(body).toEqual({ ok: true, data: [1, 2, 3], meta: { page: 1, total: 3 } });
  });
  it("usa l'input del nodo se data è vuoto", async () => {
    const r = await api({ mode: 'success' }, { fromInput: true }, ctx);
    expect(JSON.parse(asSentinel(r.output).body)).toEqual({ ok: true, data: { fromInput: true } });
  });
  it('envelope off → dati grezzi', async () => {
    const r = await api({ mode: 'success', data: '{"raw":1}', envelope: 'false' }, undefined, ctx);
    expect(JSON.parse(asSentinel(r.output).body)).toEqual({ raw: 1 });
  });
});

describe('action_api_response — error (codice → status)', () => {
  it('not_found → 404 + envelope error', async () => {
    const r = await api(
      { mode: 'error', errorCode: 'not_found', errorMessage: 'Ordine inesistente' },
      undefined,
      ctx,
    );
    const s = asSentinel(r.output);
    expect(s.status).toBe(404);
    expect(JSON.parse(s.body)).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Ordine inesistente' },
    });
  });
  it('validation_error → 422 con details strutturati', async () => {
    const r = await api(
      {
        mode: 'error',
        errorCode: 'validation_error',
        errorMessage: 'Input non valido',
        errorDetails: '{"field":"email","reason":"formato"}',
      },
      undefined,
      ctx,
    );
    const s = asSentinel(r.output);
    expect(s.status).toBe(422);
    expect(JSON.parse(s.body).error.details).toEqual({ field: 'email', reason: 'formato' });
  });
  it('rate_limited → 429, server_error → 500, unauthorized → 401', async () => {
    expect(
      asSentinel((await api({ mode: 'error', errorCode: 'rate_limited' }, undefined, ctx)).output)
        .status,
    ).toBe(429);
    expect(
      asSentinel((await api({ mode: 'error', errorCode: 'server_error' }, undefined, ctx)).output)
        .status,
    ).toBe(500);
    expect(
      asSentinel((await api({ mode: 'error', errorCode: 'unauthorized' }, undefined, ctx)).output)
        .status,
    ).toBe(401);
  });
  it('messaggio derivato dal codice se vuoto', async () => {
    const r = await api({ mode: 'error', errorCode: 'forbidden' }, undefined, ctx);
    expect(JSON.parse(asSentinel(r.output).body).error.message).toBe('forbidden');
  });
});

describe('action_api_response — CORS + headers', () => {
  it('CORS abilitato aggiunge gli header standard', async () => {
    const r = await api(
      {
        mode: 'success',
        data: '{}',
        cors: 'true',
        corsOrigin: 'https://app.x.it',
        corsCredentials: 'true',
      },
      undefined,
      ctx,
    );
    const h = asSentinel(r.output).headers;
    expect(h['Access-Control-Allow-Origin']).toBe('https://app.x.it');
    expect(h['Access-Control-Allow-Methods']).toContain('POST');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
  });
  it('header personalizzati passano', async () => {
    const r = await api(
      { mode: 'success', data: '{}', headers: '{"Cache-Control":"no-store","X-Api-Version":"1"}' },
      undefined,
      ctx,
    );
    const h = asSentinel(r.output).headers;
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Api-Version']).toBe('1');
  });
  it('guardia anti header-injection: valori con CRLF scartati', async () => {
    const r = await api(
      { mode: 'success', data: '{}', headers: '{"X-Bad":"a\\r\\nSet-Cookie: evil=1","X-Ok":"v"}' },
      undefined,
      ctx,
    );
    const h = asSentinel(r.output).headers;
    expect(h['X-Bad']).toBeUndefined(); // scartato
    expect(h['X-Ok']).toBe('v');
  });
  it('guardia anti header-injection: NOME header non-token (CRLF nella chiave) scartato', async () => {
    // MUTATION: senza HEADER_NAME_RE → la chiave con CRLF entrerebbe in headers → rosso.
    const r = await api(
      { mode: 'success', data: '{}', headers: '{"X-Bad\\r\\nSet-Cookie":"evil","X-Ok":"v"}' },
      undefined,
      ctx,
    );
    const h = asSentinel(r.output).headers;
    expect(Object.keys(h).some((k) => /[\r\n]/.test(k))).toBe(false);
    expect(h['Set-Cookie']).toBeUndefined();
    expect(h['X-Ok']).toBe('v');
  });
  it('guardia anti header-injection: corsOrigin con CRLF strippato', async () => {
    const r = await api(
      { mode: 'success', data: '{}', cors: 'true', corsOrigin: 'https://ok.it\r\nX-Injected: 1' },
      undefined,
      ctx,
    );
    const h = asSentinel(r.output).headers;
    expect(h['Access-Control-Allow-Origin']).toBe('https://ok.itX-Injected: 1');
    expect(JSON.stringify(h)).not.toMatch(/[\r\n]/);
  });
});

describe('action_api_response — contratto runtime', () => {
  it('output.__webhookResponse rispetta lo shape richiesto da extractWebhookResponse', async () => {
    const r = await api({ mode: 'success', data: '{"x":1}' }, undefined, ctx);
    const o = r.output as Record<string, unknown>;
    // chiave esatta + 3 campi tipizzati che il runtime verifica
    expect(o).toHaveProperty('__webhookResponse');
    const p = o.__webhookResponse as Record<string, unknown>;
    expect(typeof p.status).toBe('number');
    expect(typeof p.contentType).toBe('string');
    expect(typeof p.body).toBe('string');
    expect(typeof p.headers).toBe('object');
    // body è JSON valido (il runtime lo invia raw come stringa)
    expect(() => JSON.parse(p.body as string)).not.toThrow();
  });
});
