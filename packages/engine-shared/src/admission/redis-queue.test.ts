/**
 * Integrazione redis-queue su REDIS REALE (Lua atomica).
 *
 * Tre garanzie, esercitate contro un Redis vero (skip se non raggiungibile):
 *  1. BEHAVIORAL: fresh-admit / cap→coda / avanzamento dopo release / reclaim /
 *     heartbeat / release, + chiavi corrette.
 *  2. DIFFERENZIALE (anti-drift): una sequenza di operazioni dà lo STESSO esito
 *     via Lua (Redis) e via decideAdmission (spec pura) → Lua ≡ cervello.
 *  3. CONCORRENZA (il buco che il revisore ha trovato): N tryAdmit PARALLELI →
 *     MAI più di maxConcurrent slot attivi. È il test che il fake WATCH/MULTI
 *     non poteva dare (interleaving su connessione condivisa).
 *
 * @vitest-environment node
 * @module admission/redis-queue.test
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { tryAdmit, release, heartbeat, type RedisLike, type AdmissionResult } from './redis-queue';
import { decideAdmission, type PoolState, type AdmissionInput } from './decision';

const URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

// Connessione a Redis reale (top-level await). Skip pulito se non c'è.
let client: Redis;
let available = false;
try {
  client = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 1500, retryStrategy: () => null });
  await client.connect();
  await client.ping();
  available = true;
} catch {
  available = false;
  try { client!.disconnect(); } catch { /* ignore */ }
}

const redis = (available ? client! : null) as unknown as RedisLike;

function newPool(): string { return `test-${randomUUID()}`; }
async function inflightCount(pool: string): Promise<number> { return client.zcard(`liara:adm:${pool}:inflight`); }
async function cleanup(pool: string): Promise<void> {
  await client.del(`liara:adm:${pool}:inflight`, `liara:adm:${pool}:queue`, `liara:adm:${pool}:qmeta`);
}
const baseInput = (over: Partial<AdmissionInput> & { requestId: string }): AdmissionInput => ({
  tenantId: 't1', nowMs: Date.now(), leaseMs: 60_000, maxConcurrent: 1, maxQueueDepth: 1000, maxPerTenantQueue: 1000, ...over,
});

