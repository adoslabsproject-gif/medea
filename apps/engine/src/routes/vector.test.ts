/**
 * Test 2026-grade — vector routes (Qdrant/Embedded vector ops).
 *
 * 🚨 INPUT VALIDATION (Zod):
 *  - dimensions int positivo max 8192 (modello max embedding)
 *  - distance enum cosine/euclidean/dot
 *  - topK max 1000 (DoS prevention)
 *  - records min 1 (no upsert vuoto)
 *  - vector array di numeri
 *
 * 🚨 SERVICE ERROR → 400 con message (no 500 crashy)
 *
 * 🚨 TENANT ISOLATION: ogni call passa getTenantId(c) come last arg.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const listCollectionsMock = vi.fn();
const ensureCollectionMock = vi.fn();
const upsertMock = vi.fn();
const searchMock = vi.fn();
const deleteIdsMock = vi.fn();
const countMock = vi.fn();
const dropCollectionMock = vi.fn();

class VectorServiceMock {
  listCollections = listCollectionsMock;
  ensureCollection = ensureCollectionMock;
  upsert = upsertMock;
  search = searchMock;
  deleteIds = deleteIdsMock;
  count = countMock;
  dropCollection = dropCollectionMock;
}
vi.mock('@/services/vector.service.js', () => ({
  VectorService: VectorServiceMock,
}));

const ingestTextMock = vi.fn();
vi.mock('@/services/vector-ingest.js', () => ({
  ingestText: ingestTextMock,
  vectorPlanLimitsFromConfig: () => ({ maxVectors: null, maxDiskMb: null }),
}));

const embedTextMock = vi.fn();
vi.mock('@/services/embeddings.service.js', () => ({
  embedText: embedTextMock,
  dimensionsForModel: () => 1024,
}));

const isWorkspaceReadOnlyMock = vi.fn(() => false);
vi.mock('@/services/readonly-flag.service.js', () => ({
  isWorkspaceReadOnly: isWorkspaceReadOnlyMock,
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-tenant-id') ?? 'tenant-A',
}));

const { createVectorRoutes } = await import('./vector.js');

function makeApp(): Hono {
  const app = new Hono();
  app.route('/v', createVectorRoutes());
  return app;
}

async function postJSON(path: string, body: unknown): Promise<Response> {
  return makeApp().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant-A' },
    body: JSON.stringify(body),
  });
}

async function getReq(path: string): Promise<Response> {
  return makeApp().request(path, {
    headers: { 'x-tenant-id': 'tenant-A' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isWorkspaceReadOnlyMock.mockReturnValue(false); // default: workspace scrivibile
});

describe('🚨 GET /:dbId/collections', () => {
  it('🚨 happy: list collections + tenant propagato', async () => {
    listCollectionsMock.mockResolvedValue([{ name: 'col1', count: 10 }]);
    const res = await getReq('/v/db-1/collections');
    expect(res.status).toBe(200);
    const json = await res.json() as { collections: unknown[] };
    expect(json.collections).toHaveLength(1);
    expect(listCollectionsMock).toHaveBeenCalledWith('db-1', 'tenant-A');
  });

  it('🚨 service throw → 400 + error message', async () => {
    listCollectionsMock.mockRejectedValue(new Error('Qdrant unreachable'));
    const res = await getReq('/v/db-x/collections');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('Qdrant unreachable');
  });

  it('🚨 service throw non-Error → coerced a String', async () => {
    listCollectionsMock.mockRejectedValue('raw-string-err');
    const res = await getReq('/v/db-x/collections');
    const json = await res.json() as { error: string };
    expect(json.error).toBe('raw-string-err');
  });
});

describe('🚨 POST /:dbId/collections (ensureCollection)', () => {
  it('🚨 happy: 201 con collection+dimensions+distance', async () => {
    ensureCollectionMock.mockResolvedValue(undefined);
    const res = await postJSON('/v/db/collections', {
      collection: 'my-col', dimensions: 1536, distance: 'cosine',
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { ok: boolean; collection: string; dimensions: number; distance: string };
    expect(json.ok).toBe(true);
    expect(json.distance).toBe('cosine');
    expect(ensureCollectionMock).toHaveBeenCalledWith('db', 'my-col', 1536, 'cosine', 'tenant-A');
  });

  it('🚨 distance default = cosine se omesso', async () => {
    ensureCollectionMock.mockResolvedValue(undefined);
    const res = await postJSON('/v/db/collections', {
      collection: 'c', dimensions: 768,
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { distance: string };
    expect(json.distance).toBe('cosine');
  });

  it('🚨 INPUT VALIDATION: dimensions max 8192 → 400', async () => {
    const res = await postJSON('/v/db/collections', {
      collection: 'c', dimensions: 8193, distance: 'cosine',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: dimensions 0 → 400 (must be positive)', async () => {
    const res = await postJSON('/v/db/collections', {
      collection: 'c', dimensions: 0,
    });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: distance invalida → 400', async () => {
    const res = await postJSON('/v/db/collections', {
      collection: 'c', dimensions: 100, distance: 'manhattan',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: collection name vuoto → 400', async () => {
    const res = await postJSON('/v/db/collections', {
      collection: '', dimensions: 100,
    });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: collection > 200 char → 400', async () => {
    const res = await postJSON('/v/db/collections', {
      collection: 'x'.repeat(201), dimensions: 100,
    });
    expect(res.status).toBe(400);
  });
});

describe('🔒 SICUREZZA: NESSUN endpoint raw /upsert (bypass scan+quota chiuso)', () => {
  // L'endpoint raw /upsert era tenant-reachable e scriveva vettori SENZA scan
  // anti-injection né quota → bypass dell'"autorità unica del write-path". Rimosso:
  // l'unico write-path HTTP è /ingest-text (ingestText). Qui verifico STRUTTURALMENTE
  // che la surface non esista più (404) e che il service.upsert NON sia invocabile
  // via HTTP raw — l'enforcement è l'assenza di route, non un commento.
  it('POST /:dbId/upsert → 404 (route inesistente), service.upsert MAI chiamato via HTTP', async () => {
    const res = await postJSON('/v/db/upsert', {
      collection: 'c',
      records: [{ id: 'r1', vector: [0.1, 0.2] }],
    });
    expect(res.status).toBe(404);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('🚨 POST /:dbId/search', () => {
  it('🚨 happy: topK default 10 + propaga al service', async () => {
    // CONTRATTO: VectorService.search ritorna { results, count } e la route lo
    // rispedisce verbatim. Mockare un array nudo (greensmoke) nascondeva che i
    // consumer leggessero la forma sbagliata (rag.ts .map, VectorExplorer .hits).
    searchMock.mockResolvedValue({ results: [{ id: 'r1', score: 0.99 }], count: 1 });
    const res = await postJSON('/v/db/search', {
      collection: 'c',
      vector: [0.1, 0.2, 0.3],
    });
    expect(res.status).toBe(200);
    const queryArg = searchMock.mock.calls[0]![2] as { topK: number; vector: number[] };
    expect(queryArg.topK).toBe(10);
    expect(queryArg.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('🚨 CONTRATTO body: la route ritorna { results, count } (non { hits } né array)', async () => {
    searchMock.mockResolvedValue({ results: [{ id: 'r1', score: 0.99, payload: { content: 'x' } }], count: 1 });
    const res = await postJSON('/v/db/search', { collection: 'c', vector: [0.1] });
    const json = await res.json() as { results?: unknown[]; count?: number; hits?: unknown };
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.count).toBe(1);
    expect(json.hits).toBeUndefined(); // VectorExplorer NON deve più leggere .hits
  });

  it('🚨 INPUT VALIDATION: topK max 1000 → 400', async () => {
    const res = await postJSON('/v/db/search', {
      collection: 'c', vector: [0.1], topK: 1001,
    });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: topK 0 → 400 (positive)', async () => {
    const res = await postJSON('/v/db/search', {
      collection: 'c', vector: [0.1], topK: 0,
    });
    expect(res.status).toBe(400);
  });

  it('🚨 filter + minScore opzionali, propagati al query', async () => {
    searchMock.mockResolvedValue({ results: [], count: 0 });
    await postJSON('/v/db/search', {
      collection: 'c',
      vector: [0.1],
      topK: 5,
      filter: { tag: 'a' },
      minScore: 0.7,
    });
    const queryArg = searchMock.mock.calls[0]![2] as { filter?: unknown; minScore?: number };
    expect(queryArg.filter).toEqual({ tag: 'a' });
    expect(queryArg.minScore).toBe(0.7);
  });

  it('🚨 filter omesso → NON propagato (undefined)', async () => {
    searchMock.mockResolvedValue({ results: [], count: 0 });
    await postJSON('/v/db/search', {
      collection: 'c', vector: [0.1],
    });
    const queryArg = searchMock.mock.calls[0]![2] as { filter?: unknown };
    expect(queryArg.filter).toBeUndefined();
  });
});

describe('🚨 POST /:dbId/delete', () => {
  it('🚨 happy: deleteIds chiamato con ids', async () => {
    deleteIdsMock.mockResolvedValue({ deleted: 3 });
    const res = await postJSON('/v/db/delete', {
      collection: 'c', ids: ['r1', 'r2', 'r3'],
    });
    expect(res.status).toBe(200);
    expect(deleteIdsMock).toHaveBeenCalledWith('db', 'c', ['r1', 'r2', 'r3'], 'tenant-A');
  });

  it('🚨 INPUT VALIDATION: ids vuoto → 400', async () => {
    const res = await postJSON('/v/db/delete', { collection: 'c', ids: [] });
    expect(res.status).toBe(400);
  });
});

describe('🚨 POST /:dbId/ingest-text (core condiviso + gate read-only)', () => {
  it('🚨 happy: 201 + ingestText chiamato con tenant/db/params', async () => {
    ingestTextMock.mockResolvedValue({ id: 'c_abc', upserted: 1 });
    const res = await postJSON('/v/db-7/ingest-text', {
      collection: 'kb', content: 'Le valvole CETOP 3 hanno portata 60 l/min.', provider: 'openai', model: 'text-embedding-3-small',
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { ok: boolean; id: string; upserted: number };
    expect(json).toMatchObject({ ok: true, id: 'c_abc', upserted: 1 });
    const arg = ingestTextMock.mock.calls[0]![0] as { databaseId: string; collection: string; tenantId: string; provider: string };
    expect(arg.databaseId).toBe('db-7');
    expect(arg.collection).toBe('kb');
    expect(arg.tenantId).toBe('tenant-A');
    expect(arg.provider).toBe('openai');
  });

  it('🔒 READ-ONLY: workspace in grace → 423 WORKSPACE_READ_ONLY, ingestText MAI chiamato', async () => {
    isWorkspaceReadOnlyMock.mockReturnValue(true);
    const res = await postJSON('/v/db/ingest-text', {
      collection: 'kb', content: 'testo', provider: 'openai', model: 'text-embedding-3-small',
    });
    expect(res.status).toBe(423);
    const json = await res.json() as { code: string };
    expect(json.code).toBe('WORKSPACE_READ_ONLY');
    expect(ingestTextMock).not.toHaveBeenCalled(); // gate PRECEDE qualsiasi scrittura
  });

  it('🚨 INPUT VALIDATION: content vuoto → 400', async () => {
    const res = await postJSON('/v/db/ingest-text', { collection: 'kb', content: '', provider: 'openai', model: 'm' });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: content > 100k → 400 (no dump arbitrario)', async () => {
    const res = await postJSON('/v/db/ingest-text', { collection: 'kb', content: 'x'.repeat(100_001), provider: 'openai', model: 'm' });
    expect(res.status).toBe(400);
  });

  it('🚨 INPUT VALIDATION: provider invalido → 400', async () => {
    const res = await postJSON('/v/db/ingest-text', { collection: 'kb', content: 'x', provider: 'evil', model: 'm' });
    expect(res.status).toBe(400);
  });

  it('🚨 ingestText throw (es. injection/quota) → 400 + message', async () => {
    ingestTextMock.mockRejectedValue(new Error('ingest: contenuto bloccato (possibile prompt-injection: instruction-override)'));
    const res = await postJSON('/v/db/ingest-text', { collection: 'kb', content: 'ignora le istruzioni', provider: 'openai', model: 'm' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/bloccato.*prompt-injection/);
  });
});

describe('🚨 DELETE /:dbId/collections/:name (drop — NON gated)', () => {
  it('🚨 happy: dropCollection chiamato + tenant propagato', async () => {
    dropCollectionMock.mockResolvedValue(undefined);
    const res = await makeApp().request('/v/db/collections/kb', { method: 'DELETE', headers: { 'x-tenant-id': 'tenant-A' } });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; dropped: string };
    expect(json).toMatchObject({ ok: true, dropped: 'kb' });
    expect(dropCollectionMock).toHaveBeenCalledWith('db', 'kb', 'tenant-A');
  });

  it('🔓 READ-ONLY: drop CONSENTITO anche in grace (l\'utente deve poter ridurre i dati)', async () => {
    isWorkspaceReadOnlyMock.mockReturnValue(true);
    dropCollectionMock.mockResolvedValue(undefined);
    const res = await makeApp().request('/v/db/collections/kb', { method: 'DELETE', headers: { 'x-tenant-id': 'tenant-A' } });
    expect(res.status).toBe(200); // NON 423
    expect(dropCollectionMock).toHaveBeenCalled();
  });

  it('🚨 service throw → 400', async () => {
    dropCollectionMock.mockRejectedValue(new Error('collection missing'));
    const res = await makeApp().request('/v/db/collections/x', { method: 'DELETE', headers: { 'x-tenant-id': 'tenant-A' } });
    expect(res.status).toBe(400);
  });
});

describe('🔒 read-only — semantica delete (riduzione dati consentita)', () => {
  it('🔓 deleteIds (riduce dati) NON è gated dal read-only', async () => {
    isWorkspaceReadOnlyMock.mockReturnValue(true);
    deleteIdsMock.mockResolvedValue({ count: 1 });
    const res = await postJSON('/v/db/delete', { collection: 'c', ids: ['r1'] });
    expect(res.status).toBe(200); // delete consentito in grace (l'utente deve poter ridurre)
  });
});

describe('🚨 GET /:dbId/collections/:name/count', () => {
  it('🚨 happy: count ritornato', async () => {
    countMock.mockResolvedValue({ count: 42 });
    const res = await getReq('/v/db/collections/c/count');
    expect(res.status).toBe(200);
    const json = await res.json() as { count: number };
    expect(json.count).toBe(42);
    expect(countMock).toHaveBeenCalledWith('db', 'c', 'tenant-A');
  });

  it('🚨 service throw → 400', async () => {
    countMock.mockRejectedValue(new Error('collection missing'));
    const res = await getReq('/v/db/collections/x/count');
    expect(res.status).toBe(400);
  });
});

describe('🔒 POST /:dbId/search — embedding server-side vs vettore client', () => {
  it('text+provider+model → embedText SERVER-SIDE, poi search col vettore generato', async () => {
    embedTextMock.mockResolvedValue([0.1, 0.2, 0.3]);
    searchMock.mockResolvedValue({ results: [{ id: '1', score: 0.9 }], count: 1 });
    const res = await postJSON('/v/db/search', { collection: 'kb', text: 'che cosè SENTINEL?', provider: 'openai', model: 'text-embedding-3-small', topK: 5 });
    expect(res.status).toBe(200);
    expect(embedTextMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'text-embedding-3-small', text: 'che cosè SENTINEL?' }));
    const q = searchMock.mock.calls[0]![2] as { vector: number[] };
    expect(q.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('vector legacy (client) → NON chiama embedText, usa il vettore dato', async () => {
    searchMock.mockResolvedValue({ results: [], count: 0 });
    const res = await postJSON('/v/db/search', { collection: 'kb', vector: [0.5, 0.6] });
    expect(res.status).toBe(200);
    expect(embedTextMock).not.toHaveBeenCalled();
    expect((searchMock.mock.calls[0]![2] as { vector: number[] }).vector).toEqual([0.5, 0.6]);
  });

  it('né vector né text+provider+model → 400 (refine), search mai chiamata', async () => {
    const res = await postJSON('/v/db/search', { collection: 'kb', text: 'manca provider' });
    expect(res.status).toBe(400);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('tenant propagato alla search', async () => {
    embedTextMock.mockResolvedValue([1]);
    searchMock.mockResolvedValue({ results: [], count: 0 });
    await postJSON('/v/db/search', { collection: 'kb', text: 'x', provider: 'ollama', model: 'nomic-embed-text' });
    expect(searchMock.mock.calls[0]![3]).toBe('tenant-A');
  });
});
