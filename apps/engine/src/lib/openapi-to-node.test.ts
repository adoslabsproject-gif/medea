/**
 * Bug-bounty test — openapi-to-node (generatore OpenAPI 3.x → Custom Node).
 *
 * Cerca i bug VERI di questa classe:
 *   - parsing robusto: rifiuta swagger 2.0 / spec malformati con errore chiaro;
 *   - mapping corretto: operations → select `operation`, params → config con showIf;
 *   - CONTRATTO custom-node: defId prefisso custom_, kind action, inputs/outputs,
 *     e SOPRATTUTTO ogni config key DEVE matchare /^[a-zA-Z0-9_]+$/ (regex
 *     ConfigField del community-node-sdk: una key con trattino romperebbe il nodo);
 *   - SICUREZZA: l'executor generato NON deve contenere pattern proibiti dal
 *     securityScan reale (require/eval/Function/process.env/child_process);
 *   - COMPORTAMENTO: eseguendo l'executor generato con fetch mockato, la request
 *     (URL/headers/body/auth) deve essere quella attesa;
 *   - determinismo: stesso spec → stesso output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateNodeFromOpenApi, slugify, OpenApiParseError } from './openapi-to-node.js';
import { securityScan } from '@/services/custom-nodes/compile.service.js';

const CONFIG_KEY_RE = /^[a-zA-Z0-9_]+$/u;

// ── spec realistico minimale ma completo (3.0) ──────────────────────────────
const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Acme Payments API', version: '2.1.0', description: 'Pagamenti Acme.' },
  servers: [{ url: 'https://api.acme.test/v2' }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/charges': {
      get: {
        operationId: 'listCharges',
        summary: 'Elenca i pagamenti',
        tags: ['Charges'],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'X-Trace', in: 'header', required: false, schema: { type: 'string' } },
        ],
      },
      post: {
        operationId: 'createCharge',
        summary: 'Crea un pagamento',
        tags: ['Charges'],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
    '/charges/{id}': {
      get: {
        operationId: 'getCharge',
        summary: 'Dettaglio pagamento',
        tags: ['Charges'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

interface GenDef {
  defId: string;
  displayName: string;
  kind: string;
  category: string;
  inputs: string[];
  outputs: string[];
  config: {
    key: string;
    label: string;
    type?: string;
    required?: boolean;
    defaultValue?: string;
    options?: string[];
    showIf?: { field: string; equals?: string };
  }[];
}

function parseDef(source: string): GenDef {
  return JSON.parse(
    source.replace('export const definition = ', '').replace(/;\s*$/, ''),
  ) as GenDef;
}

/** Carica l'executor generato come funzione reale (esegue il codice prodotto). */
function loadExecutor(
  source: string,
): (
  config: Record<string, unknown>,
  input: unknown,
  ctx?: unknown,
) => Promise<{ status: number; ok: boolean; body: unknown }> {
  const body = source.replace('export const executor', 'const executor') + '\nreturn executor;';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(body)() as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('slugify', () => {
  it.each([
    ['Acme Payments API', 'acme-payments-api'],
    ['  Hello World!!  ', 'hello-world'],
    ['UPPER_case-123', 'upper-case-123'],
    ['', 'api'],
    ['***', 'api'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('parsing — rifiuti espliciti (no silent garbage)', () => {
  it('swagger 2.0 → errore chiaro che indica la conversione', () => {
    expect(() => generateNodeFromOpenApi({ swagger: '2.0', paths: {} })).toThrow(
      /Swagger 2\.0 non supportato/,
    );
  });
  it('campo openapi mancante → errore', () => {
    expect(() => generateNodeFromOpenApi({ info: {}, paths: {} })).toThrow(OpenApiParseError);
  });
  it('versione non 3.x → errore', () => {
    expect(() => generateNodeFromOpenApi({ openapi: '4.0.0', paths: {} })).toThrow(
      /non supportata/,
    );
  });
  it('spec non-oggetto → errore', () => {
    expect(() => generateNodeFromOpenApi('not an object')).toThrow(OpenApiParseError);
    expect(() => generateNodeFromOpenApi(null)).toThrow(OpenApiParseError);
  });
  it('zero operazioni → errore (no nodo vuoto)', () => {
    expect(() =>
      generateNodeFromOpenApi({ openapi: '3.0.0', info: { title: 'x' }, paths: {} }),
    ).toThrow(/non contiene operazioni/);
  });
});

describe('mapping spec → nodo', () => {
  it('estrae tutte le operazioni + risorse (stats)', () => {
    const node = generateNodeFromOpenApi(SPEC);
    expect(node.stats.operations).toBe(3);
    expect(node.stats.resources).toBe(1); // tag "Charges"
    expect(node.slug).toBe('acme-payments-api');
    expect(node.displayName).toBe('Acme Payments API');
  });

  it('definition: select operation con tutte le op, defId con prefisso custom_', () => {
    const def = parseDef(generateNodeFromOpenApi(SPEC).sourceDefinition);
    expect(def.defId).toBe('custom_acme-payments-api');
    expect(def.kind).toBe('action');
    const opField = def.config.find((f) => f.key === 'operation');
    expect(opField?.type).toBe('select');
    expect(opField?.options).toEqual(['listCharges', 'createCharge', 'getCharge']);
    expect(opField?.defaultValue).toBe('listCharges');
  });

  it("param path/query/header → config con showIf sull'operazione, key namespaced", () => {
    const def = parseDef(generateNodeFromOpenApi(SPEC).sourceDefinition);
    // getCharge ha path param id → key namespaced getCharge_id, showIf operation=getCharge
    const idField = def.config.find(
      (f) => f.showIf?.equals === 'getCharge' && f.key.endsWith('id'),
    );
    expect(idField).toBeDefined();
    expect(idField!.showIf).toEqual({ field: 'operation', equals: 'getCharge' });
    // listCharges ha query limit + header X-Trace
    const limit = def.config.find(
      (f) => f.showIf?.equals === 'listCharges' && /limit$/i.test(f.key),
    );
    const trace = def.config.find(
      (f) => f.showIf?.equals === 'listCharges' && /trace$/i.test(f.key),
    );
    expect(limit).toBeDefined();
    expect(trace).toBeDefined();
  });

  it('requestBody JSON → campo body json con showIf', () => {
    const def = parseDef(generateNodeFromOpenApi(SPEC).sourceDefinition);
    const body = def.config.find((f) => f.showIf?.equals === 'createCharge' && f.type === 'json');
    expect(body).toBeDefined();
  });

  it('shared: baseUrl con default dal server + bearer secret', () => {
    const def = parseDef(generateNodeFromOpenApi(SPEC).sourceDefinition);
    const base = def.config.find((f) => f.key === 'baseUrl') as { defaultValue?: string };
    expect(base.defaultValue).toBe('https://api.acme.test/v2');
    expect(def.config.some((f) => f.key === 'auth_bearer_token')).toBe(true);
  });
});

describe('🚨 CONTRATTO custom-node: definition strutturalmente valida', () => {
  it('SPEC completo → invarianti rispettati + ogni config key valida /^[a-zA-Z0-9_]+$/', () => {
    const def = parseDef(generateNodeFromOpenApi(SPEC).sourceDefinition);
    expect(def.defId.startsWith('custom_')).toBe(true);
    expect(def.kind).toBe('action');
    expect(Array.isArray(def.inputs) && def.inputs.length > 0).toBe(true);
    expect(Array.isArray(def.outputs) && def.outputs.length > 0).toBe(true);
    for (const f of def.config) {
      expect(f.key, `key "${f.key}" deve essere [a-zA-Z0-9_]`).toMatch(CONFIG_KEY_RE);
      expect(f.label.length).toBeGreaterThan(0);
    }
    // nessuna key duplicata
    const keys = def.config.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('header "X-Trace" → key SENZA trattino (regola che becca il bug originale)', () => {
    const def = parseDef(generateNodeFromOpenApi(SPEC).sourceDefinition);
    const trace = def.config.find((f) => /trace/i.test(f.key));
    expect(trace).toBeDefined();
    expect(trace!.key).not.toContain('-');
    expect(trace!.key).toMatch(CONFIG_KEY_RE);
  });

  it('operationId/tag con caratteri illegali → key e option valide', () => {
    const node = generateNodeFromOpenApi({
      openapi: '3.0.0',
      info: { title: 'Weird API' },
      paths: { '/x': { get: { operationId: 'get/weird id!!', tags: ['Foo Bar'] } } },
    });
    const def = parseDef(node.sourceDefinition);
    for (const f of def.config) expect(f.key).toMatch(CONFIG_KEY_RE);
  });
});

describe("🚨 SICUREZZA: l'executor generato passa il securityScan reale", () => {
  it('SPEC completo → zero violazioni', () => {
    const node = generateNodeFromOpenApi(SPEC);
    expect(
      securityScan({
        executor: node.sourceExecutor,
        definition: node.sourceDefinition,
        schema: node.sourceSchema,
      }),
    ).toEqual([]);
  });
});

describe("🚨 COMPORTAMENTO: eseguendo l'executor generato la request è corretta", () => {
  function defKey(
    node: ReturnType<typeof generateNodeFromOpenApi>,
    actionId: string,
    match: RegExp,
  ): string {
    const def = parseDef(node.sourceDefinition);
    const f = def.config.find((x) => x.showIf?.equals === actionId && match.test(x.key));
    if (!f) throw new Error(`no field ${match} for ${actionId}`);
    return f.key;
  }

  it('GET path param + query + bearer → URL, Authorization e metodo giusti', async () => {
    const node = generateNodeFromOpenApi(SPEC);
    const executor = loadExecutor(node.sourceExecutor);
    const idKey = defKey(node, 'getCharge', /id$/);
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ id: 'ch_1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await executor(
      {
        operation: 'getCharge',
        baseUrl: 'https://api.acme.test/v2',
        [idKey]: 'ch_1',
        auth_bearer_token: 'tok_abc',
      },
      null,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v2/charges/ch_1');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok_abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'ch_1' });
  });

  it('POST body JSON → POST, Content-Type e body inoltrati', async () => {
    const node = generateNodeFromOpenApi(SPEC);
    const executor = loadExecutor(node.sourceExecutor);
    const bodyKey = defKey(node, 'createCharge', /body$/);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ status: 201, ok: true, text: async () => '{"created":true}' });
    vi.stubGlobal('fetch', fetchMock);

    await executor(
      {
        operation: 'createCharge',
        baseUrl: 'https://api.acme.test/v2',
        [bodyKey]: '{"amount":100}',
        auth_bearer_token: 't',
      },
      null,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v2/charges');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"amount":100}');
  });

  it('query param → searchParams; baseUrl con slash finale normalizzato', async () => {
    const node = generateNodeFromOpenApi(SPEC);
    const executor = loadExecutor(node.sourceExecutor);
    const limitKey = defKey(node, 'listCharges', /limit$/i);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => '[]' });
    vi.stubGlobal('fetch', fetchMock);

    await executor(
      {
        operation: 'listCharges',
        baseUrl: 'https://api.acme.test/v2/',
        [limitKey]: '25',
        auth_bearer_token: 't',
      },
      null,
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.acme.test/v2/charges?limit=25');
  });

  it('operation sconosciuta → throw esplicito', async () => {
    const executor = loadExecutor(generateNodeFromOpenApi(SPEC).sourceExecutor);
    vi.stubGlobal('fetch', vi.fn());
    await expect(executor({ operation: 'nope', baseUrl: 'https://x.test' }, null)).rejects.toThrow(
      /non riconosciuta/,
    );
  });

  it('baseUrl mancante → throw (non chiama fetch)', async () => {
    const executor = loadExecutor(generateNodeFromOpenApi(SPEC).sourceExecutor);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(executor({ operation: 'getCharge' }, null)).rejects.toThrow(/Base URL mancante/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("auth: ogni security scheme → executor che applica l'auth giusta", () => {
  function specWithAuth(securitySchemes: Record<string, unknown>) {
    return {
      openapi: '3.0.0',
      info: { title: 'AuthAPI' },
      servers: [{ url: 'https://a.test' }],
      components: { securitySchemes },
      paths: { '/p': { get: { operationId: 'ping' } } },
    };
  }

  it('apiKey header → header con il nome dichiarato', async () => {
    const node = generateNodeFromOpenApi(
      specWithAuth({ k: { type: 'apiKey', in: 'header', name: 'X-Acme-Key' } }),
    );
    const executor = loadExecutor(node.sourceExecutor);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => '{}' });
    vi.stubGlobal('fetch', fetchMock);
    await executor({ operation: 'ping', baseUrl: 'https://a.test', auth_api_key: 'secret' }, null);
    expect(fetchMock.mock.calls[0]![1].headers['X-Acme-Key']).toBe('secret');
  });

  it('apiKey query → searchParam con il nome dichiarato', async () => {
    const node = generateNodeFromOpenApi(
      specWithAuth({ k: { type: 'apiKey', in: 'query', name: 'api_key' } }),
    );
    const executor = loadExecutor(node.sourceExecutor);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => '{}' });
    vi.stubGlobal('fetch', fetchMock);
    await executor({ operation: 'ping', baseUrl: 'https://a.test', auth_api_key: 'qk' }, null);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://a.test/p?api_key=qk');
  });

  it('basic → header Authorization Basic base64(user:pass)', async () => {
    const node = generateNodeFromOpenApi(specWithAuth({ k: { type: 'http', scheme: 'basic' } }));
    const executor = loadExecutor(node.sourceExecutor);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => '{}' });
    vi.stubGlobal('fetch', fetchMock);
    await executor(
      {
        operation: 'ping',
        baseUrl: 'https://a.test',
        auth_basic_user: 'u',
        auth_basic_password: 'p',
      },
      null,
    );
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Basic ' + btoa('u:p'));
  });

  it('oauth2 → warning + fallback bearer', () => {
    const node = generateNodeFromOpenApi(specWithAuth({ k: { type: 'oauth2', flows: {} } }));
    expect(node.warnings.some((w) => /oauth2/i.test(w))).toBe(true);
    const def = parseDef(node.sourceDefinition);
    expect(def.config.some((f) => f.key === 'auth_bearer_token')).toBe(true);
  });

  it('più security scheme → warning sul primo usato', () => {
    const node = generateNodeFromOpenApi(
      specWithAuth({
        a: { type: 'http', scheme: 'bearer' },
        b: { type: 'apiKey', in: 'header', name: 'X-K' },
      }),
    );
    expect(node.warnings.some((w) => /security scheme/i.test(w))).toBe(true);
  });
});

describe('robustezza & determinismo', () => {
  it('operationId duplicati → option suffissate, nessuna collisione', () => {
    const node = generateNodeFromOpenApi({
      openapi: '3.0.0',
      info: { title: 'Dup' },
      paths: { '/a': { get: { operationId: 'same' } }, '/b': { get: { operationId: 'same' } } },
    });
    const def = parseDef(node.sourceDefinition);
    const opts = def.config.find((f) => f.key === 'operation')!.options!;
    expect(new Set(opts).size).toBe(opts.length);
    expect(opts).toContain('same');
    expect(opts).toContain('same_2');
  });

  it('maxOperations cap → skipped contato + warning', () => {
    const node = generateNodeFromOpenApi(
      {
        openapi: '3.0.0',
        info: { title: 'Big' },
        paths: { '/a': { get: {}, post: {} }, '/b': { get: {} } },
      },
      { maxOperations: 2 },
    );
    expect(node.stats.operations).toBe(2);
    expect(node.stats.skipped).toBe(1);
    expect(node.warnings.some((w) => w.includes('cap di 2'))).toBe(true);
  });

  it('stesso spec → output identico (deterministico)', () => {
    const a = generateNodeFromOpenApi(SPEC);
    const b = generateNodeFromOpenApi(SPEC);
    expect(a.sourceDefinition).toBe(b.sourceDefinition);
    expect(a.sourceExecutor).toBe(b.sourceExecutor);
    expect(a.sourceSchema).toBe(b.sourceSchema);
  });

  it('slug override rispettato', () => {
    expect(generateNodeFromOpenApi(SPEC, { slug: 'my-custom-slug' }).slug).toBe('my-custom-slug');
  });
});