describe.skipIf(!available)('redis-queue su Redis reale', () => {
  afterAll(async () => { await client.quit().catch(() => { /* ignore */ }); });

  let pool: string;
  beforeEach(() => { pool = newPool(); });

  it('fresh admit → inflight contiene rid con score = now+lease', async () => {
    const now = Date.now();
    const r = await tryAdmit(redis, pool, baseInput({ requestId: 'r1', nowMs: now }));
    expect(r.outcome).toBe('admitted');
    expect(await client.zscore(`liara:adm:${pool}:inflight`, 'r1')).toBe(String(now + 60_000));
    await cleanup(pool);
  });

  it('cap pieno → coda (pos/ahead), poi release → ri-tenta → ammesso + tolto da coda/qmeta', async () => {
    await tryAdmit(redis, pool, baseInput({ requestId: 'r1' }));
    const q = await tryAdmit(redis, pool, baseInput({ requestId: 'r2', tenantId: 'tX', nowMs: Date.now() + 1 }));
    expect(q).toMatchObject({ outcome: 'queued', position: 1, ahead: 0 });
    expect(await client.hget(`liara:adm:${pool}:qmeta`, 'r2')).toBe('tX');

    await release(redis, pool, 'r1');
    const r2 = await tryAdmit(redis, pool, baseInput({ requestId: 'r2', tenantId: 'tX', nowMs: Date.now() + 2 }));
    expect(r2.outcome).toBe('admitted');
    expect(await client.zscore(`liara:adm:${pool}:queue`, 'r2')).toBeNull();
    expect(await client.hget(`liara:adm:${pool}:qmeta`, 'r2')).toBeNull();
    await cleanup(pool);
  });

  it('reclaim: lease scaduto (score ≤ now) liberato all\'admit successivo', async () => {
    await client.zadd(`liara:adm:${pool}:inflight`, Date.now() - 1, 'dead');
    const r = await tryAdmit(redis, pool, baseInput({ requestId: 'r1', maxConcurrent: 1 }));
    expect(r.outcome).toBe('admitted');
    expect(await client.zscore(`liara:adm:${pool}:inflight`, 'dead')).toBeNull();
    await cleanup(pool);
  });

  it('heartbeat (XX) rinnova solo se attivo; release idempotente', async () => {
    await tryAdmit(redis, pool, baseInput({ requestId: 'r1' }));
    await heartbeat(redis, pool, 'r1', 9_999_999_999_999);
    expect(await client.zscore(`liara:adm:${pool}:inflight`, 'r1')).toBe('9999999999999');
    await heartbeat(redis, pool, 'ghost', 1); // no-resurrect
    expect(await client.zscore(`liara:adm:${pool}:inflight`, 'ghost')).toBeNull();
    await release(redis, pool, 'r1');
    await expect(release(redis, pool, 'nope')).resolves.toBeUndefined();
    await cleanup(pool);
  });

  it('anti-flood per-tenant: cap raggiunto → rejected tenant_flood; altro tenant passa', async () => {
    await tryAdmit(redis, pool, baseInput({ requestId: 'a' })); // occupa lo slot
    await tryAdmit(redis, pool, baseInput({ requestId: 'q1', tenantId: 'T', maxPerTenantQueue: 2, nowMs: Date.now() + 1 }));
    await tryAdmit(redis, pool, baseInput({ requestId: 'q2', tenantId: 'T', maxPerTenantQueue: 2, nowMs: Date.now() + 2 }));
    const flood = await tryAdmit(redis, pool, baseInput({ requestId: 'q3', tenantId: 'T', maxPerTenantQueue: 2, nowMs: Date.now() + 3 }));
    expect(flood).toMatchObject({ outcome: 'rejected', rejectReason: 'tenant_flood' });
    const other = await tryAdmit(redis, pool, baseInput({ requestId: 'q4', tenantId: 'OTHER', maxPerTenantQueue: 2, nowMs: Date.now() + 4 }));
    expect(other.outcome).toBe('queued');
    await cleanup(pool);
  });

  // ─── DIFFERENZIALE: Lua ≡ decideAdmission ─────────────────────────────────
  it('una sequenza mista produce gli STESSI esiti via Lua e via decideAdmission', async () => {
    let mirror: PoolState = { active: [], queue: [] };
    const maxConcurrent = 2, maxQueueDepth = 10, maxPerTenantQueue = 5;
    const steps: { requestId: string; tenantId: string }[] = [
      { requestId: 'a', tenantId: 't1' }, { requestId: 'b', tenantId: 't1' },
      { requestId: 'c', tenantId: 't2' }, { requestId: 'd', tenantId: 't2' },
      { requestId: 'a', tenantId: 't1' }, // re-entry (heartbeat) di uno ammesso
      { requestId: 'e', tenantId: 't1' },
    ];
    let now = Date.now();
    for (const s of steps) {
      now += 10; // ms distinti → niente ambiguità di tie sull'ordine FIFO
      const input: AdmissionInput = { ...s, nowMs: now, leaseMs: 60_000, maxConcurrent, maxQueueDepth, maxPerTenantQueue };
      const lua: AdmissionResult = await tryAdmit(redis, pool, input);
      const pure = decideAdmission(mirror, input);
      mirror = pure.state;
      expect({ outcome: lua.outcome, position: lua.position, ahead: lua.ahead, rejectReason: lua.rejectReason })
        .toEqual({ outcome: pure.outcome, position: pure.position, ahead: pure.ahead, rejectReason: pure.rejectReason });
    }
    await cleanup(pool);
  });

  // ─── CONCORRENZA: l'invariante centrale sotto carico parallelo REALE ──────
  it('🔒 N tryAdmit PARALLELI → MAI oltre maxConcurrent attivi (no over-admission)', async () => {
    const maxConcurrent = 3;
    const N = 60;
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        tryAdmit(redis, pool, {
          requestId: `r${i.toString()}`, tenantId: `tenant${(i % 5).toString()}`,
          nowMs: now + i, leaseMs: 60_000, maxConcurrent, maxQueueDepth: 1000, maxPerTenantQueue: 1000,
        }),
      ),
    );
    const admitted = results.filter((r) => r.outcome === 'admitted').length;
    const live = await inflightCount(pool);
    // INVARIANTE: mai oltre il cap, a prescindere dall'interleaving parallelo.
    expect(live).toBeLessThanOrEqual(maxConcurrent);
    expect(admitted).toBe(live); // gli ammessi == gli slot occupati
    expect(admitted).toBe(maxConcurrent); // con N≫cap e coda vuota: esattamente cap
    expect(results.filter((r) => r.outcome === 'queued').length).toBe(N - maxConcurrent);
    await cleanup(pool);
  });

  it('🔒 release concorrenti durante admit paralleli → invariante mantenuta', async () => {
    const maxConcurrent = 4;
    const now = Date.now();
    for (let i = 0; i < maxConcurrent; i++) {
      await tryAdmit(redis, pool, { requestId: `pre${i.toString()}`, tenantId: 't', nowMs: now, leaseMs: 60_000, maxConcurrent, maxQueueDepth: 1000, maxPerTenantQueue: 1000 });
    }
    await Promise.all([
      release(redis, pool, 'pre0'),
      release(redis, pool, 'pre1'),
      ...Array.from({ length: 20 }, (_, i) =>
        tryAdmit(redis, pool, { requestId: `n${i.toString()}`, tenantId: 't', nowMs: now + 100 + i, leaseMs: 60_000, maxConcurrent, maxQueueDepth: 1000, maxPerTenantQueue: 1000 })),
    ]);
    expect(await inflightCount(pool)).toBeLessThanOrEqual(maxConcurrent);
    await cleanup(pool);
  });
});

// Visibilità: se Redis non c'è, lascia traccia (non un falso verde silenzioso).
describe('redis-queue — disponibilità Redis', () => {
  it(available ? 'Redis reale disponibile → integrazione eseguita' : 'Redis NON disponibile → integrazione SALTATA (set TEST_REDIS_URL)', () => {
    expect(typeof available).toBe('boolean');
  });
});
