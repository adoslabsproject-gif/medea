/**
 * Custom Node Editor — runtime cache LRU + event emitter per hot-reload.
 *
 * Cache in-process del compiledExecutor (+ schema/definition + status) per
 * ridurre round-trip DB. Caratteristiche enterprise 2026:
 *
 *  - Chiave `<workspaceId>:<defId>` → isolamento multi-tenant
 *  - LRU eviction (O(1) via Map iteration order) con cap soft di entry
 *  - TTL soft (5 min) — resilienza ai bypass di invalidate (es. SQL diretto)
 *  - Memory cap soft sui byte di compiledExecutor (default 16 MB totali)
 *  - EventEmitter `'updated'` → SSE dashboard stream UI hot-refresh
 *  - Metrics: size/hits/misses/evictions accessibili per /admin observability
 *
 * Threat model: una tenant ostile con N custom node grossi non puo\` saturare
 * la RAM del container core (cap + LRU evicta sempre il piu\` vecchio).
 *
 * @module services/custom-nodes/cache
 */

import { EventEmitter } from 'node:events';

export interface CompiledCustomNodeEntry {
  defId: string;
  workspaceId: string;
  semver: string;
  compiledExecutor: string;
  sourceDefinition: string;
  sourceSchema: string;
  status: string;
  cachedAt: number;
}

export interface CustomNodeUpdateEvent {
  workspaceId: string;
  defId: string;
  semver: string;
  status: string;
  /** 'updated' (source changed) | 'published' | 'unpublished' | 'archived' | 'rolledback' */
  kind: 'updated' | 'published' | 'unpublished' | 'archived' | 'rolledback';
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: { lru: number; ttl: number; memory: number };
  totalBytes: number;
}

// ─── Configurazione ──────────────────────────────────────────────────────

/** TTL soft per entry (5 minuti). Override via env in `configure()`. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Massimo numero di entry. Oltre, LRU evict del meno usato. */
const DEFAULT_MAX_ENTRIES = 1024;
/** Memoria approssimata totale (bytes UTF-8 dei compiledExecutor + sources). */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

interface Config {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

let config: Config = {
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxBytes: DEFAULT_MAX_BYTES,
};

/**
 * Configura i cap della cache (test + override env-driven al boot).
 * Una chiamata svuota la cache per coerenza (sotto la nuova configurazione).
 */
export function configureCustomNodeCache(opts: Partial<Config>): void {
  config = {
    ttlMs: opts.ttlMs ?? config.ttlMs,
    maxEntries: opts.maxEntries ?? config.maxEntries,
    maxBytes: opts.maxBytes ?? config.maxBytes,
  };
  cache.clear();
  resetStats();
}

// ─── Implementazione LRU ────────────────────────────────────────────────

/**
 * `Map<key, entry>` mantiene insertion order. Quando facciamo `get`/`set`
 * di una entry esistente, la rimuoviamo e re-inseriamo → diventa "most
 * recently used". L'eviction guarda `keys().next().value` = LRU.
 */
const cache = new Map<string, CompiledCustomNodeEntry>();

const stats = {
  hits: 0,
  misses: 0,
  evictLru: 0,
  evictTtl: 0,
  evictMemory: 0,
  totalBytes: 0,
};

function resetStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.evictLru = 0;
  stats.evictTtl = 0;
  stats.evictMemory = 0;
  stats.totalBytes = 0;
}

function key(workspaceId: string, defId: string): string {
  return `${workspaceId}:${defId}`;
}

/** Memoria approssimata occupata da una entry (bytes UTF-8). */
function entrySizeBytes(e: CompiledCustomNodeEntry): number {
  // UTF-8: 1 char ≈ 1 byte per ASCII; per TS code (~ASCII) e\` un'approssimazione safe.
  return e.compiledExecutor.length + e.sourceDefinition.length + e.sourceSchema.length;
}

