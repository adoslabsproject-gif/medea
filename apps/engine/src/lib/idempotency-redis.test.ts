import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisIdempotencyStore } from './idempotency-redis.js';

/**
 * Mock ioredis client minimale — in-memory simulazione SET NX PX + GET + PTTL + DEL.
 * Bypassa l'IO reale: testa la LOGICA dello store, non ioredis.
 */
function makeMockRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const now = () => Date.now();
  function purgeExpired(): void {
    for (const [k, v] of store.entries()) {
      if (v.expiresAt < now()) store.delete(k);
    }
  }
  return {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      purgeExpired();
      // Args: 'PX', ttl, 'NX' (or other combos)
      const pxIdx = args.indexOf('PX');
      const nxIdx = args.indexOf('NX');
      const ttlMs = pxIdx >= 0 ? Number(args[pxIdx + 1]) : Infinity;
      const isNx = nxIdx >= 0;
      if (isNx && store.has(key)) return null;
      store.set(key, { value, expiresAt: now() + ttlMs });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => {
      purgeExpired();
      return store.get(key)?.value ?? null;
    }),
    pttl: vi.fn(async (key: string) => {
      purgeExpired();
      const entry = store.get(key);
      if (!entry) return -2;
      const remaining = entry.expiresAt - now();
      return remaining > 0 ? remaining : -2;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n += 1;
      }
      return n;
    }),
    scanStream: vi.fn(({ match }: { match: string }) => {
      purgeExpired();
      const re = new RegExp('^' + match.replace(/\*/g, '.*') + '$');
      const matched = [...store.keys()].filter((k) => re.test(k));
      const listeners: Record<string, ((data?: unknown) => void)[]> = {};
      const emit = (event: string, data?: unknown) => {
        (listeners[event] ?? []).forEach((l) => l(data));
      };
      setImmediate(() => {
        if (matched.length > 0) emit('data', matched);
        emit('end');
      });
      return {
        on(event: string, cb: (data?: unknown) => void) {
          (listeners[event] ??= []).push(cb);
          return this;
        },
      };
    }),
    _store: store,
  };
}

describe('RedisIdempotencyStore', () => {
  let store: RedisIdempotencyStore;
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
    store = new RedisIdempotencyStore({ redis: redis as never });
  });

  describe('acquire (SET NX PX atomic)', () => {
    it('first acquire returns acquired=true + claims the lock', async () => {
      const r = await store.acquire('k1', 60_000);
      expect(r.acquired).toBe(true);
      expect(r.previousOutput).toBeUndefined();
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('k1:lock'),
        expect.any(String),
        'PX',
        60_000,
        'NX',
      );
    });

    it('second acquire (in-flight, no complete) returns acquired=false + previousAt', async () => {
      await store.acquire('k1', 60_000);
      const r = await store.acquire('k1', 60_000);
      expect(r.acquired).toBe(false);
      expect(r.previousAt).toBeTypeOf('number');
      expect(r.previousOutput).toBeUndefined();
    });

    it('second acquire after complete returns previousOutput', async () => {
      await store.acquire('k1', 60_000);
      await store.complete('k1', { result: 42 });
      const r = await store.acquire('k1', 60_000);
      expect(r.acquired).toBe(false);
      expect(r.previousOutput).toEqual({ result: 42 });
    });

    it('handles corrupted output JSON gracefully', async () => {
      await store.acquire('k1', 60_000);
      // Inietta output non valido direttamente nello store mock
      redis._store.set('ff:idem:k1:output', {
        value: 'not json{}',
        expiresAt: Date.now() + 60_000,
      });
      const r = await store.acquire('k1', 60_000);
      expect(r.acquired).toBe(false);
      expect(r.previousOutput).toBeUndefined();
      expect(r.previousAt).toBeTypeOf('number');
    });
  });

  describe('complete + release', () => {
    it('complete stores output with same TTL as lock', async () => {
      await store.acquire('k1', 5_000);
      await store.complete('k1', { x: 1 });
      const stored = await redis.get('ff:idem:k1:output');
      expect(stored).toBe('{"x":1}');
    });

    it('complete è no-op se lock già scaduto', async () => {
      await store.acquire('k1', 1);
      await new Promise((r) => setTimeout(r, 10));
      await store.complete('k1', { ignored: true });
      const stored = await redis.get('ff:idem:k1:output');
      expect(stored).toBeNull();
    });

    it('release rimuove sia lock che output', async () => {
      await store.acquire('k1', 60_000);
      await store.complete('k1', 'x');
      await store.release('k1');
      expect(await redis.get('ff:idem:k1:lock')).toBeNull();
      expect(await redis.get('ff:idem:k1:output')).toBeNull();
      // Re-acquire ora funziona
      const r = await store.acquire('k1', 60_000);
      expect(r.acquired).toBe(true);
    });

    it('complete con valore non-serializzabile salva fallback', async () => {
      await store.acquire('k1', 60_000);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await store.complete('k1', circular);
      const stored = await redis.get('ff:idem:k1:output');
      expect(stored).toContain('__unserializable');
    });
  });

  describe('custom key prefix', () => {
    it('honora keyPrefix custom (multi-tenant namespace)', async () => {
      const s = new RedisIdempotencyStore({ redis: redis as never, keyPrefix: 'tenant42:idem:' });
      await s.acquire('k1', 60_000);
      expect(await redis.get('tenant42:idem:k1:lock')).not.toBeNull();
      expect(await redis.get('ff:idem:k1:lock')).toBeNull(); // default prefix unused
    });
  });

  describe('size (SCAN cursor)', () => {
    it('conta i lock attivi via SCAN', async () => {
      await store.acquire('a', 60_000);
      await store.acquire('b', 60_000);
      await store.acquire('c', 60_000);
      expect(await store.size()).toBe(3);
    });

    it('non conta entry expired', async () => {
      await store.acquire('a', 1);
      await store.acquire('b', 60_000);
      await new Promise((r) => setTimeout(r, 10));
      expect(await store.size()).toBe(1);
    });

    it('ritorna 0 quando nessun lock', async () => {
      expect(await store.size()).toBe(0);
    });
  });
});
