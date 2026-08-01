/**
 * Test 2026-grade — VectorService (embedded SQLite + Qdrant adapters).
 *
 * ROUTING: vector-embedded → EmbeddedVectorAdapter (local sqlite path).
 *          qdrant → QdrantVectorAdapter (HTTP baseUrl).
 * CACHING: adapter cached per databaseId (no reconnect ad ogni op).
 * GUARDS: engine non-vector → throw esplicito.
 */
import type * as FsNS from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const adapterMock = {
  connect: vi.fn(),
  ensureCollection: vi.fn().mockResolvedValue(undefined),
  listCollections: vi.fn().mockResolvedValue([]),
  upsert: vi.fn().mockResolvedValue({ count: 0 }),
  search: vi.fn().mockResolvedValue([]),
  countCollection: vi.fn().mockResolvedValue(0),
  deleteByIds: vi.fn().mockResolvedValue({ count: 0 }),
  dropCollection: vi.fn().mockResolvedValue(undefined),
};

const EmbeddedAdapterMock = vi.fn(() => adapterMock);
const QdrantAdapterMock = vi.fn(() => adapterMock);

vi.mock('@flowforge/db-studio-vector', () => ({
  EmbeddedVectorAdapter: EmbeddedAdapterMock,
  QdrantVectorAdapter: QdrantAdapterMock,
}));

const dbStudioGetMock = vi.fn();
class DbStudioServiceMock {
  get = dbStudioGetMock;
}
vi.mock('./db-studio.service.js', () => ({
  DbStudioService: DbStudioServiceMock,
}));

vi.mock('@/config.js', () => ({
  loadConfig: () => ({ FLOWFORGE_DATA_DIR: '/tmp/ff-vector-test' }),
}));

vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof FsNS>('node:fs');
  return { ...real, existsSync: () => true, mkdirSync: vi.fn() };
});

const { VectorService } = await import('./vector.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 resolveAdapter — guards', () => {
  it('🚨 db not found → throw', async () => {
    dbStudioGetMock.mockReturnValueOnce(null);
    await expect(new VectorService().ensureCollection('db-x', 'c', 1536, 'cosine'))
      .rejects.toThrow(/not found/u);
  });

  it('🚨 engine NON vector → throw esplicito', async () => {
    dbStudioGetMock.mockReturnValueOnce({
      id: 'db-y', connection: { engine: 'postgres', url: 'postgres://' },
    });
    await expect(new VectorService().ensureCollection('db-y', 'c', 768, 'cosine'))
      .rejects.toThrow(/not a vector engine/u);
  });

  it('🚨 engine vector-embedded → EmbeddedVectorAdapter creato + connect', async () => {
    dbStudioGetMock.mockReturnValue({
      id: 'db-emb', connection: { engine: 'vector-embedded' },
    });
    const svc = new VectorService();
    await svc.ensureCollection('db-emb', 'col', 1536, 'cosine');
    expect(EmbeddedAdapterMock).toHaveBeenCalled();
    expect(adapterMock.connect).toHaveBeenCalled();
  });

  it('🚨 engine qdrant senza URL → throw', async () => {
    dbStudioGetMock.mockReturnValueOnce({
      id: 'db-q', connection: { engine: 'qdrant' },
    });
    await expect(new VectorService().ensureCollection('db-q', 'c', 1536, 'cosine'))
      .rejects.toThrow(/requires connection\.url/u);
  });

  it('🚨 engine qdrant con URL + apiKey from passwordSecretRef', async () => {
    dbStudioGetMock.mockReturnValue({
      id: 'db-q', connection: {
        engine: 'qdrant', url: 'http://qdrant:6333', passwordSecretRef: 'secret-api-key',
      },
    });
    await new VectorService().ensureCollection('db-q', 'c', 1536, 'cosine');
    expect(QdrantAdapterMock).toHaveBeenCalledWith({
      baseUrl: 'http://qdrant:6333',
      apiKey: 'secret-api-key',
    });
  });
});

describe('🚨 adapter cache', () => {
  it('🚨 2x call stesso db → adapter cached (no re-init)', async () => {
    dbStudioGetMock.mockReturnValue({
      id: 'db-cache', connection: { engine: 'vector-embedded' },
    });
    const svc = new VectorService();
    await svc.ensureCollection('db-cache', 'c1', 1536, 'cosine');
    await svc.ensureCollection('db-cache', 'c2', 768, 'euclidean');
    expect(EmbeddedAdapterMock).toHaveBeenCalledTimes(1);
  });
});

describe('🚨 forwarding API', () => {
  beforeEach(() => {
    dbStudioGetMock.mockReturnValue({
      id: 'db', connection: { engine: 'vector-embedded' },
    });
  });

  it('🚨 ensureCollection(name, dim, distance) forwarded', async () => {
    await new VectorService().ensureCollection('db', 'mycol', 1024, 'dot');
    expect(adapterMock.ensureCollection).toHaveBeenCalledWith('mycol', 1024, 'dot');
  });

  it('🚨 listCollections delegated', async () => {
    adapterMock.listCollections.mockResolvedValueOnce([
      { name: 'a', dimensions: 1536, distance: 'cosine', count: 10 },
    ]);
    const r = await new VectorService().listCollections('db');
    expect(r).toHaveLength(1);
  });

  it('🚨 upsert records forwarded', async () => {
    adapterMock.upsert.mockResolvedValueOnce({ count: 2 });
    const r = await new VectorService().upsert('db', 'col', [
      { id: '1', vector: [0.1, 0.2] }, { id: '2', vector: [0.3, 0.4] },
    ]);
    expect(r).toEqual({ count: 2 });
    expect(adapterMock.upsert).toHaveBeenCalledWith('col', expect.any(Array));
  });

  it('🚨 search wraps {results, count}', async () => {
    adapterMock.search.mockResolvedValueOnce([{ id: '1', score: 0.99 }]);
    const r = await new VectorService().search('db', 'col', { vector: [0.1], topK: 5 });
    expect(r).toEqual({ results: [{ id: '1', score: 0.99 }], count: 1 });
  });

  it('🚨 count → {count}', async () => {
    adapterMock.countCollection.mockResolvedValueOnce(42);
    expect(await new VectorService().count('db', 'col')).toEqual({ count: 42 });
  });

  it('🚨 deleteIds forwarded', async () => {
    await new VectorService().deleteIds('db', 'col', ['a', 'b']);
    expect(adapterMock.deleteByIds).toHaveBeenCalledWith('col', ['a', 'b']);
  });

  it('🚨 dropCollection forwarded', async () => {
    await new VectorService().dropCollection('db', 'col');
    expect(adapterMock.dropCollection).toHaveBeenCalledWith('col');
  });
});
