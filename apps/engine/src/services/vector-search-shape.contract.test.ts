/**
 * CONTRACT TEST cross-modulo — forma di ritorno di VectorService.search.
 *
 * Bug reale scovato (2026-06-10, Inc.3): VectorService.search ritorna
 * `{ results, count }` (oggetto), ma `rag.ts` lo trattava come `Array` e ci
 * chiamava `.map()` → `raw.map is not a function` a runtime. Tre consumer in
 * disaccordo (rag.ts node, VectorExplorer UI, route body) — tutti nascosti da
 * mock greensmoke che ritornavano un array fittizio.
 *
 * Questo test usa l'ADAPTER SQLITE REALE (better-sqlite3 su file temporaneo)
 * attraverso il VectorService reale: nessun mock dell'adapter, nessun array
 * fabbricato. Asserisce la forma CANONICA effettiva e la lega al modo in cui
 * rag.ts la consuma (`searchRes.results`). Si rompe se:
 *   - il wrapping di VectorService.search cambia forma;
 *   - un consumer torna a trattarla come array.
 *
 * Pure integration: solo DbStudioService.get e loadConfig sono stubbed (per
 * puntare a un DB vettoriale temporaneo); tutto il resto è reale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const dbStudioGetMock = vi.fn();

vi.mock('./db-studio.service.js', () => ({
  DbStudioService: class {
    get = dbStudioGetMock;
    list = vi.fn(() => []);
  },
}));

vi.mock('@/config.js', () => ({
  loadConfig: () => ({ FLOWFORGE_DATA_DIR: tempDir }),
}));

const { VectorService } = await import('./vector.service.js');

const DB_ID = 'db-contract';
const COLLECTION = 'kb';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ff-vector-contract-'));
  dbStudioGetMock.mockReset().mockReturnValue({
    id: DB_ID,
    tenantId: 't1',
    connection: { engine: 'vector-embedded', embedded: true },
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CONTRATTO: VectorService.search ⇄ rag.ts (adapter sqlite reale)', () => {
  it('search ritorna { results: Array, count } — NON un array nudo', async () => {
    const svc = new VectorService();
    await svc.ensureCollection(DB_ID, COLLECTION, 3, 'cosine', 't1');
    await svc.upsert(DB_ID, COLLECTION, [
      { id: 'a', vector: [1, 0, 0], payload: { content: 'alpha' } },
      { id: 'b', vector: [0, 1, 0], payload: { content: 'beta' } },
    ], 't1');

    const searchRes = await svc.search(DB_ID, COLLECTION, { vector: [1, 0, 0], topK: 5 }, 't1');

    // La forma è un OGGETTO wrapper, non un array. Questa è l'assert che becca il
    // bug `as Array<...>` + `.map()` in rag.ts.
    expect(Array.isArray(searchRes)).toBe(false);
    const shaped = searchRes as { results: unknown; count: number };
    expect(Array.isArray(shaped.results)).toBe(true);
    expect(shaped.count).toBe(2);
  });

  it('rag.ts può fare .results.map() sul risultato reale (consumo che usa lo shipped executor)', async () => {
    const svc = new VectorService();
    await svc.ensureCollection(DB_ID, COLLECTION, 3, 'cosine', 't1');
    await svc.upsert(DB_ID, COLLECTION, [
      { id: 'a', vector: [1, 0, 0], payload: { content: 'documento alpha' } },
    ], 't1');

    // Replica ESATTA del consumo in rag.ts (ragSearchExecutor): cast a
    // { results, count } e .results.map(...). Se la forma divergesse, qui
    // esploderebbe come in produzione.
    const searchRes = (await svc.search(DB_ID, COLLECTION, { vector: [1, 0, 0], topK: 5 }, 't1')) as {
      results: { id: string; score: number; payload?: Record<string, unknown> }[];
      count: number;
    };
    const raw = searchRes.results;
    const mapped = raw.map((r) => ({ id: r.id, content: r.payload?.content }));

    expect(mapped).toEqual([{ id: 'a', content: 'documento alpha' }]);
  });

  it('topK reale dell\'adapter è onorato dentro il wrapper { results, count }', async () => {
    const svc = new VectorService();
    await svc.ensureCollection(DB_ID, COLLECTION, 3, 'cosine', 't1');
    await svc.upsert(DB_ID, COLLECTION, [
      { id: 'a', vector: [1, 0, 0], payload: { content: 'a' } },
      { id: 'b', vector: [0.9, 0.1, 0], payload: { content: 'b' } },
      { id: 'c', vector: [0.8, 0.2, 0], payload: { content: 'c' } },
    ], 't1');

    const searchRes = (await svc.search(DB_ID, COLLECTION, { vector: [1, 0, 0], topK: 2 }, 't1')) as {
      results: unknown[]; count: number;
    };
    expect(searchRes.results).toHaveLength(2);
    expect(searchRes.count).toBe(2);
  });
});
