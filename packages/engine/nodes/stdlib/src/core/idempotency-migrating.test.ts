import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigratingIdempotencyStore } from './idempotency-migrating.js';
import { InMemoryIdempotencyStore } from './idempotency.js';

describe('MigratingIdempotencyStore', () => {
  let previous: InMemoryIdempotencyStore;
  let next: InMemoryIdempotencyStore;
  let migrating: MigratingIdempotencyStore;

  beforeEach(() => {
    previous = new InMemoryIdempotencyStore();
    next = new InMemoryIdempotencyStore();
    migrating = new MigratingIdempotencyStore({ previous, next });
  });

  describe('acquire — read-first sul next + claim dual', () => {
    it('chiave fresca: acquired=true, claim su ENTRAMBI gli store', async () => {
      const r = await migrating.acquire('k1', 60_000);
      expect(r.acquired).toBe(true);
      // Verifica claim su entrambi — secondo acquire diretto sui sotto-store fail
      const nextSecond = await next.acquire('k1', 60_000);
      const prevSecond = await previous.acquire('k1', 60_000);
      expect(nextSecond.acquired).toBe(false);
      expect(prevSecond.acquired).toBe(false);
    });

    it('next gia` ha output: ritorna direttamente da next', async () => {
      await next.acquire('k1', 60_000);
      await next.complete('k1', { from: 'next' });
      const r = await migrating.acquire('k1', 60_000);
      expect(r.acquired).toBe(false);
      expect(r.previousOutput).toEqual({ from: 'next' });
    });

    it('previous ha output legacy + next vuoto: warm-up nel next', async () => {
      // Setup: previous ha l'output legacy
      await previous.acquire('k1', 60_000);
      await previous.complete('k1', { from: 'legacy' });
      // Migrating acquire: next vuoto → acquired SU next → poi fallback previous
      const r = await migrating.acquire('k1', 60_000);
      expect(r.acquired).toBe(false); // restituisce legacy output
      expect(r.previousOutput).toEqual({ from: 'legacy' });
      // Verifica warm-up: next ora ha l'output replicato
      const fromNext = await next.acquire('k1', 60_000);
      expect(fromNext.previousOutput).toEqual({ from: 'legacy' });
    });
  });

  describe('complete — dual write', () => {
    it('scrive su entrambi gli store', async () => {
      await migrating.acquire('k1', 60_000);
      await migrating.complete('k1', { result: 42 });
      const fromNext = await next.acquire('k1', 60_000);
      const fromPrev = await previous.acquire('k1', 60_000);
      expect(fromNext.previousOutput).toEqual({ result: 42 });
      expect(fromPrev.previousOutput).toEqual({ result: 42 });
    });

    it('errore su previous NON blocca complete su next + invoca onAsymmetry', async () => {
      const onAsymmetry = vi.fn();
      const failingPrev: typeof previous = {
        acquire: async () => ({ acquired: true }),
        complete: async () => { throw new Error('previous down'); },
        release: async () => {},
        size: async () => 0,
      } as never;
      const m = new MigratingIdempotencyStore({ previous: failingPrev, next, onAsymmetry });
      await m.acquire('k1', 60_000);
      await m.complete('k1', { x: 1 });
      const fromNext = await next.acquire('k1', 60_000);
      expect(fromNext.previousOutput).toEqual({ x: 1 });
      expect(onAsymmetry).toHaveBeenCalledWith('complete', 'k1', expect.any(Error), 'previous');
    });
  });

  describe('release — dual delete', () => {
    it('rimuove da entrambi gli store', async () => {
      await migrating.acquire('k1', 60_000);
      await migrating.complete('k1', 'x');
      await migrating.release('k1');
      const r1 = await next.acquire('k1', 60_000);
      const r2 = await previous.acquire('k1', 60_000);
      expect(r1.acquired).toBe(true);
      expect(r2.acquired).toBe(true);
    });
  });

  describe('size — max dei due (approssimazione informativa)', () => {
    it('ritorna il MAX', async () => {
      await previous.acquire('k1', 60_000);
      await previous.acquire('k2', 60_000);
      await next.acquire('k3', 60_000);
      expect(await migrating.size()).toBe(2);
    });

    it('size catch su side errore, non propaga', async () => {
      const failingPrev: typeof previous = {
        acquire: async () => ({ acquired: true }),
        complete: async () => {},
        release: async () => {},
        size: async () => { throw new Error('boom'); },
      } as never;
      const m = new MigratingIdempotencyStore({ previous: failingPrev, next });
      await next.acquire('k1', 60_000);
      expect(await m.size()).toBe(1);
    });
  });

  describe('Strangler Fig pattern — scenario reale', () => {
    it('migration window: in-mem populated → swap a Redis-backed → no replay', async () => {
      // T0: storico nel previous (in-memory live prima del deploy)
      await previous.acquire('legacy-run:legacy-node', 60_000);
      await previous.complete('legacy-run:legacy-node', { externalOrderId: 'ORD-001' });

      // T1: deploy con MigratingStore wrapping next (Redis fresh)
      // Workflow runtime retried per network blip — chiede acquire stesso key
      const replay = await migrating.acquire('legacy-run:legacy-node', 60_000);

      // ✅ NO doppio-POST: vede l'output legacy + lo replica su next
      expect(replay.acquired).toBe(false);
      expect(replay.previousOutput).toEqual({ externalOrderId: 'ORD-001' });

      // T2: anche un retry post-cutover sul next (previous purged) ha cache
      previous.clear();
      const postCutover = await migrating.acquire('legacy-run:legacy-node', 60_000);
      expect(postCutover.acquired).toBe(false);
      expect(postCutover.previousOutput).toEqual({ externalOrderId: 'ORD-001' });
    });
  });
});
