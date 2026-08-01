/**
 * Integration del route GET /api/v1/tenant/health — orchestrazione + fail-soft
 * sul COUNT (DB rotto non rompe la response). Il calcolo è già testato in
 * services/tenant-health.service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const cfg = vi.hoisted(() => ({
  FLOWFORGE_TENANT_ID: 't-abc',
  FLOWFORGE_PLAN_CODE: 'pro',
  FLOWFORGE_PLAN_DISK_GB: 20,
  FLOWFORGE_PLAN_VECTOR_MAX_VECTORS: 100000,
  FLOWFORGE_PLAN_VECTOR_MAX_DISK_MB: 512,
}));
const sqliteMock = vi.hoisted(() => ({ prepare: vi.fn() }));
const binaryMock = vi.hoisted(() => ({ usage: vi.fn() }));

vi.mock('@/config.js', () => ({ loadConfig: () => cfg }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: sqliteMock }) }));
vi.mock('@/services/binary-store.service.js', () => ({ getBinaryStore: () => binaryMock }));
vi.mock('@/lib/logger.js');

import { registerTenantHealthRoute } from './tenant-health.js';

function app(): Hono {
  const a = new Hono();
  registerTenantHealthRoute(a);
  return a;
}

beforeEach(() => {
  sqliteMock.prepare.mockReset();
  binaryMock.usage.mockReset();
});

interface HealthResp {
  ok: boolean;
  health: {
    tenantId: string | null;
    plan: { code: string; diskGb: number; vectorMaxVectors: number | null };
    counts: { workflows: number; runs: number };
    storage: { usedBytes: number; totalBytes: number };
    uptimeSeconds: number;
  };
}

describe('GET /api/v1/tenant/health', () => {
  it('200 con piano, counts dal SQLite e storage', async () => {
    sqliteMock.prepare.mockImplementation((sql: string) => ({
      get: () => ({ n: sql.includes('workflows') ? 3 : 42 }),
    }));
    binaryMock.usage.mockResolvedValue(7_000_000);
    const res = await app().request('/api/v1/tenant/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResp;
    expect(body.ok).toBe(true);
    expect(body.health.tenantId).toBe('t-abc');
    expect(body.health.plan.code).toBe('pro');
    expect(body.health.counts).toEqual({ workflows: 3, runs: 42 });
    expect(body.health.storage.usedBytes).toBe(7_000_000);
    expect(body.health.storage.totalBytes).toBe(20 * 1024 ** 3);
    expect(body.health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('🚨 SQLite che lancia → counts 0 (fail-soft), response comunque 200', async () => {
    sqliteMock.prepare.mockImplementation(() => { throw new Error('db locked'); });
    binaryMock.usage.mockResolvedValue(0);
    const res = await app().request('/api/v1/tenant/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResp;
    expect(body.health.counts).toEqual({ workflows: 0, runs: 0 });
  });

  it('🚨 binary usage che lancia → usedBytes 0 (fail-soft), response 200', async () => {
    sqliteMock.prepare.mockImplementation(() => ({ get: () => ({ n: 1 }) }));
    binaryMock.usage.mockRejectedValue(new Error('blob store down'));
    const res = await app().request('/api/v1/tenant/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResp;
    expect(body.health.storage.usedBytes).toBe(0);
  });
});
