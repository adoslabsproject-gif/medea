import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreakerIdempotencyStore } from './idempotency-circuit-breaker.js';
import type { IdempotencyStore } from '@medea/engine-nodes-stdlib';

function makeFlakeyStore(failuresFirst: number) {
  let calls = 0;
  return {
    store: {
      acquire: vi.fn(async () => {
        calls += 1;
        if (calls <= failuresFirst) throw new Error('redis: timeout');
        return { acquired: true };
      }),
      complete: vi.fn(async () => { /* no-op */ }),
      release: vi.fn(async () => { /* no-op */ }),
      size: vi.fn(async () => 0),
    } as unknown as IdempotencyStore,
    getCalls: () => calls,
  };
}

describe('CircuitBreakerIdempotencyStore', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      return 0.5; // deterministico per jitter del breaker
    });
  });

  describe('happy path', () => {
    it('delega acquire al inner store quando breaker CLOSED', async () => {
      const { store, getCalls } = makeFlakeyStore(0);
      const cb = new CircuitBreakerIdempotencyStore(store, { breakerName: 'test-happy' });
      const r = await cb.acquire('k1', 60_000);
      expect(r.acquired).toBe(true);
      expect(getCalls()).toBe(1);
      expect(cb.getBreakerState()).toBe('closed');
    });

    it('complete/release/size delegano correttamente', async () => {
      const { store } = makeFlakeyStore(0);
      const cb = new CircuitBreakerIdempotencyStore(store, { breakerName: 'test-delegate' });
      await cb.complete('k', { x: 1 });
      await cb.release('k');
      const size = await cb.size();
      expect(size).toBe(0);
      expect((store.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('k', { x: 1 });
    });
  });

  describe('fail-fast su breaker OPEN', () => {
    it('dopo 5 failures consecutivi → breaker OPEN → acquire ritorna fast-fail (no wait inner)', async () => {
      const { store, getCalls } = makeFlakeyStore(100); // always fails
      const cb = new CircuitBreakerIdempotencyStore(store, {
        breakerName: 'test-fastfail',
        failureThreshold: 5,
      });

      // 5 failures consecutive — breaker conta + apre
      for (let i = 0; i < 5; i += 1) {
        const r = await cb.acquire('k', 60_000).catch((e: Error) => ({ error: e.message }));
        expect((r as { error?: string }).error).toMatch(/redis.*timeout/);
      }
      expect(cb.getBreakerState()).toBe('open');

      // 6° acquire = fast-fail (inner NON chiamato)
      const callsBeforeFastFail = getCalls();
      const result = await cb.acquire('k', 60_000);
      expect(result.acquired).toBe(true); // fast-fail-result = acquired:true (per fail-open middleware)
      expect(getCalls()).toBe(callsBeforeFastFail); // NESSUNA chiamata extra inner
    });

    it('complete su breaker OPEN = no-op silenzioso (NO throw)', async () => {
      const { store, getCalls } = makeFlakeyStore(100);
      const cb = new CircuitBreakerIdempotencyStore(store, { failureThreshold: 5, breakerName: 'test-complete-open' });
      for (let i = 0; i < 5; i += 1) await cb.acquire('k', 60_000).catch(() => { /* noop */ });
      const callsBefore = getCalls();
      await expect(cb.complete('k', { x: 1 })).resolves.toBeUndefined();
      // complete NON ha chiamato inner perche\` breaker e\` OPEN
      expect(getCalls()).toBe(callsBefore);
    });

    it('release su breaker OPEN = no-op (TTL decay handles cleanup)', async () => {
      const { store } = makeFlakeyStore(100);
      const cb = new CircuitBreakerIdempotencyStore(store, { failureThreshold: 5, breakerName: 'test-release-open' });
      for (let i = 0; i < 5; i += 1) await cb.acquire('k', 60_000).catch(() => { /* noop */ });
      await expect(cb.release('k')).resolves.toBeUndefined();
    });

    it('size su breaker OPEN ritorna 0 (conservativo, no throw)', async () => {
      const { store } = makeFlakeyStore(100);
      const cb = new CircuitBreakerIdempotencyStore(store, { failureThreshold: 5, breakerName: 'test-size-open' });
      for (let i = 0; i < 5; i += 1) await cb.acquire('k', 60_000).catch(() => { /* noop */ });
      const s = await cb.size();
      expect(s).toBe(0);
    });
  });

  describe('recovery — HALF_OPEN probe + CLOSE', () => {
    it('dopo resetTimeout, probe single → success → CLOSE → traffic riprende', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const failingStore = { failPhase: true };
        const store = {
          acquire: vi.fn(async () => {
            if (failingStore.failPhase) throw new Error('redis: down');
            return { acquired: true };
          }),
          complete: vi.fn(async () => { /* noop */ }),
          release: vi.fn(async () => { /* noop */ }),
          size: vi.fn(async () => 0),
        } as unknown as IdempotencyStore;
        const cb = new CircuitBreakerIdempotencyStore(store, {
          breakerName: 'test-recovery',
          failureThreshold: 3,
          resetTimeout: 100,
          successThreshold: 2,
        });
        // Trip → OPEN
        for (let i = 0; i < 3; i += 1) await cb.acquire('k', 60_000).catch(() => { /* noop */ });
        expect(cb.getBreakerState()).toBe('open');

        // Avanza oltre resetTimeout
        await vi.advanceTimersByTimeAsync(150);
        failingStore.failPhase = false; // backend up

        // Probe HALF_OPEN: prima call success → counter successo
        await cb.acquire('k', 60_000);
        await cb.acquire('k', 60_000);
        expect(cb.getBreakerState()).toBe('closed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('probe HALF_OPEN fails → torna OPEN per altro cooldown', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { store } = makeFlakeyStore(100);
        const cb = new CircuitBreakerIdempotencyStore(store, {
          breakerName: 'test-probe-fail',
          failureThreshold: 3,
          resetTimeout: 100,
        });
        for (let i = 0; i < 3; i += 1) await cb.acquire('k', 60_000).catch(() => { /* noop */ });
        await vi.advanceTimersByTimeAsync(150);
        // Probe fails (store still down)
        await cb.acquire('k', 60_000).catch(() => { /* noop */ });
        expect(cb.getBreakerState()).toBe('open');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('errori NON-CircuitOpen propagano normalmente', () => {
    it('throw inner !== CircuitOpenError → re-throw (caller fa fail-open path)', async () => {
      const store = {
        acquire: vi.fn(async () => { throw new Error('redis: timeout'); }),
        complete: vi.fn(),
        release: vi.fn(),
        size: vi.fn(async () => 0),
      } as unknown as IdempotencyStore;
      const cb = new CircuitBreakerIdempotencyStore(store, { breakerName: 'test-normal-throw' });
      await expect(cb.acquire('k', 60_000)).rejects.toThrow(/redis.*timeout/);
    });
  });
});
