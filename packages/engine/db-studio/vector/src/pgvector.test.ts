/**
 * Integration test (Postgres reale + pgvector) — PgVectorAdapter.
 *
 * Esegue il KNN nativo pgvector su un DB temporaneo. Bug-hunting: ordinamento per
 * similarità reale, enforcement dimensioni su upsert E search, filtro payload,
 * cascade drop, count/list. Richiede Postgres locale + estensione vector.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { PgVectorAdapter } from './pgvector.js';

const USER = process.env.USER ?? 'postgres';
const adminCfg = () => (process.env.MEDEA_TEST_PG_URL
  ? { connectionString: process.env.MEDEA_TEST_PG_URL }
  : { host: '/tmp', database: 'postgres', user: USER });

let dbName: string;
let client: Client;
let adapter: PgVectorAdapter;

beforeAll(async () => {
  dbName = `vsx_test_${randomBytes(4).toString('hex')}`;
  const admin = new Client(adminCfg());
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  client = new Client({ ...adminCfg(), database: dbName });
  await client.connect();
  adapter = new PgVectorAdapter(client); // pg.Client soddisfa SqlExecutor
}, 30_000);

afterAll(async () => {
  if (client) await client.end();
  const admin = new Client(adminCfg());
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

beforeEach(async () => {
  await client.query('DROP TABLE IF EXISTS vs_records, vs_collections CASCADE').catch(() => {});
  // reset stato init dell'adapter (ricrea tabelle al prossimo uso)
  adapter = new PgVectorAdapter(client);
});

describe('PgVectorAdapter — collection lifecycle', () => {
  it('ensureCollection idempotente + listCollections', async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
    await adapter.ensureCollection('docs', 3, 'cosine'); // no-op
    const list = await adapter.listCollections();
    expect(list).toEqual([{ name: 'docs', dimensions: 3, distance: 'cosine', count: 0 }]);
    expect(adapter.engine).toBe('pgvector');
  });

  it('upsert su collection inesistente → errore esplicito', async () => {
    await expect(adapter.upsert('ghost', [{ id: 'x', vector: [1, 2, 3] }])).rejects.toThrow(/does not exist/);
  });
});

describe('PgVectorAdapter — dimension enforcement (bug-hunt)', () => {
  beforeEach(async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
  });

  it('upsert con dimensione errata → rifiutato PRIMA di scrivere (fail-fast)', async () => {
    await expect(adapter.upsert('docs', [{ id: 'a', vector: [1, 2, 3, 4] }])).rejects.toThrow(/dimensions mismatch/);
    expect(await adapter.countCollection('docs')).toBe(0); // niente scrittura parziale
  });

  it('search con dimensione query errata → rifiutato', async () => {
    await adapter.upsert('docs', [{ id: 'a', vector: [1, 0, 0] }]);
    await expect(adapter.search('docs', { vector: [1, 0] })).rejects.toThrow(/dimensions mismatch/);
  });
});

describe('PgVectorAdapter — KNN cosine reale', () => {
  beforeEach(async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
    await adapter.upsert('docs', [
      { id: 'identical', vector: [1, 0, 0], payload: { lang: 'it' } },
      { id: 'close', vector: [0.9, 0.1, 0], payload: { lang: 'it' } },
      { id: 'orthogonal', vector: [0, 1, 0], payload: { lang: 'en' } },
    ]);
  });

  it('ordina per similarità: identico > vicino > ortogonale', async () => {
    const res = await adapter.search('docs', { vector: [1, 0, 0], topK: 3 });
    expect(res.map((r) => r.id)).toEqual(['identical', 'close', 'orthogonal']);
    expect(res[0]!.score).toBeCloseTo(1, 5); // cosine sim 1 per identico
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
    expect(res[1]!.score).toBeGreaterThan(res[2]!.score);
  });

  it('topK limita i risultati', async () => {
    const res = await adapter.search('docs', { vector: [1, 0, 0], topK: 1 });
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe('identical');
  });

  it('minScore filtra i risultati a bassa similarità', async () => {
    const res = await adapter.search('docs', { vector: [1, 0, 0], topK: 10, minScore: 0.5 });
    expect(res.map((r) => r.id)).toEqual(['identical', 'close']); // orthogonal (sim 0) escluso
  });

  it('filter payload: solo i record che combaciano', async () => {
    const res = await adapter.search('docs', { vector: [1, 0, 0], topK: 10, filter: { lang: 'en' } });
    expect(res.map((r) => r.id)).toEqual(['orthogonal']);
  });

  it('payload ritornato; il vettore NON è rispedito (hot path: lavoro sprecato)', async () => {
    const res = await adapter.search('docs', { vector: [1, 0, 0], topK: 1 });
    expect(res[0]!.payload).toEqual({ lang: 'it' });
    expect(res[0]!.vector).toBeUndefined();
  });
});

describe('PgVectorAdapter — delete, count, cascade drop', () => {
  beforeEach(async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
    await adapter.upsert('docs', [
      { id: 'a', vector: [1, 0, 0] },
      { id: 'b', vector: [0, 1, 0] },
    ]);
  });

  it('deleteByIds rimuove solo gli id indicati', async () => {
    const { count } = await adapter.deleteByIds('docs', ['a']);
    expect(count).toBe(1);
    expect(await adapter.countCollection('docs')).toBe(1);
  });

  it('upsert sullo stesso id aggiorna (no duplicati)', async () => {
    await adapter.upsert('docs', [{ id: 'a', vector: [0.5, 0.5, 0], payload: { v: 2 } }]);
    expect(await adapter.countCollection('docs')).toBe(2); // a aggiornato, non duplicato
    const res = await adapter.search('docs', { vector: [0.5, 0.5, 0], topK: 1 });
    expect(res[0]!.payload).toEqual({ v: 2 });
  });

  it('dropCollection cancella la collection E i record (cascade FK)', async () => {
    await adapter.dropCollection('docs');
    expect(await adapter.listCollections()).toEqual([]);
    const { rows } = await client.query('SELECT count(*)::int AS c FROM vs_records');
    expect(rows[0].c).toBe(0); // cascade ha pulito i record
  });
});

describe('PgVectorAdapter — upsert atomico (multi-row, no scritture parziali)', () => {
  beforeEach(async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
  });

  it('batch multi-record: tutti inseriti in una sola INSERT', async () => {
    const { count } = await adapter.upsert('docs', [
      { id: 'a', vector: [1, 0, 0] },
      { id: 'b', vector: [0, 1, 0] },
      { id: 'c', vector: [0, 0, 1] },
    ]);
    expect(count).toBe(3);
    expect(await adapter.countCollection('docs')).toBe(3);
  });

  it('ATOMICITÀ: un batch che fallisce (id duplicato nello stesso INSERT) non scrive NULLA', async () => {
    await adapter.upsert('docs', [{ id: 'pre', vector: [1, 1, 1] }]);
    // due record con lo stesso id nello stesso batch → ON CONFLICT non può toccare
    // due volte la stessa riga → l'INTERA INSERT fallisce → atomico, nessun parziale.
    await expect(
      adapter.upsert('docs', [
        { id: 'new1', vector: [1, 0, 0] },
        { id: 'dup', vector: [0, 1, 0] },
        { id: 'dup', vector: [0, 0, 1] },
      ]),
    ).rejects.toThrow();
    // 'new1' NON deve essere stato scritto (atomicità): resta solo 'pre'
    expect(await adapter.countCollection('docs')).toBe(1);
    const all = await client.query('SELECT id FROM vs_records ORDER BY id');
    expect(all.rows.map((r) => r.id)).toEqual(['pre']);
  });

  it('upsert vuoto → no-op (count 0, nessuna query di scrittura)', async () => {
    const { count } = await adapter.upsert('docs', []);
    expect(count).toBe(0);
  });
});

describe('PgVectorAdapter — existsById (per net-add quota)', () => {
  beforeEach(async () => {
    await adapter.ensureCollection('docs', 3, 'cosine');
    await adapter.upsert('docs', [{ id: 'present', vector: [1, 0, 0] }]);
  });
  it('true per id esistente, false per assente', async () => {
    expect(await adapter.existsById('docs', 'present')).toBe(true);
    expect(await adapter.existsById('docs', 'ghost')).toBe(false);
  });
});
