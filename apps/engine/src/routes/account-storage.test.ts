/**
 * account-storage route — metrica uso-blob (gap #13 masterplan).
 *
 * Verifica che /api/v1/account/storage esponga binary.usedBytes da
 * BinaryStore.usage(), e che la probe sia FAIL-SOFT (un errore dello store
 * non rompe la dashboard, ritorna 0).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const binMock = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock('@/services/binary-store.service.js', () => ({
  getBinaryStore: () => binMock,
}));
vi.mock('@/services/storage-quota.service.js', () => ({
  getCurrentQuotas: () => ({
    planCode: 'pro', freeTier: false, totalBytes: 20 * 1024 ** 3,
    workflowDataBytes: 10 * 1024 ** 3, logRetentionBytes: 1 * 1024 ** 3,
  }),
}));
vi.mock('@/config.js', () => ({ loadConfig: () => ({ MEDEA_DATA_DIR: '/tmp/ff-nonexistent-xyz' }) }));
vi.mock('@/lib/logger.js');

import { registerAccountStorageRoute } from './account-storage.js';

function app(): Hono {
  const a = new Hono();
  registerAccountStorageRoute(a);
  return a;
}

beforeEach(() => { binMock.usage.mockReset(); });

describe('GET /account/storage — metrica binary (gap #13)', () => {
  it('espone binary.usedBytes da BinaryStore.usage()', async () => {
    binMock.usage.mockResolvedValue(3 * 1024 * 1024);
    const res = await app().request('/api/v1/account/storage');
    expect(res.status).toBe(200);
    const body = await res.json() as { binary: { usedBytes: number } };
    expect(body.binary.usedBytes).toBe(3 * 1024 * 1024);
  });

  it('🚨 BinaryStore.usage() throwa → fail-soft, binary.usedBytes = 0 (dashboard non rotta)', async () => {
    binMock.usage.mockRejectedValue(new Error('blob dir gone'));
    const res = await app().request('/api/v1/account/storage');
    expect(res.status).toBe(200);
    const body = await res.json() as { binary: { usedBytes: number } };
    expect(body.binary.usedBytes).toBe(0);
  });

  it('mantiene le sezioni storiche (plan, workflowData, log) accanto a binary', async () => {
    binMock.usage.mockResolvedValue(0);
    const res = await app().request('/api/v1/account/storage');
    const body = await res.json() as Record<string, unknown>;
    expect(body.plan).toBeDefined();
    expect(body.workflowData).toBeDefined();
    expect(body.log).toBeDefined();
    expect(body.binary).toBeDefined();
  });
});
