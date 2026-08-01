/**
 * Bug-bounty test — postman-to-openapi (Postman Collection → OpenAPI 3.0).
 *
 * Cerca i bug VERI:
 *   - parsing: rifiuta input non-collection con errore chiaro;
 *   - url string E object, folder annidate → tag, query/header/body;
 *   - path param Postman `:id` → `{id}` (altrimenti il generatore non interpola);
 *   - auth bearer/basic/apikey → securitySchemes;
 *   - CATENA: postman→openapi→generateNodeFromOpenApi produce un nodo valido e
 *     l'executor generato (percorso già sicuro) costruisce la request giusta.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postmanToOpenApi, PostmanParseError } from './postman-to-openapi.js';
import { generateNodeFromOpenApi } from './openapi-to-node.js';

const COLLECTION = {
  info: { name: 'Acme Postman', description: 'Collez. Acme', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  item: [
    {
      name: 'Charges',
      item: [
        {
          name: 'List charges',
          request: {
            method: 'GET',
            header: [{ key: 'X-Trace', value: 'on' }, { key: 'Accept', value: 'application/json' }],
            url: { raw: 'https://api.acme.test/v2/charges?limit=10', host: ['api', 'acme', 'test'], path: ['v2', 'charges'], query: [{ key: 'limit', value: '10' }] },
          },
        },
        {
          name: 'Get charge',
          request: { method: 'GET', url: { raw: 'https://api.acme.test/v2/charges/:id', host: ['api', 'acme', 'test'], path: ['v2', 'charges', ':id'] } },
        },
        {
          name: 'Create charge',
          request: {
            method: 'POST',
            url: { raw: 'https://api.acme.test/v2/charges', host: ['api', 'acme', 'test'], path: ['v2', 'charges'] },
            body: { mode: 'raw', raw: '{"amount":100}', options: { raw: { language: 'json' } } },
          },
        },
      ],
    },
  ],
};

function loadExecutor(source: string): (config: Record<string, unknown>, input: unknown, ctx?: unknown) => Promise<{ status: number; ok: boolean; body: unknown }> {
  const body = source.replace('export const executor', 'const executor') + '\nreturn executor;';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(body)() as never;
}

afterEach(() => vi.restoreAllMocks());

describe('parsing — rifiuti', () => {
  it('non-oggetto → PostmanParseError', () => {
    expect(() => postmanToOpenApi('x')).toThrow(PostmanParseError);
    expect(() => postmanToOpenApi(null)).toThrow(PostmanParseError);
  });
  it('manca info.name → errore', () => {
    expect(() => postmanToOpenApi({ item: [] })).toThrow(/info\.name/);
  });
  it('manca item → errore', () => {
    expect(() => postmanToOpenApi({ info: { name: 'x' } })).toThrow(/item/);
  });
  it('zero request → errore (no spec vuoto)', () => {
    expect(() => postmanToOpenApi({ info: { name: 'x' }, item: [{ name: 'folder', item: [] }] })).toThrow(/non contiene request/);
  });
});

describe('mapping collection → openapi', () => {
  it('estrae title, baseUrl dal host, e le 3 operazioni', () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    expect((spec.info as { title: string }).title).toBe('Acme Postman');
    expect((spec.servers as { url: string }[])[0]!.url).toBe('https://api.acme.test');
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).sort()).toEqual(['/v2/charges', '/v2/charges/{id}']);
    expect(paths['/v2/charges']!.get).toBeDefined();
    expect(paths['/v2/charges']!.post).toBeDefined();
  });

  it('path param :id → {id} + parameter in=path (altrimenti non si interpola)', () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    const paths = spec.paths as Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    const getOne = paths['/v2/charges/{id}']!.get!;
    expect(getOne.parameters!.some((p) => p.name === 'id' && p.in === 'path')).toBe(true);
  });

  it('query → param in=query; header non-standard → param in=header (Accept escluso)', () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    const paths = spec.paths as Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    const list = paths['/v2/charges']!.get!;
    expect(list.parameters!.some((p) => p.name === 'limit' && p.in === 'query')).toBe(true);
    expect(list.parameters!.some((p) => p.name === 'X-Trace' && p.in === 'header')).toBe(true);
    expect(list.parameters!.some((p) => p.name === 'Accept')).toBe(false); // header standard escluso
  });

  it('folder → tag', () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    const paths = spec.paths as Record<string, Record<string, { tags?: string[] }>>;
    expect(paths['/v2/charges']!.get!.tags).toEqual(['Charges']);
  });

  it('body raw → requestBody application/json', () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    const paths = spec.paths as Record<string, Record<string, { requestBody?: unknown }>>;
    expect(paths['/v2/charges']!.post!.requestBody).toBeDefined();
  });

  it('auth bearer → securitySchemes http bearer', () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    const schemes = (spec.components as { securitySchemes: Record<string, { type: string; scheme?: string }> }).securitySchemes;
    const first = Object.values(schemes)[0]!;
    expect(first.type).toBe('http');
    expect(first.scheme).toBe('bearer');
  });
});

describe('url come stringa + variabili {{}}', () => {
  it('url stringa con {{baseUrl}} → host non costante → warning baseUrl', () => {
    const { spec, warnings } = postmanToOpenApi({
      info: { name: 'Var API' },
      item: [{ name: 'ping', request: { method: 'GET', url: '{{baseUrl}}/ping' } }],
    });
    expect(spec.servers).toBeUndefined();
    expect(warnings.some((w) => /baseUrl/i.test(w))).toBe(true);
    const paths = spec.paths as Record<string, unknown>;
    expect(Object.keys(paths)).toContain('/ping');
  });

  it('apikey auth in header → securitySchemes apiKey', () => {
    const { spec } = postmanToOpenApi({
      info: { name: 'K API' },
      auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Acme' }, { key: 'in', value: 'header' }] },
      item: [{ name: 'ping', request: { method: 'GET', url: { host: ['a', 'test'], path: ['ping'] } } }],
    });
    const schemes = (spec.components as { securitySchemes: Record<string, { type: string; in?: string; name?: string }> }).securitySchemes;
    const first = Object.values(schemes)[0]!;
    expect(first.type).toBe('apiKey');
    expect(first.in).toBe('header');
    expect(first.name).toBe('X-Acme');
  });
});

describe('gap di completezza segnalati (warning, non silenzio)', () => {
  it('🚨 stesso metodo+path in folder diverse → warning collisione, tiene la prima', () => {
    const { spec, warnings } = postmanToOpenApi({
      info: { name: 'Dup Paths' },
      item: [
        { name: 'A', item: [{ name: 'List v1', request: { method: 'GET', url: { host: ['a', 'test'], path: ['charges'] } } }] },
        { name: 'B', item: [{ name: 'List v2', request: { method: 'GET', url: { host: ['a', 'test'], path: ['charges'] } } }] },
      ],
    });
    expect(warnings.some((w) => /[Cc]ollisione/.test(w))).toBe(true);
    const paths = spec.paths as Record<string, Record<string, { summary?: string }>>;
    // tiene la PRIMA (List v1), non la seconda
    expect(paths['/charges']!.get!.summary).toBe('List v1');
  });

  it('🚨 auth a livello di request → warning (non mappata)', () => {
    const { warnings } = postmanToOpenApi({
      info: { name: 'Req Auth' },
      item: [{
        name: 'Secured',
        request: { method: 'GET', url: { host: ['a', 'test'], path: ['x'] }, auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] } },
      }],
    });
    expect(warnings.some((w) => w.includes('auth definita a livello di request'))).toBe(true);
  });
});

describe('🚨 CATENA end-to-end: postman → openapi → nodo eseguibile', () => {
  it('genera un custom node valido e l\'executor costruisce la request giusta', async () => {
    const { spec } = postmanToOpenApi(COLLECTION);
    const node = generateNodeFromOpenApi(spec);
    expect(node.stats.operations).toBe(3);

    // esegui l'executor generato sull'operazione path-param
    const def = JSON.parse(node.sourceDefinition.replace('export const definition = ', '').replace(/;\s*$/, '')) as {
      config: { key: string; showIf?: { equals?: string } }[];
    };
    // trova l'actionId dell'operazione "Get charge" (path {id})
    const opField = def.config.find((f) => f.key === 'operation') as { options?: string[] };
    const getOneId = opField.options!.find((o) => /Get_charge/i.test(o)) ?? opField.options![1]!;
    const idKey = def.config.find((f) => f.showIf?.equals === getOneId && f.key.endsWith("id"))!.key;

    const executor = loadExecutor(node.sourceExecutor);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => '{"id":"ch_9"}' });
    vi.stubGlobal('fetch', fetchMock);

    const res = await executor(
      { operation: getOneId, baseUrl: 'https://api.acme.test', [idKey]: 'ch_9', auth_bearer_token: 'tok' },
      null,
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.acme.test/v2/charges/ch_9');
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
    expect(res.body).toEqual({ id: 'ch_9' });
  });

  it('determinismo: stessa collection → stesso spec', () => {
    expect(JSON.stringify(postmanToOpenApi(COLLECTION).spec)).toBe(JSON.stringify(postmanToOpenApi(COLLECTION).spec));
  });
});
