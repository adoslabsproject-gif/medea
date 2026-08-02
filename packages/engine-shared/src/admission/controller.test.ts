/**
 * Controller di ammissione — loop async deterministico (clock/sleep/schedule
 * iniettati). Verifica: ammissione diretta + heartbeat avviato/fermato,
 * coda→onQueue(posizione)→ammesso quando si libera uno slot, abort del client
 * (no slot zombie), backpressure (Overload), timeout d'attesa.
 *
 * Usa il fake Redis fedele di redis-queue.test (ZSET+HASH+WATCH/MULTI).
 *
 * @module admission/controller.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  admit,
  AdmissionOverloadError,
  AdmissionTimeoutError,
  AdmissionAbortError,
} from './controller';
import { tryAdmit, type RedisLike } from './redis-queue';
import { decideAdmission, type PoolState } from './decision';

// ─── fake Redis EVAL-based: il fake `eval` delega a decideAdmission (la SPEC)
// applicandolo allo stato in-memory → i test del controller esercitano il LOOP
// (coda/abort/timeout/heartbeat), NON la Lua (testata su Redis reale in
// redis-queue.test). zadd/zrem/hdel operano sugli stessi store (release/heartbeat).
interface FakeRedis extends RedisLike {
  _z: Map<string, Map<string, number>>;
  _h: Map<string, Map<string, string>>;
}
function makeFakeRedis(): FakeRedis {
  const z = new Map<string, Map<string, number>>();
  const h = new Map<string, Map<string, string>>();
  const zmap = (k: string): Map<string, number> => {
    let m = z.get(k);
    if (!m) {
      m = new Map();
      z.set(k, m);
    }
    return m;
  };
  const hmap = (k: string): Map<string, string> => {
    let m = h.get(k);
    if (!m) {
      m = new Map();
      h.set(k, m);
    }
    return m;
  };
  function zaddRaw(key: string, args: (string | number)[]): void {
    let i = 0;
    let xx = false;
    if (args[0] === 'XX') {
      xx = true;
      i = 1;
    }
    const m = zmap(key);
    for (; i + 1 < args.length; i += 2) {
      const s = Number(args[i]);
      const mem = String(args[i + 1]);
      if (xx && !m.has(mem)) continue;
      m.set(mem, s);
    }
  }
  const redis: FakeRedis = {
    _z: z,
    _h: h,
    async zadd(key, ...args) {
      zaddRaw(key, args);
      return 1;
    },
    async zrem(key, ...members) {
      const m = zmap(key);
      for (const x of members) m.delete(x);
      return 1;
    },
    async hdel(key, ...fields) {
      const m = hmap(key);
      for (const f of fields) m.delete(f);
      return 1;
    },
    async eval(_script, _numKeys, ...args) {
      const a = args as string[];
      const [inflightK, queueK, qmetaK, rid, tenant, now, lease, maxc, maxq, maxpt] = a;
      const inflight = zmap(inflightK!);
      const queue = zmap(queueK!);
      const qmeta = hmap(qmetaK!);
      const state: PoolState = {
        active: [...inflight.entries()].map(([id, score]) => ({ id, expiresAtMs: score })),
        queue: [...queue.entries()]
          .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1))
          .map(([id, score]) => ({ id, enqueuedAtMs: score, tenantId: qmeta.get(id) ?? '' })),
      };
      const d = decideAdmission(state, {
        requestId: rid!,
        tenantId: tenant!,
        nowMs: Number(now),
        leaseMs: Number(lease),
        maxConcurrent: Number(maxc),
        maxQueueDepth: Number(maxq),
        maxPerTenantQueue: Number(maxpt),
      });
      // applica il nuovo stato (come farebbe la Lua)
      inflight.clear();
      for (const l of d.state.active) inflight.set(l.id, l.expiresAtMs);
      queue.clear();
      qmeta.clear();
      for (const w of d.state.queue) {
        queue.set(w.id, w.enqueuedAtMs);
        qmeta.set(w.id, w.tenantId);
      }
      return d.outcome === 'rejected'
        ? [d.outcome, d.rejectReason]
        : [d.outcome, d.position, d.ahead];
    },
  };
  return redis;
}

const POOL = 'vllm';
const OPTS = {
  pool: POOL,
  maxConcurrent: 1,
  leaseMs: 30_000,
  heartbeatMs: 1_000_000,
  pollMs: 10,
  maxQueueDepth: 50,
  maxPerTenantQueue: 5,
  maxWaitMs: 60_000,
};
const noopSchedule = (): { clear: () => void } => ({ clear: () => {} });

let redis: FakeRedis;
beforeEach(() => {
  redis = makeFakeRedis();
});

describe('ammissione diretta', () => {
  it("slot libero → admitted; release() ferma l'heartbeat e libera lo slot", async () => {
    const clear = vi.fn();
    const schedule = vi.fn(() => ({ clear }));
    const handle = await admit({
      ...OPTS,
      redis,
      requestId: 'r1',
      tenantId: 't1',
      now: () => 1000,
      schedule,
    });
    expect(schedule).toHaveBeenCalledTimes(1); // heartbeat avviato
    expect(redis._z.get('liara:adm:vllm:inflight')?.has('r1')).toBe(true);
    await handle.release();
    expect(clear).toHaveBeenCalledTimes(1); // heartbeat fermato
    expect(redis._z.get('liara:adm:vllm:inflight')?.has('r1') ?? false).toBe(false);
    await handle.release(); // idempotente
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('coda → ammesso quando si libera uno slot', () => {
  it('emette onQueue(position) finché bloccato, poi entra appena lo slot si libera', async () => {
    // occupa l'unico slot
    await tryAdmit(redis, POOL, {
      requestId: 'blocker',
      tenantId: 't0',
      nowMs: 1,
      leaseMs: 30_000,
      maxConcurrent: 1,
      maxQueueDepth: 50,
      maxPerTenantQueue: 5,
    });
    const positions: { position: number; ahead: number }[] = [];
    let t = 100;
    // al primo sleep, libera il blocker → il poll successivo ammette r1
    const sleep = vi.fn(async () => {
      redis._z.get('liara:adm:vllm:inflight')!.delete('blocker');
    });
    const handle = await admit({
      ...OPTS,
      redis,
      requestId: 'r1',
      tenantId: 't1',
      now: () => t,
      sleep,
      schedule: noopSchedule,
      onQueue: (p) => {
        positions.push(p);
        t += 50;
      },
    });
    expect(positions).toEqual([{ position: 1, ahead: 0 }]); // ha atteso una volta
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(redis._z.get('liara:adm:vllm:inflight')?.has('r1')).toBe(true);
    await handle.release();
  });
});

describe('abort del client (SSE chiuso)', () => {
  it('signal già abortito → AdmissionAbortError e NESSUNO slot/coda lasciato', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      admit({
        ...OPTS,
        redis,
        requestId: 'r1',
        tenantId: 't1',
        signal: ac.signal,
        now: () => 1,
        schedule: noopSchedule,
      }),
    ).rejects.toBeInstanceOf(AdmissionAbortError);
    expect(redis._z.get('liara:adm:vllm:inflight')?.has('r1') ?? false).toBe(false);
    expect(redis._z.get('liara:adm:vllm:queue')?.has('r1') ?? false).toBe(false);
  });

  it('abort MENTRE in coda → esce dalla coda (cleanup) e lancia AbortError', async () => {
    await tryAdmit(redis, POOL, {
      requestId: 'blocker',
      tenantId: 't0',
      nowMs: 1,
      leaseMs: 30_000,
      maxConcurrent: 1,
      maxQueueDepth: 50,
      maxPerTenantQueue: 5,
    });
    const ac = new AbortController();
    const sleep = vi.fn(async () => {
      ac.abort();
    }); // aborta durante l'attesa
    await expect(
      admit({
        ...OPTS,
        redis,
        requestId: 'r1',
        tenantId: 't1',
        signal: ac.signal,
        now: () => 1,
        sleep,
        schedule: noopSchedule,
      }),
    ).rejects.toBeInstanceOf(AdmissionAbortError);
    expect(redis._z.get('liara:adm:vllm:queue')?.has('r1') ?? false).toBe(false); // tolto dalla coda
    expect(redis._h.get('liara:adm:vllm:qmeta')?.has('r1') ?? false).toBe(false);
  });
});

describe('backpressure', () => {
  it('coda piena → AdmissionOverloadError(queue_full)', async () => {
    // 1 slot occupato + coda a maxQueueDepth=2
    await tryAdmit(redis, POOL, {
      requestId: 'blocker',
      tenantId: 't0',
      nowMs: 1,
      leaseMs: 30_000,
      maxConcurrent: 1,
      maxQueueDepth: 2,
      maxPerTenantQueue: 9,
    });
    await tryAdmit(redis, POOL, {
      requestId: 'q1',
      tenantId: 't0',
      nowMs: 2,
      leaseMs: 30_000,
      maxConcurrent: 1,
      maxQueueDepth: 2,
      maxPerTenantQueue: 9,
    });
    await tryAdmit(redis, POOL, {
      requestId: 'q2',
      tenantId: 't0',
      nowMs: 3,
      leaseMs: 30_000,
      maxConcurrent: 1,
      maxQueueDepth: 2,
      maxPerTenantQueue: 9,
    });
    const err = await admit({
      ...OPTS,
      redis,
      requestId: 'r1',
      tenantId: 't1',
      maxQueueDepth: 2,
      now: () => 4,
      schedule: noopSchedule,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdmissionOverloadError);
    expect((err as AdmissionOverloadError).reason).toBe('queue_full');
  });
});

describe('timeout di attesa', () => {
  it('superato maxWaitMs in coda → AdmissionTimeoutError + cleanup', async () => {
    await tryAdmit(redis, POOL, {
      requestId: 'blocker',
      tenantId: 't0',
      nowMs: 1,
      leaseMs: 1e9,
      maxConcurrent: 1,
      maxQueueDepth: 50,
      maxPerTenantQueue: 5,
    });
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 1000;
    }); // ogni poll avanza il clock
    const err = await admit({
      ...OPTS,
      redis,
      requestId: 'r1',
      tenantId: 't1',
      maxWaitMs: 1500,
      now: () => t,
      sleep,
      schedule: noopSchedule,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdmissionTimeoutError);
    expect(redis._z.get('liara:adm:vllm:queue')?.has('r1') ?? false).toBe(false); // cleanup
  });
});
