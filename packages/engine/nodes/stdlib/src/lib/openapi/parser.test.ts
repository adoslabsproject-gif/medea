import { describe, it, expect } from 'vitest';
import {
  parseOpenApiOperations,
  openApiBaseUrl,
  buildOpenApiRequest,
  type OpenApiOperation,
} from './parser.js';

const spec = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: {
        operationId: 'getUser',
        summary: 'Get a user',
        parameters: [{ name: 'fields', in: 'query', required: false }],
      },
      delete: { operationId: 'deleteUser' },
    },
    '/users': {
      post: { operationId: 'createUser', requestBody: { content: {} } },
      get: { summary: 'List' }, // no operationId → fallback
    },
  },
};

describe('parseOpenApiOperations', () => {
  it('estrae tutte le operations (path × method)', () => {
    const ops = parseOpenApiOperations(spec);
    const ids = ops.map((o) => o.operationId).sort();
    expect(ids).toContain('getUser');
    expect(ids).toContain('deleteUser');
    expect(ids).toContain('createUser');
    expect(ids).toContain('GET /users'); // fallback senza operationId
    expect(ops.length).toBe(4);
  });

  it('eredita i path-level parameters nelle operations', () => {
    const get = parseOpenApiOperations(spec).find((o) => o.operationId === 'getUser')!;
    expect(get.parameters.some((p) => p.name === 'id' && p.in === 'path' && p.required)).toBe(true);
    expect(get.parameters.some((p) => p.name === 'fields' && p.in === 'query')).toBe(true);
    expect(get.method).toBe('GET');
    expect(get.summary).toBe('Get a user');
  });

  it('hasBody true solo con requestBody', () => {
    const ops = parseOpenApiOperations(spec);
    expect(ops.find((o) => o.operationId === 'createUser')?.hasBody).toBe(true);
    expect(ops.find((o) => o.operationId === 'getUser')?.hasBody).toBe(false);
  });

  it('spec invalida → array vuoto (no throw)', () => {
    expect(parseOpenApiOperations(null)).toEqual([]);
    expect(parseOpenApiOperations({})).toEqual([]);
    expect(parseOpenApiOperations({ paths: 'nope' })).toEqual([]);
  });
});

describe('openApiBaseUrl', () => {
  it('estrae il primo server url', () => {
    expect(openApiBaseUrl(spec)).toBe('https://api.example.com/v1');
    expect(openApiBaseUrl({})).toBeNull();
  });
});

describe('buildOpenApiRequest', () => {
  const getUser: OpenApiOperation = {
    operationId: 'getUser',
    method: 'GET',
    path: '/users/{id}',
    hasBody: false,
    parameters: [
      { name: 'id', in: 'path', required: true },
      { name: 'fields', in: 'query', required: false },
      { name: 'X-Trace', in: 'header', required: false },
    ],
  };

  it('sostituisce path param + raccoglie query/header', () => {
    const req = buildOpenApiRequest(getUser, 'https://api.example.com/v1/', {
      id: '42',
      fields: 'name,email',
      'X-Trace': 'abc',
    });
    expect(req.url).toBe('https://api.example.com/v1/users/42');
    expect(req.method).toBe('GET');
    expect(req.query).toEqual({ fields: 'name,email' });
    expect(req.headers).toEqual({ 'X-Trace': 'abc' });
  });

  it('URL-encoda i path param', () => {
    const req = buildOpenApiRequest(getUser, 'https://x.com', { id: 'a/b c' });
    expect(req.url).toBe('https://x.com/users/a%2Fb%20c');
  });

  it('path param required mancante → errore esplicito', () => {
    expect(() => buildOpenApiRequest(getUser, 'https://x.com', {})).toThrow(
      /path param "id" mancante/u,
    );
  });

  it('query/header vuoti omessi', () => {
    const req = buildOpenApiRequest(getUser, 'https://x.com', { id: '1' });
    expect(req.query).toEqual({});
    expect(req.headers).toEqual({});
  });
});
