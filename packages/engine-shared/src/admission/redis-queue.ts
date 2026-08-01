/**
 * Redis-backed lease-semaphore + coda FIFO per l'ammissione LLM.
 *
 * Stato del pool in 3 chiavi Redis (condivise da TUTTI i front-door verso vLLM
 * → protegge la GPU UNICA):
 *   - `:inflight`  ZSET  member=requestId  score=leaseExpiryMs   (slot attivi)
 *   - `:queue`     ZSET  member=requestId  score=enqueuedAtMs    (FIFO)
 *   - `:qmeta`     HASH  field=requestId   value=tenantId        (per anti-flood)
 *
 * ⛔ ATOMICITÀ (fix concorrenza 2026-06-13): la decisione+mutazione gira in un
 * UNICO script Lua server-side (`ADMISSION_LUA`) → atomica per natura, immune
 * all'interleaving su connessione condivisa. La versione precedente usava
 * WATCH/MULTI sulla connessione ioredis del processo: EXEC azzera TUTTI i WATCH
 * della connessione → due `tryAdmit` concorrenti interleaved (stesso processo,
 * connessione condivisa, await in mezzo) potevano committare entrambi e
 * over-ammettere oltre `maxConcurrent` — proprio sotto carico, dove la coda
 * serve. Lua non ha stato di connessione → nessun pool, nessun `.duplicate()`
 * (cruciale: il controller POLLA tryAdmit → churn di connessioni inaccettabile).
 *
 * Lo script RISPECCHIA passo-passo `decideAdmission` (modulo `decision.ts`), che
 * resta la SPEC pura testata. Un contract test differenziale su Redis reale
 * verifica Lua ≡ decideAdmission; un test di concorrenza prova "mai oltre
 * maxConcurrent" con N tryAdmit paralleli.
 *
 * @module admission/redis-queue
 */
import type { AdmissionInput, AdmissionOutcome, RejectReason } from './decision.js';

/** Subset di ioredis usato — strutturale → mockabile nei test. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  zadd(key: string, ...args: (string | number)[]): Promise<unknown>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
}

/** Esito di tryAdmit (sottoinsieme di AdmissionDecision: niente `state`, lo muta Redis). */
export interface AdmissionResult {
  outcome: AdmissionOutcome;
  position: number;
  ahead: number;
  rejectReason?: RejectReason;
}

function keysFor(pool: string): { inflight: string; queue: string; qmeta: string } {
  return {
    inflight: `liara:adm:${pool}:inflight`,
    queue: `liara:adm:${pool}:queue`,
    qmeta: `liara:adm:${pool}:qmeta`,
  };
}

/**
 * Script di ammissione ATOMICO. KEYS: inflight, queue, qmeta.
 * ARGV: requestId, tenantId, nowMs, leaseMs, maxConcurrent, maxQueueDepth, maxPerTenantQueue.
 * Ritorna: {outcome, position, ahead} oppure {'rejected', reason}.
 *
 * Mirror 1:1 di decideAdmission: reclaim scaduti → re-entry/heartbeat → coda
 * (multi-admit rank<freeSlots) → fast-path (slot liberi & coda vuota) →
 * backpressure (queue_full) → anti-flood per-tenant → enqueue.
 */
export const ADMISSION_LUA = `
local inflight, queue, qmeta = KEYS[1], KEYS[2], KEYS[3]
local rid = ARGV[1]
local tenant = ARGV[2]
local now = tonumber(ARGV[3])
local lease = tonumber(ARGV[4])
local maxc = tonumber(ARGV[5])
if maxc < 1 then maxc = 1 end
local maxq = tonumber(ARGV[6])
local maxpt = tonumber(ARGV[7])

-- reclaim lease scaduti: live = expiry > now → rimuovi score <= now
redis.call('ZREMRANGEBYSCORE', inflight, '-inf', now)

-- re-entry idempotente / heartbeat
if redis.call('ZSCORE', inflight, rid) then
  redis.call('ZADD', inflight, now + lease, rid)
  return {'admitted', 0, 0}
end

local activeCount = redis.call('ZCARD', inflight)
local freeSlots = maxc - activeCount

local rank = redis.call('ZRANK', queue, rid)
if rank then
  if rank < freeSlots then
    redis.call('ZREM', queue, rid)
    redis.call('HDEL', qmeta, rid)
    redis.call('ZADD', inflight, now + lease, rid)
    return {'admitted', 0, 0}
  end
  return {'queued', rank + 1, rank}
end

local qlen = redis.call('ZCARD', queue)
if freeSlots > 0 and qlen == 0 then
  redis.call('ZADD', inflight, now + lease, rid)
  return {'admitted', 0, 0}
end

if qlen >= maxq then
  return {'rejected', 'queue_full'}
end

local tenants = redis.call('HVALS', qmeta)
local tcount = 0
for i = 1, #tenants do
  if tenants[i] == tenant then tcount = tcount + 1 end
end
if tcount >= maxpt then
  return {'rejected', 'tenant_flood'}
end

redis.call('ZADD', queue, now, rid)
redis.call('HSET', qmeta, rid, tenant)
local newRank = redis.call('ZRANK', queue, rid)
return {'queued', newRank + 1, newRank}
`;

/** Ammissione ATOMICA via Lua. Ritorna la decisione (admitted/queued/rejected). */
export async function tryAdmit(redis: RedisLike, pool: string, input: AdmissionInput): Promise<AdmissionResult> {
  const k = keysFor(pool);
  const raw = await redis.eval(
    ADMISSION_LUA, 3,
    k.inflight, k.queue, k.qmeta,
    input.requestId, input.tenantId,
    String(input.nowMs), String(input.leaseMs),
    String(input.maxConcurrent), String(input.maxQueueDepth), String(input.maxPerTenantQueue),
  );
  const arr = raw as [string, (string | number)?, (string | number)?];
  const outcome = arr[0] as AdmissionOutcome;
  if (outcome === 'rejected') {
    return { outcome, position: 0, ahead: 0, rejectReason: arr[1] as RejectReason };
  }
  return { outcome, position: Number(arr[1] ?? 0), ahead: Number(arr[2] ?? 0) };
}

/** Rilascia lo slot E toglie da coda/meta (idempotente; comandi singoli, no WATCH). */
export async function release(redis: RedisLike, pool: string, requestId: string): Promise<void> {
  const k = keysFor(pool);
  await Promise.all([
    redis.zrem(k.inflight, requestId),
    redis.zrem(k.queue, requestId),
    redis.hdel(k.qmeta, requestId),
  ]);
}

/** Rinnova il lease di uno slot ATTIVO (no-op se non più attivo: flag XX). */
export async function heartbeat(redis: RedisLike, pool: string, requestId: string, expiresAtMs: number): Promise<void> {
  const k = keysFor(pool);
  await redis.zadd(k.inflight, 'XX', expiresAtMs, requestId);
}
