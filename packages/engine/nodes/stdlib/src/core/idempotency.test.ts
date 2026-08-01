import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryIdempotencyStore, makeIdempotencyKey } from './idempotency.js';

describe('InMemoryIdempotencyStore', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  it('first acquire on fresh key returns acquired=true', async () => {
    const r = await store.acquire('k1', 60_000);
    expect(r.acquired).toBe(true);
    expect(r.previousOutput).toBeUndefined();
  });

  it('second acquire after complete returns previousOutput', async () => {
    await store.acquire('k1', 60_000);
    await store.complete('k1', { result: 42 });
    const r = await store.acquire('k1', 60_000);
    expect(r.acquired).toBe(false);
    expect(r.previousOutput).toEqual({ result: 42 });
    expect(r.previousAt).toBeTypeOf('number');
  });

  it('second acquire BEFORE complete returns acquired=false without previousOutput (in-flight)', async () => {
    await store.acquire('k1', 60_000);
    const r = await store.acquire('k1', 60_000);
    expect(r.acquired).toBe(false);
    expect(r.previousOutput).toBeUndefined();
    expect(r.previousAt).toBeTypeOf('number');
  });

  it('release frees the key for re-acquire', async () => {
    await store.acquire('k1', 60_000);
    await store.release('k1');
    const r = await store.acquire('k1', 60_000);
    expect(r.acquired).toBe(true);
  });

  it('expired entry is re-acquirable', async () => {
    await store.acquire('k1', 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    const r = await store.acquire('k1', 60_000);
    expect(r.acquired).toBe(true);
  });

  it('complete on never-acquired key is no-op (does not crash)', async () => {
    await store.complete('ghost', { x: 1 });
    // Subsequent acquire still works
    const r = await store.acquire('ghost', 60_000);
    expect(r.acquired).toBe(true);
  });

  it('size reflects entries (post-prune)', async () => {
    await store.acquire('k1', 60_000);
    await store.acquire('k2', 60_000);
    expect(await store.size()).toBe(2);
    await store.release('k1');
    expect(await store.size()).toBe(1);
  });

  it('clear empties store', async () => {
    await store.acquire('k1', 60_000);
    await store.acquire('k2', 60_000);
    store.clear();
    expect(await store.size()).toBe(0);
  });

  it('different keys are independent', async () => {
    await store.acquire('k1', 60_000);
    const r = await store.acquire('k2', 60_000);
    expect(r.acquired).toBe(true);
  });

  it('100 sequential ops trigger internal prune without crash', async () => {
    for (let i = 0; i < 105; i += 1) {
      await store.acquire(`k${String(i)}`, 60_000);
    }
    expect(await store.size()).toBe(105);
  });
});

describe('makeIdempotencyKey (tenantId-aware v3.0)', () => {
  it('joins tenantId + runId + nodeId by colon (multi-tenant safe)', () => {
    expect(makeIdempotencyKey('t1', 'r1', 'n1')).toBe('t1:r1:n1');
  });

  it('appends sub-keys per item-level lock', () => {
    expect(makeIdempotencyKey('t1', 'r1', 'n1', 'item', 'h42')).toBe('t1:r1:n1:item:h42');
  });

  it('handles diversi tenant con stesso run+node id (collision-safe)', () => {
    const tenantA = makeIdempotencyKey('tenantA', 'r1', 'n1');
    const tenantB = makeIdempotencyKey('tenantB', 'r1', 'n1');
    expect(tenantA).not.toBe(tenantB);
  });
});

describe('makeIdempotencyKeyLegacy (deprecated, back-compat)', () => {
  // Test della funzione deprecated mantenuta per backward-compat single-tenant.
  // Il warning @typescript-eslint/no-deprecated qui è ATTESO (testiamo proprio
  // la funzione deprecated). Disable mirato giustificato.
  /* eslint-disable @typescript-eslint/no-deprecated -- test specifico della funzione deprecated stessa */
  it('joins runId+nodeId senza tenant prefix', async () => {
    const { makeIdempotencyKeyLegacy } = await import('./idempotency.js');
    expect(makeIdempotencyKeyLegacy('r1', 'n1')).toBe('r1:n1');
    expect(makeIdempotencyKeyLegacy('r1', 'n1', 'sub')).toBe('r1:n1:sub');
  });
  /* eslint-enable @typescript-eslint/no-deprecated */
});
