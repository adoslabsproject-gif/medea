/**
 * IdempotencyRegistry — anti-duplicate-side-effect guard a livello executor.
 *
 * Use-case: stesso run × replay (dopo crash recovery o pinned re-execute)
 * → senza guard, un POST esterno (Stripe charge, Telegram send, etc.) viene
 * eseguito 2 volte. Con guard, la SECONDA chiamata vede `acquired=false` +
 * `previousOutput` e ritorna lo stesso valore senza ri-invocare il vendor.
 *
 * Keying: di default `${runId}:${nodeId}` — coppia che identifica univocamente
 * UN tentativo di esecuzione di UN nodo dentro UN run. Per nodi che processano
 * N item (Loop child), il chiamante puo\` includere l'item key:
 * `${runId}:${nodeId}:item:${itemHash}`.
 *
 * Storage backend:
 *   • InMemoryIdempotencyStore  — default, TTL 1h, Map JS. Per single-pod.
 *   • RedisIdempotencyStore     — distributed (interface, impl in apps/runtime).
 *
 * NON sostituisce l'idempotency-key che si manda all'API esterna (es. header
 * `Idempotency-Key` di Stripe), ma e\` complementare: questo registry blocca
 * la chiamata-bis sul NOSTRO lato; l'header e\` la safety net lato vendor.
 */

export interface IdempotencyEntry {
  /** Output del primo successo. Null finche\` l'op non completa. */
  output: unknown;
  /** Timestamp first-acquire (ms epoch). */
  acquiredAt: number;
  /** Timestamp completion (ms epoch). Null finche\` in-flight. */
  completedAt: number | null;
  /** TTL absolute expiry (ms epoch). Dopo questo l'entry e\` purgeable. */
  expiresAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** Quando acquired=false, l'output salvato del precedente successo. */
  previousOutput?: unknown;
  /** Quando acquired=false, il timestamp del primo acquire (per error message). */
  previousAt?: number;
}

export interface IdempotencyStore {
  acquire(key: string, ttlMs: number): Promise<AcquireResult>;
  complete(key: string, output: unknown): Promise<void>;
  /** Rimuove l'entry (caller ha deciso di NON committare il successo — es. error retryable in-flight). */
  release(key: string): Promise<void>;
  /** Stats — quanti entry attivi (post-prune). Util per metric admin. */
  size(): Promise<number>;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const PRUNE_INTERVAL = 100; // purge expired ogni N op

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private opsSinceLastPrune = 0;

  async acquire(key: string, ttlMs: number = DEFAULT_TTL_MS): Promise<AcquireResult> {
    this.maybePrune();
    const existing = this.entries.get(key);
    const now = Date.now();
    if (existing && existing.expiresAt > now) {
      // Hit: ritorna il previous (anche se in-flight = output null — fail-safe:
      // il chiamante interpreta `previousOutput === undefined` come "in-flight
      // da un'altra esecuzione concorrente", scelta di policy se proseguire o no).
      return existing.completedAt !== null
        ? { acquired: false, previousOutput: existing.output, previousAt: existing.acquiredAt }
        : { acquired: false, previousAt: existing.acquiredAt };
    }
    // Free slot — claim it
    this.entries.set(key, {
      output: null,
      acquiredAt: now,
      completedAt: null,
      expiresAt: now + ttlMs,
    });
    return { acquired: true };
  }

  async complete(key: string, output: unknown): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return; // mai acquired — no-op (caller bug, ma non rompiamo il flow)
    entry.output = output;
    entry.completedAt = Date.now();
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async size(): Promise<number> {
    this.prune();
    return this.entries.size;
  }

  /** Test helper: clear all. */
  clear(): void {
    this.entries.clear();
  }

  private maybePrune(): void {
    this.opsSinceLastPrune += 1;
    if (this.opsSinceLastPrune >= PRUNE_INTERVAL) {
      this.prune();
      this.opsSinceLastPrune = 0;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, e] of this.entries.entries()) {
      if (e.expiresAt <= now) this.entries.delete(k);
    }
  }
}

/**
 * Singleton in-memory store. Per single-pod runtime tenant container e\`
 * sufficiente (ogni container ha il proprio process + run sono tenant-local).
 *
 * Per multi-pod scaling il runtime sostituisce questo singleton con
 * `RedisIdempotencyStore` via `setDefaultIdempotencyStore()` al bootstrap
 * (vedi apps/engine/src/main.ts).
 */
let _defaultStore: IdempotencyStore = new InMemoryIdempotencyStore();

export const defaultIdempotencyStore = new Proxy({} as IdempotencyStore, {
  get(_target, prop: keyof IdempotencyStore) {
    const fn = _defaultStore[prop];
    return typeof fn === 'function' ? fn.bind(_defaultStore) : fn;
  },
});

/**
 * Sostituisce il backend store del singleton `defaultIdempotencyStore`.
 *
 * Bootstrap pattern: il runtime, dopo aver rilevato `MEDEA_QUEUE_MODE=redis`,
 * chiama `setDefaultIdempotencyStore(new RedisIdempotencyStore({redis}))` PRIMA
 * di registrare le route — cosi\` tutti i middleware `withIdempotency` ereditano
 * il backend distribuito senza modifiche al call-site.
 *
 * Idempotente: chiamabile piu\` volte (es. hot-reload dev).
 */
export function setDefaultIdempotencyStore(store: IdempotencyStore): void {
  _defaultStore = store;
}

/** Test-only: ripristina InMemoryIdempotencyStore fresca. */
export function resetDefaultIdempotencyStore(): void {
  _defaultStore = new InMemoryIdempotencyStore();
}

/**
 * Build a stable key da tenantId+runId+nodeId (+ optional sub-keys item-level).
 *
 *   makeIdempotencyKey('t1', 'r1', 'n1')                  → 't1:r1:n1'
 *   makeIdempotencyKey('t1', 'r1', 'n1', 'item', 'h42')   → 't1:r1:n1:item:h42'
 *
 * tenantId DEVE essere il primo segmento — multi-tenant safety quando lo store
 * e\` condiviso (Redis cluster). Senza, due tenant con runId collisione (UUID v4
 * collision e\` astronomicamente improbabile MA non zero — defense-in-depth).
 *
 * Per back-compat con callsite che passavano `(runId, nodeId)` due-arg legacy:
 * usa la signature legacy `makeIdempotencyKeyLegacy` (deprecata). Il middleware
 * `withIdempotency` v3.0 setta automaticamente tenantId dal ctx.
 */
export function makeIdempotencyKey(tenantId: string, runId: string, nodeId: string, ...subKeys: string[]): string {
  return [tenantId, runId, nodeId, ...subKeys].join(':');
}

/**
 * @deprecated Pre-2026-06-03: senza tenantId. Sicuro solo per single-tenant
 * container con processo isolato (container-per-tenant FlowForge). Per Redis
 * store condiviso (multi-pod o multi-tenant) usa `makeIdempotencyKey` con
 * tenantId esplicito. Sostituito automaticamente nei middleware v3.0.
 */
export function makeIdempotencyKeyLegacy(runId: string, nodeId: string, ...subKeys: string[]): string {
  return [runId, nodeId, ...subKeys].join(':');
}
