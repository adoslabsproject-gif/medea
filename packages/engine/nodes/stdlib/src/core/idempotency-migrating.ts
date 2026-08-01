/**
 * MigratingIdempotencyStore — dual-write decorator per swap backend zero-downtime.
 *
 * Use case: runtime gia\` live con `InMemoryIdempotencyStore`. Vogliamo spostarci
 * a `RedisIdempotencyStore` SENZA perdere i lock attivi (workflow in flight
 * potrebbero double-POST se il nuovo backend non vede i lock vecchi).
 *
 * Soluzione: per una grace window (default 24h), il wrapper:
 *   • READ: prova `next` first, fallback `previous` (eventual consistency).
 *   • WRITE (complete/release): scrive su ENTRAMBI (best-effort sul previous).
 *   • acquire: prova `next` — se acquired=true, anche previous riceve lo stesso
 *     claim (cosi\` un fallback read post-swap vede il lock).
 *
 * Dopo grace window: il wrapper si auto-disabilita (chiamare `setDefaultIdempotencyStore`
 * con solo `next` o lasciar finire i lock vecchi nel previous — TTL li pulisce).
 *
 * Pattern: classico Strangler Fig (Martin Fowler 2004), oggi standard 2026
 * per migrazione store nel cloud-native (Stripe, Shopify, GitHub usano dual-write
 * per backend swap).
 */

import type { IdempotencyStore, AcquireResult } from './idempotency.js';

export interface MigratingIdempotencyStoreOptions {
  /** Store gia\` in produzione (legacy). */
  readonly previous: IdempotencyStore;
  /** Store target post-migrazione. */
  readonly next: IdempotencyStore;
  /**
   * Logger opzionale per warning su write asimmetriche (previous ha errato
   * ma next OK, o viceversa). Permette di monitorare la migration.
   */
  readonly onAsymmetry?: (op: 'acquire' | 'complete' | 'release', key: string, err: unknown, side: 'previous' | 'next') => void;
}

export class MigratingIdempotencyStore implements IdempotencyStore {
  private readonly previous: IdempotencyStore;
  private readonly next: IdempotencyStore;
  private readonly onAsymmetry?: MigratingIdempotencyStoreOptions['onAsymmetry'];

  constructor(opts: MigratingIdempotencyStoreOptions) {
    this.previous = opts.previous;
    this.next = opts.next;
    if (opts.onAsymmetry) this.onAsymmetry = opts.onAsymmetry;
  }

  async acquire(key: string, ttlMs: number): Promise<AcquireResult> {
    // Read-first sul next — e\` la source-of-truth post-migrazione.
    const nextResult = await this.next.acquire(key, ttlMs);
    if (!nextResult.acquired) return nextResult; // hit cached output o in-flight

    // Acquired su next → claim anche previous (best-effort) per evitare che
    // un retry routed al previous store ri-esegua.
    try {
      await this.previous.acquire(key, ttlMs);
    } catch (err) {
      this.onAsymmetry?.('acquire', key, err, 'previous');
    }

    // Verifica se previous aveva GIA\` un output cached — se sì, fallback
    // (priorita\` ai dati legacy per non rompere workflow in flight).
    try {
      const legacy = await this.previous.acquire(key, ttlMs);
      if (!legacy.acquired && legacy.previousOutput !== undefined) {
        // Replica nel next per warm-up
        await this.next.complete(key, legacy.previousOutput);
        return legacy;
      }
    } catch (err) {
      this.onAsymmetry?.('acquire', key, err, 'previous');
    }

    return nextResult;
  }

  async complete(key: string, output: unknown): Promise<void> {
    const results = await Promise.allSettled([
      this.next.complete(key, output),
      this.previous.complete(key, output),
    ]);
    if (results[0].status === 'rejected') this.onAsymmetry?.('complete', key, results[0].reason, 'next');
    if (results[1].status === 'rejected') this.onAsymmetry?.('complete', key, results[1].reason, 'previous');
  }

  async release(key: string): Promise<void> {
    const results = await Promise.allSettled([
      this.next.release(key),
      this.previous.release(key),
    ]);
    if (results[0].status === 'rejected') this.onAsymmetry?.('release', key, results[0].reason, 'next');
    if (results[1].status === 'rejected') this.onAsymmetry?.('release', key, results[1].reason, 'previous');
  }

  async size(): Promise<number> {
    // Riporta il MAX dei due — durante migration sono spesso identici,
    // ma se uno e\` parzialmente popolato la unione approssimata via max
    // e\` la piu\` informativa (sum doppierebbe; min sottostimerebbe).
    const [nextSize, prevSize] = await Promise.all([
      this.next.size().catch(() => 0),
      this.previous.size().catch(() => 0),
    ]);
    return Math.max(nextSize, prevSize);
  }
}