/** Evicta la entry LRU (Map preserva insertion order → first = oldest). */
function evictLru(): void {
  const oldest = cache.keys().next().value;
  if (oldest === undefined) return;
  const entry = cache.get(oldest);
  if (entry) stats.totalBytes -= entrySizeBytes(entry);
  cache.delete(oldest);
  stats.evictLru++;
}

/**
 * Inserisce/aggiorna una entry. Applica cap entries + cap bytes con LRU evict.
 * MRU-positioning: se key esiste, la rimuoviamo prima per re-insert MRU.
 */
export function setCustomNodeCache(entry: CompiledCustomNodeEntry): void {
  const k = key(entry.workspaceId, entry.defId);
  const existing = cache.get(k);
  if (existing) {
    stats.totalBytes -= entrySizeBytes(existing);
    cache.delete(k);
  }
  const fresh: CompiledCustomNodeEntry = { ...entry, cachedAt: Date.now() };
  const size = entrySizeBytes(fresh);
  // Pre-evict per fare spazio se la nuova entry sfora il memory cap da sola
  while (stats.totalBytes + size > config.maxBytes && cache.size > 0) {
    evictLru();
    stats.evictMemory++;
  }
  cache.set(k, fresh);
  stats.totalBytes += size;
  // Cap entries
  while (cache.size > config.maxEntries) {
    evictLru();
  }
}

/**
 * Read-through cache: ritorna l'entry se presente e fresca, MRU-promote
 * (re-insert per portarla in cima alla LRU order). TTL scaduto → evict + null.
 */
export function getCustomNodeCache(
  workspaceId: string,
  defId: string,
): CompiledCustomNodeEntry | null {
  const k = key(workspaceId, defId);
  const e = cache.get(k);
  if (!e) {
    stats.misses++;
    return null;
  }
  if (Date.now() - e.cachedAt > config.ttlMs) {
    cache.delete(k);
    stats.totalBytes -= entrySizeBytes(e);
    stats.evictTtl++;
    stats.misses++;
    return null;
  }
  // MRU promote: re-insert → diventa most recently used
  cache.delete(k);
  cache.set(k, e);
  stats.hits++;
  return e;
}

/**
 * Invalida una singola entry. `defId` puo\` essere null se non si conosce
 * (es. caller ha solo l'id custom node) — in quel caso elimina tutte le
 * entry del workspace come fallback safe.
 */
export function invalidateCustomNode(workspaceId: string, defId: string | null): void {
  if (defId) {
    const k = key(workspaceId, defId);
    const e = cache.get(k);
    if (e) {
      stats.totalBytes -= entrySizeBytes(e);
      cache.delete(k);
    }
    return;
  }
  // Fallback: elimina tutte le entry del workspace
  const prefix = `${workspaceId}:`;
  for (const [k, e] of cache) {
    if (k.startsWith(prefix)) {
      stats.totalBytes -= entrySizeBytes(e);
      cache.delete(k);
    }
  }
}

export function invalidateAllCustomNodes(): void {
  cache.clear();
  stats.totalBytes = 0;
}

/** Snapshot count — per testing/observability. */
export function customNodeCacheSize(): number {
  return cache.size;
}

/**
 * Statistiche cache per observability (`/admin/sentinel-live` o metric scrape).
 * Snapshot immutabile — caller non puo\` modificare lo stato interno.
 */
export function customNodeCacheStats(): Readonly<CacheStats> {
  return Object.freeze({
    size: cache.size,
    hits: stats.hits,
    misses: stats.misses,
    evictions: Object.freeze({
      lru: stats.evictLru,
      ttl: stats.evictTtl,
      memory: stats.evictMemory,
    }),
    totalBytes: stats.totalBytes,
  });
}

// ─── Event emitter ──────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(64);

export function onCustomNodeUpdate(
  listener: (ev: CustomNodeUpdateEvent) => void,
): () => void {
  emitter.on('updated', listener);
  return () => { emitter.off('updated', listener); };
}

export function emitCustomNodeUpdate(ev: CustomNodeUpdateEvent): void {
  emitter.emit('updated', ev);
}
