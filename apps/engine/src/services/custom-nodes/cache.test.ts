/**
 * Test REAL — cache + event emitter dei custom nodes (Fase 2a hot-reload).
 *
 * Coverage:
 *  - set/get round-trip
 *  - cache miss su key sconosciuta
 *  - TTL soft expiry > 5min
 *  - invalidateCustomNode con defId specifico
 *  - invalidateCustomNode con defId=null → tutti del workspace
 *  - invalidateCustomNode su workspaceId diverso → non tocca le entry altrove
 *  - invalidateAllCustomNodes
 *  - onCustomNodeUpdate riceve l'evento emit
 *  - onCustomNodeUpdate unsubscribe cancella il listener
 *  - customNodeCacheSize tracking
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setCustomNodeCache,
  getCustomNodeCache,
  invalidateCustomNode,
  invalidateAllCustomNodes,
  customNodeCacheSize,
  customNodeCacheStats,
  configureCustomNodeCache,
  onCustomNodeUpdate,
  emitCustomNodeUpdate,
} from './cache.js';

const sampleEntry = (overrides: Record<string, unknown> = {}) => ({
  defId: 'custom_foo',
  workspaceId: 'ws-1',
  semver: '0.1.0',
  compiledExecutor: '(function(){})()',
  sourceDefinition: 'export const definition = {};',
  sourceSchema: 'export const schema = {};',
  status: 'published_priv',
  cachedAt: Date.now(),
  ...overrides,
});

beforeEach(() => {
  // Reset config a defaults grandi così i test esistenti non vengano impattati
  configureCustomNodeCache({ maxEntries: 1024, maxBytes: 16 * 1024 * 1024, ttlMs: 5 * 60 * 1000 });
  invalidateAllCustomNodes();
});
afterEach(() => {
  configureCustomNodeCache({ maxEntries: 1024, maxBytes: 16 * 1024 * 1024, ttlMs: 5 * 60 * 1000 });
  invalidateAllCustomNodes();
});

describe('cache — set/get round-trip', () => {
  it('round-trip semplice', () => {
    setCustomNodeCache(sampleEntry());
    const got = getCustomNodeCache('ws-1', 'custom_foo');
    expect(got).not.toBeNull();
    expect(got!.semver).toBe('0.1.0');
    expect(got!.compiledExecutor).toBe('(function(){})()');
  });

  it('miss su workspaceId sconosciuto', () => {
    setCustomNodeCache(sampleEntry());
    expect(getCustomNodeCache('ws-other', 'custom_foo')).toBeNull();
  });

  it('miss su defId sconosciuto', () => {
    setCustomNodeCache(sampleEntry());
    expect(getCustomNodeCache('ws-1', 'custom_bar')).toBeNull();
  });

  it('isolamento multi-tenant: stesso defId, diversi workspaceId', () => {
    setCustomNodeCache(sampleEntry({ workspaceId: 'ws-1', semver: '1.0.0' }));
    setCustomNodeCache(sampleEntry({ workspaceId: 'ws-2', semver: '2.0.0' }));
    expect(getCustomNodeCache('ws-1', 'custom_foo')!.semver).toBe('1.0.0');
    expect(getCustomNodeCache('ws-2', 'custom_foo')!.semver).toBe('2.0.0');
  });
});

describe('cache — TTL expiry', () => {
  it('entry scaduta (>5min) ritorna null + viene rimossa', () => {
    vi.useFakeTimers();
    setCustomNodeCache(sampleEntry());
    expect(customNodeCacheSize()).toBe(1);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getCustomNodeCache('ws-1', 'custom_foo')).toBeNull();
    expect(customNodeCacheSize()).toBe(0);
    vi.useRealTimers();
  });

  it('entry fresca (< 5min) resta', () => {
    vi.useFakeTimers();
    setCustomNodeCache(sampleEntry());
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(getCustomNodeCache('ws-1', 'custom_foo')).not.toBeNull();
    vi.useRealTimers();
  });
});

describe('cache — invalidate', () => {
  it('invalidate defId specifico tocca solo quel entry', () => {
    setCustomNodeCache(sampleEntry({ defId: 'custom_foo' }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_bar' }));
    invalidateCustomNode('ws-1', 'custom_foo');
    expect(getCustomNodeCache('ws-1', 'custom_foo')).toBeNull();
    expect(getCustomNodeCache('ws-1', 'custom_bar')).not.toBeNull();
  });

  it('invalidate con defId=null elimina tutte le entry del workspace', () => {
    setCustomNodeCache(sampleEntry({ workspaceId: 'ws-1', defId: 'custom_a' }));
    setCustomNodeCache(sampleEntry({ workspaceId: 'ws-1', defId: 'custom_b' }));
    setCustomNodeCache(sampleEntry({ workspaceId: 'ws-2', defId: 'custom_a' }));
    invalidateCustomNode('ws-1', null);
    expect(getCustomNodeCache('ws-1', 'custom_a')).toBeNull();
    expect(getCustomNodeCache('ws-1', 'custom_b')).toBeNull();
    expect(getCustomNodeCache('ws-2', 'custom_a')).not.toBeNull();
  });

  it('invalidateAll svuota la cache', () => {
    setCustomNodeCache(sampleEntry({ defId: 'custom_a' }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_b' }));
    expect(customNodeCacheSize()).toBe(2);
    invalidateAllCustomNodes();
    expect(customNodeCacheSize()).toBe(0);
  });
});

describe('cache — LRU eviction (cap entries)', () => {
  it('oltre maxEntries → evict LRU', () => {
    configureCustomNodeCache({ maxEntries: 3, maxBytes: 1024 * 1024, ttlMs: 60_000 });
    setCustomNodeCache(sampleEntry({ defId: 'custom_a' }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_b' }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_c' }));
    expect(customNodeCacheSize()).toBe(3);
    setCustomNodeCache(sampleEntry({ defId: 'custom_d' }));
    expect(customNodeCacheSize()).toBe(3);
    // custom_a era il più vecchio → evict
    expect(getCustomNodeCache('ws-1', 'custom_a')).toBeNull();
    expect(getCustomNodeCache('ws-1', 'custom_d')).not.toBeNull();
    const s = customNodeCacheStats();
    expect(s.evictions.lru).toBeGreaterThanOrEqual(1);
  });

  it('get promote MRU → la entry non viene più evictata se acceduta', () => {
    configureCustomNodeCache({ maxEntries: 3, maxBytes: 1024 * 1024, ttlMs: 60_000 });
    setCustomNodeCache(sampleEntry({ defId: 'custom_a' }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_b' }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_c' }));
    // Accedo "custom_a" → MRU promote
    expect(getCustomNodeCache('ws-1', 'custom_a')).not.toBeNull();
    // Aggiungo custom_d → evicta custom_b (il più vecchio non promosso)
    setCustomNodeCache(sampleEntry({ defId: 'custom_d' }));
    expect(getCustomNodeCache('ws-1', 'custom_a')).not.toBeNull();
    expect(getCustomNodeCache('ws-1', 'custom_b')).toBeNull();
    expect(getCustomNodeCache('ws-1', 'custom_c')).not.toBeNull();
  });
});

describe('cache — memory cap (LRU per bytes)', () => {
  it('oltre maxBytes → evict per memory', () => {
    // 50 byte per compiledExecutor + 25 + 25 = 100 byte per entry
    const big = '0123456789012345678901234567890123456789012345678'; // 49 char
    configureCustomNodeCache({ maxEntries: 1000, maxBytes: 200, ttlMs: 60_000 });
    setCustomNodeCache(sampleEntry({ defId: 'custom_a', compiledExecutor: big }));
    setCustomNodeCache(sampleEntry({ defId: 'custom_b', compiledExecutor: big }));
    // La terza entry forza eviction memoria
    setCustomNodeCache(sampleEntry({ defId: 'custom_c', compiledExecutor: big }));
    const s = customNodeCacheStats();
    expect(s.evictions.memory).toBeGreaterThanOrEqual(1);
    expect(s.totalBytes).toBeLessThanOrEqual(200);
  });
});

describe('cache — stats observability', () => {
  it('hits/misses tracking', () => {
    configureCustomNodeCache({ maxEntries: 10, maxBytes: 1024 * 1024, ttlMs: 60_000 });
    setCustomNodeCache(sampleEntry({ defId: 'custom_a' }));
    getCustomNodeCache('ws-1', 'custom_a'); // hit
    getCustomNodeCache('ws-1', 'custom_a'); // hit
    getCustomNodeCache('ws-1', 'custom_missing'); // miss
    const s = customNodeCacheStats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
  });

  it('stats snapshot frozen (immutable)', () => {
    const s = customNodeCacheStats();
    expect(() => { (s as { hits: number }).hits = 99; }).toThrow();
  });
});

describe('cache — event emitter', () => {
  it('onCustomNodeUpdate riceve il payload emesso', () => {
    const seen: unknown[] = [];
    const off = onCustomNodeUpdate((ev) => { seen.push(ev); });
    emitCustomNodeUpdate({
      workspaceId: 'ws-1',
      defId: 'custom_foo',
      semver: '0.1.0',
      status: 'published_priv',
      kind: 'updated',
    });
    expect(seen).toHaveLength(1);
    off();
  });

  it('unsubscribe cancella il listener', () => {
    const seen: unknown[] = [];
    const off = onCustomNodeUpdate((ev) => { seen.push(ev); });
    off();
    emitCustomNodeUpdate({
      workspaceId: 'ws-1',
      defId: 'custom_foo',
      semver: '0.1.0',
      status: 'published_priv',
      kind: 'updated',
    });
    expect(seen).toHaveLength(0);
  });
});
