/**
 * Test 2026-grade — Community registry (LRU 5min + stale 1h fallback).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { at } from '@/__testkit__/assert.js';

const safeFetchMock = vi.fn();
vi.mock('@/lib/safe-outbound-fetch.js', () => ({ safeOutboundFetch: safeFetchMock }));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { fetchRegistry, findEntry, clearRegistryCache, RegistryEntrySchema } = await import('./community-registry.service.js');

const validEntry = {
  id: 'community_pdf_tools', vendor: 'vendor-x', version: '1.2.3',
  displayName: 'PDF Tools', description: 'desc here', license: 'MIT',
  downloadUrl: 'https://example.com/pkg.ffnode',
};
const validIndex = { version: 1, updatedAt: '2026-06-07', nodes: [validEntry] };

beforeEach(() => {
  vi.clearAllMocks();
  clearRegistryCache();
  delete process.env.MEDEA_REGISTRY_URL;
});

describe('🚨 RegistryEntrySchema', () => {
  it('🚨 valid base entry', () => {
    expect(RegistryEntrySchema.parse(validEntry).id).toBe(validEntry.id);
  });

  it('🚨 nullable fields acceptable (rating null, category null)', () => {
    const e = { ...validEntry, rating: null, category: null, homepage: null };
    expect(RegistryEntrySchema.parse(e).rating).toBeNull();
  });

  it('🚨 invalid version (no semver) → throw', () => {
    expect(() => RegistryEntrySchema.parse({ ...validEntry, version: '1.0' })).toThrow();
  });

  it('🚨 rating > 5 → throw', () => {
    expect(() => RegistryEntrySchema.parse({ ...validEntry, rating: 6 })).toThrow();
  });

  it('🚨 downloadUrl non URL → throw', () => {
    expect(() => RegistryEntrySchema.parse({ ...validEntry, downloadUrl: 'not-url' })).toThrow();
  });
});

describe('🚨 fetchRegistry — cache TTL', () => {
  it('🚨 happy: parse + cache', async () => {
    safeFetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validIndex) });
    const r = await fetchRegistry();
    expect(r.nodes.length).toBe(1);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.objectContaining({ entries: 1 }), 'Registry refreshed');
  });

  it('🚨 2x fetch entro TTL → 1 sola call', async () => {
    safeFetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validIndex) });
    await fetchRegistry();
    await fetchRegistry();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 force=true → ricarica anche se cached', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validIndex) });
    await fetchRegistry();
    await fetchRegistry(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it('🚨 clearRegistryCache → next fetch hit network', async () => {
    safeFetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(validIndex) });
    await fetchRegistry();
    clearRegistryCache();
    await fetchRegistry();
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('🚨 fetchRegistry — fail-soft con stale cache', () => {
  it('🚨 fetch fail + cache fresh → stale cache returned', async () => {
    safeFetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validIndex) });
    await fetchRegistry();
    safeFetchMock.mockRejectedValueOnce(new Error('network down'));
    const r = await fetchRegistry(true);
    expect(r.nodes.length).toBe(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ ageMs: expect.any(Number) }),
      'Serving stale registry cache',
    );
  });

  it('🚨 fetch fail + NO cache → throw', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchRegistry()).rejects.toThrow('ECONNREFUSED');
  });

  it('🚨 HTTP 500 → throw fallback', async () => {
    safeFetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(fetchRegistry()).rejects.toThrow(/Registry HTTP 500/u);
  });
});

describe('🚨 URL config', () => {
  it('🚨 env MEDEA_REGISTRY_URL override', async () => {
    process.env.MEDEA_REGISTRY_URL = 'https://custom.example.com/r.json';
    safeFetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validIndex) });
    await fetchRegistry();
    expect(safeFetchMock).toHaveBeenCalledWith('https://custom.example.com/r.json', expect.any(Object));
  });

  it('🚨 env vuoto/whitespace → default URL', async () => {
    process.env.MEDEA_REGISTRY_URL = '   ';
    safeFetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(validIndex) });
    await fetchRegistry();
    expect(at(safeFetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('flowforge.nothumanallowed.com');
  });
});

describe('🚨 findEntry', () => {
  beforeEach(() => {
    safeFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: 1, updatedAt: 'x',
        nodes: [
          validEntry,
          { ...validEntry, id: 'other-node', vendor: 'vendor-y' },
        ],
      }),
    });
  });

  it('🚨 happy: trova per vendor+id', async () => {
    const e = await findEntry('vendor-x', 'community_pdf_tools');
    expect(e?.id).toBe('community_pdf_tools');
  });

  it('🚨 vendor mismatch → undefined', async () => {
    expect(await findEntry('wrong-vendor', 'community_pdf_tools')).toBeUndefined();
  });

  it('🚨 id mismatch → undefined', async () => {
    expect(await findEntry('vendor-x', 'no-such-id')).toBeUndefined();
  });
});
