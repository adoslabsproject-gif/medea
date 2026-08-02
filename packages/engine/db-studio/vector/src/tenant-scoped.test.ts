/**
 * Isolation test — TenantScopedVectorStore.
 *
 * Obiettivo: PROVARE l'isolamento violandolo. Due tenant condividono LO STESSO
 * backend reale (EmbeddedVectorAdapter :memory:) e si verifica che nessuno possa
 * leggere/cancellare/contare/elencare le collection dell'altro, e che nessun nome
 * collection malevolo possa forgiare il namespace altrui.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddedVectorAdapter } from './embedded.js';
import { TenantScopedVectorStore, TenantIsolationError } from './tenant-scoped.js';
import type { IVectorAdapter } from './types.js';

const DIM = 4;
const vec = (seed: number): number[] => [seed, seed + 1, seed + 2, seed + 3];

describe('TenantScopedVectorStore — isolamento su backend condiviso', () => {
  let backend: EmbeddedVectorAdapter;
  let tenantA: TenantScopedVectorStore;
  let tenantB: TenantScopedVectorStore;

  beforeEach(async () => {
    backend = new EmbeddedVectorAdapter(':memory:');
    tenantA = new TenantScopedVectorStore(backend, 'tenant-aaa');
    tenantB = new TenantScopedVectorStore(backend, 'tenant-bbb');
    // entrambi creano una collection con lo STESSO nome "docs"
    await tenantA.ensureCollection('docs', DIM, 'cosine');
    await tenantB.ensureCollection('docs', DIM, 'cosine');
    await tenantA.upsert('docs', [{ id: 'a1', vector: vec(1), payload: { owner: 'A' } }]);
    await tenantB.upsert('docs', [{ id: 'b1', vector: vec(9), payload: { owner: 'B' } }]);
  });

  it('A e B con la stessa collection "docs" NON si vedono i record a vicenda', async () => {
    const aResults = await tenantA.search('docs', { vector: vec(1), topK: 10 });
    const bResults = await tenantB.search('docs', { vector: vec(9), topK: 10 });
    expect(aResults.map((r) => r.id)).toEqual(['a1']);
    expect(bResults.map((r) => r.id)).toEqual(['b1']);
    expect(aResults.some((r) => r.id === 'b1')).toBe(false);
    expect(bResults.some((r) => r.id === 'a1')).toBe(false);
  });

  it('count è per-tenant', async () => {
    expect(await tenantA.countCollection('docs')).toBe(1);
    expect(await tenantB.countCollection('docs')).toBe(1);
  });

  it('listCollections mostra SOLO le collection del tenant, senza prefisso', async () => {
    const aList = await tenantA.listCollections();
    const bList = await tenantB.listCollections();
    expect(aList.map((c) => c.name)).toEqual(['docs']);
    expect(bList.map((c) => c.name)).toEqual(['docs']);
    // il backend grezzo invece vede ENTRAMBE namespaced
    const raw = await backend.listCollections();
    expect(raw.map((c) => c.name).sort()).toEqual(['tenant-aaa::docs', 'tenant-bbb::docs']);
  });

  it('A che cancella "docs" NON tocca i dati di B', async () => {
    await tenantA.deleteByIds('docs', ['a1']);
    expect(await tenantA.countCollection('docs')).toBe(0);
    expect(await tenantB.countCollection('docs')).toBe(1); // B intatto
    await tenantA.dropCollection('docs');
    expect(await tenantB.countCollection('docs')).toBe(1); // drop di A non tocca B
  });
});

describe('TenantScopedVectorStore — anti-forgiatura del namespace', () => {
  const backend = new EmbeddedVectorAdapter(':memory:');

  it('un nome collection con "::" è RIFIUTATO (no escape verso altri tenant)', async () => {
    const a = new TenantScopedVectorStore(backend, 'tenant-aaa');
    await expect(a.ensureCollection('tenant-bbb::docs', DIM, 'cosine')).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(a.search('tenant-bbb::docs', { vector: vec(1) })).rejects.toThrow(/non valido/);
    await expect(a.countCollection('x::y')).rejects.toThrow(TenantIsolationError);
  });

  it('nomi collection con caratteri fuori whitelist rifiutati (path traversal, spazi, ecc.)', async () => {
    const a = new TenantScopedVectorStore(backend, 'tenant-aaa');
    for (const bad of ['../escape', 'a b', 'drop;table', '', 'x'.repeat(65), 'name.with.dot']) {
      await expect(a.countCollection(bad)).rejects.toThrow(TenantIsolationError);
    }
  });

  it('tenantId non valido al costruttore è RIFIUTATO', () => {
    expect(() => new TenantScopedVectorStore(backend as IVectorAdapter, 'evil::tenant')).toThrow(
      TenantIsolationError,
    );
    expect(() => new TenantScopedVectorStore(backend as IVectorAdapter, '')).toThrow(
      TenantIsolationError,
    );
    expect(() => new TenantScopedVectorStore(backend as IVectorAdapter, 'a/b')).toThrow(
      TenantIsolationError,
    );
  });

  it('engine del wrapper riflette il backend (drop-in trasparente)', () => {
    const a = new TenantScopedVectorStore(backend, 'tenant-aaa');
    expect(a.engine).toBe('vector-embedded');
  });
});

describe('TenantScopedVectorStore — existsById isolato', () => {
  it('existsById vede SOLO i record del proprio tenant', async () => {
    const backend = new EmbeddedVectorAdapter(':memory:');
    const a = new TenantScopedVectorStore(backend, 'tenant-aaa');
    const b = new TenantScopedVectorStore(backend, 'tenant-bbb');
    await a.ensureCollection('docs', DIM, 'cosine');
    await a.upsert('docs', [{ id: 'x1', vector: vec(1) }]);
    expect(await a.existsById('docs', 'x1')).toBe(true);
    expect(await b.existsById('docs', 'x1')).toBe(false); // B non vede l'id di A
  });
});
