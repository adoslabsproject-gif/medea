/**
 * RedisIdempotencyStore — backend distribuito per `IdempotencyStore` di stdlib.
 *
 * Use case: multi-pod runtime (futuro scale-out container-per-tenant verticale)
 * dove la cache in-memory `InMemoryIdempotencyStore` causerebbe duplicate POST
 * cross-pod su retry. Redis garantisce atomic `SET NX PX` + visibilita\` cross-pod.
 *
 * Schema chiavi Redis:
 *   ff:idem:<key>:lock   — valore = timestamp acquire (PX = TTL ms)
 *   ff:idem:<key>:output — valore = JSON output (creato su complete(), stesso TTL)
 *
 * Atomicity:
 *   • acquire = `SET <lock> <ts> PX <ttl> NX` — atomic claim, no race.
 *   • complete = `GET PTTL <lock> + SET <output> PX <residualTtl>` — best-effort
 *     (l'output ha lo STESSO TTL del lock, decade insieme).
 *   • release = `DEL <lock> <output>` — atomico via UNLINK / DEL pipeline.
 *
 * Performance:
 *   • acquire = 1 round trip (NX path) o 1+2 (GET previous se hit).
 *   • size() usa SCAN cursor (bounded, no KEYS *) — costo O(N/100 cursor steps).
 *
 * Fallback graceful: se Redis e\` down, `acquire()` THROW (caller convertono in
 * NodeError). Il middleware withIdempotency catch + release on throw → no leak
 * locks. Pattern fail-loud preferred a silent skip che lascerebbe doppio-POST.
 */

import type IORedis from 'ioredis';
import type { IdempotencyStore, AcquireResult } from '@medea/engine-nodes-stdlib';

export interface RedisIdempotencyStoreOptions {
  /** Connection ioredis condivisa (riusa pool BullMQ se possibile). */
  readonly redis: IORedis;
  /** Prefix chiavi per isolamento namespace. Default 'ff:idem:'. */
  readonly keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = 'ff:idem:';

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: IORedis;
  private readonly keyPrefix: string;

  constructor(opts: RedisIdempotencyStoreOptions) {
    this.redis = opts.redis;
    this.keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async acquire(key: string, ttlMs: number): Promise<AcquireResult> {
    const lockKey = `${this.keyPrefix}${key}:lock`;
    const outputKey = `${this.keyPrefix}${key}:output`;
    const now = Date.now();
    // Atomic claim: SET NX PX. Restituisce 'OK' se acquisito, null se gia\` esiste.
    const result = await this.redis.set(lockKey, String(now), 'PX', ttlMs, 'NX');
    if (result === 'OK') return { acquired: true };

    // Already locked — leggi previous (best-effort, async race tollerato).
    const [previousAtStr, outputStr] = await Promise.all([
      this.redis.get(lockKey),
      this.redis.get(outputKey),
    ]);
    const previousAt = previousAtStr ? Number(previousAtStr) : undefined;
    const base: AcquireResult = { acquired: false };
    if (previousAt && Number.isFinite(previousAt)) base.previousAt = previousAt;
    if (outputStr) {
      try { base.previousOutput = JSON.parse(outputStr) as unknown; }
      catch { /* output corrotto — restituisci solo previousAt */ }
    }
    return base;
  }

  async complete(key: string, output: unknown): Promise<void> {
    const lockKey = `${this.keyPrefix}${key}:lock`;
    const outputKey = `${this.keyPrefix}${key}:output`;
    // Sincronizza TTL output con lock — decadono insieme.
    const residualMs = await this.redis.pttl(lockKey);
    if (residualMs <= 0) return; // lock gia\` scaduto/rilasciato — no-op
    let payload: string;
    try { payload = JSON.stringify(output); }
    catch { payload = JSON.stringify({ __unserializable: String(output) }); }
    await this.redis.set(outputKey, payload, 'PX', residualMs);
  }

  async release(key: string): Promise<void> {
    const lockKey = `${this.keyPrefix}${key}:lock`;
    const outputKey = `${this.keyPrefix}${key}:output`;
    await this.redis.del(lockKey, outputKey);
  }

  /**
   * Conta i lock attivi via SCAN (bounded). NON usa KEYS * (O(N) blocking).
   * Risultato e\` approssimato: chiavi che spirano durante lo scan possono
   * essere contate o no. Per observability admin questo e\` accettabile.
   */
  async size(): Promise<number> {
    const pattern = `${this.keyPrefix}*:lock`;
    return new Promise<number>((resolve, reject) => {
      let count = 0;
      const stream = this.redis.scanStream({ match: pattern, count: 100 });
      stream.on('data', (keys: string[]) => { count += keys.length; });
      stream.on('end', () => resolve(count));
      stream.on('error', (err) => reject(err));
    });
  }
}

/**
 * Factory: crea uno store Redis con resolution 3-tier (preferenza decrescente).
 *
 * Priorita\` source connection:
 *
 *   1. MEDEA_IDEMPOTENCY_REDIS_URL — connection DEDICATA per idempotency
 *      (preferito enterprise: isolation completa da BullMQ — diverso pool,
 *      diverso DB index, no contention sui comandi atomic). Use case:
 *      Redis Cluster per BullMQ + Redis Sentinel singolo per idempotency.
 *
 *   2. MEDEA_QUEUE_MODE=redis + MEDEA_REDIS_URL — riusa la connection
 *      di BullMQ (default ergonomico: zero env extra, single Redis instance).
 *
 *   3. MEDEA_REDIS_URL standalone — crea client dedicato anche senza
 *      queue mode (use case: single-pod runtime senza BullMQ ma con Redis
 *      esterno per persistenza idempotency cross-restart).
 *
 *   altrimenti: null → caller usa InMemoryIdempotencyStore fallback.
 *
 * Connection lifecycle: il client dedicato (case 1+3) viene tracciato in
 * `_managedConnection` per shutdown graceful via `closeManagedRedisConnection()`.
 * In case 2 (riuso BullMQ) il lifecycle e\` di queue.service.
 */
let _managedConnection: IORedis | null = null;

export interface RedisStoreResolution {
  store: RedisIdempotencyStore;
  /** Source della connection — utile per logging/observability. */
  source: 'dedicated' | 'bullmq' | 'standalone';
  /** URL Redis effettivo (per log al boot). */
  redisUrl: string;
}

export async function createRedisIdempotencyStoreIfEnabled(): Promise<RedisStoreResolution | null> {
  const dedicatedUrl = process.env.MEDEA_IDEMPOTENCY_REDIS_URL;
  if (dedicatedUrl) {
    const conn = await createManagedConnection(dedicatedUrl);
    return { store: new RedisIdempotencyStore({ redis: conn }), source: 'dedicated', redisUrl: dedicatedUrl };
  }

  const isQueueMode = (process.env.MEDEA_QUEUE_MODE ?? '').toLowerCase() === 'redis';
  const sharedUrl = process.env.MEDEA_REDIS_URL;

  if (isQueueMode && sharedUrl) {
    // Riusa la connection BullMQ — import lazy per evitare dipendenza ciclica.
    const { getQueueConnection } = await import('@/services/queue.service.js');
    try {
      return { store: new RedisIdempotencyStore({ redis: getQueueConnection() }), source: 'bullmq', redisUrl: sharedUrl };
    } catch {
      // BullMQ non disponibile — cade nel branch standalone sotto.
    }
  }

  if (sharedUrl) {
    const conn = await createManagedConnection(sharedUrl);
    return { store: new RedisIdempotencyStore({ redis: conn }), source: 'standalone', redisUrl: sharedUrl };
  }

  return null;
}

async function createManagedConnection(url: string): Promise<IORedis> {
  if (_managedConnection) return _managedConnection;
  const { default: IORedisCtor } = await import('ioredis');
  _managedConnection = new IORedisCtor(url, {
    // commandTimeout: ogni comando individuale (SET/GET/PTTL/DEL/SCAN) deve
    // completare entro 5s. Senza, `withIdempotency` middleware si bloccava
    // INFINITE su Redis-down (ioredis `maxRetriesPerRequest:null` aspetta
    // reconnect senza limite → workflow hung mid-execution).
    // Con commandTimeout: store.acquire() throws → middleware fail-open path
    // attivato → workflow prosegue come zero-config dev/test.
    commandTimeout: 5000,
    // maxRetriesPerRequest=3 (era null): cap retry per evitare hung infinito.
    // BullMQ usa null per long-lived MA per idempotency vogliamo fail-fast.
    maxRetriesPerRequest: 3,
    // enableOfflineQueue=false: con commandTimeout, queue offline farebbe
    // accumulare comandi pendenti → memory leak su Redis-down prolungato.
    // Failure su disconnect = fail-open immediato (NO retry queue).
    enableOfflineQueue: false,
    enableReadyCheck: true,
    // Lazy connect: connessione NON tentata fino al primo comando, evita
    // crash al boot se Redis temporaneamente down (eventual consistency).
    lazyConnect: true,
    // Reconnect backoff: 100ms → 1s exponential, cap 5s. Anti-thundering-herd
    // su recovery (multi-pod simultaneo).
    retryStrategy: (times: number) => Math.min(times * 100, 5000),
  });
  return _managedConnection;
}

/**
 * Shutdown graceful — chiude la connection dedicata. Da chiamare al SIGTERM
 * (vedi main.ts process exit handler). No-op se la connection e\` riusata
 * da BullMQ (case 2 sopra) — non e\` `_managedConnection`.
 */
export async function closeManagedRedisConnection(): Promise<void> {
  if (!_managedConnection) return;
  try { await _managedConnection.quit(); }
  catch { _managedConnection.disconnect(); }
  _managedConnection = null;
}
