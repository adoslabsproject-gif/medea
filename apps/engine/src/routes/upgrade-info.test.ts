/**
 * Test 2026-grade — upgrade-info route (portal proxy + cache).
 *
 * 🚨 SOFT-FAIL UX: fetch portal fail → ritorna response neutra (NO error
 *    al banner editor SPA). Test verifica response shape stabile.
 *
 * 🚨 CACHE TTL 5min: 2x request stesso workspaceId → 1 sola fetch.
 *    Cache invalidata su workspaceId diverso.
 *
 * 🚨 AUTH: PORTAL_CALLBACK_TOKEN priorità su MEDEA_INTERNAL_TOKEN (legacy).
 *    Nessuno dei due → fetchFromPortal throw → soft-fail response.
 *
 * 🚨 TENANT REQUIRED: MEDEA_TENANT_ID env mancante → 503 (no fallback).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const logMock = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock('../lib/logger.js', () => ({ loggerFor: () => logMock }));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

const { createUpgradeInfoRoute, _clearCache } = await import('./upgrade-info.js');

async function makeRequest(path: string): Promise<Response> {
  const app = new Hono();
  app.route('/api/v1', createUpgradeInfoRoute());
  return app.request(path);
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearCache();
  delete process.env.MEDEA_TENANT_ID;
  delete process.env.PORTAL_CALLBACK_TOKEN;
  delete process.env.MEDEA_INTERNAL_TOKEN;
  delete process.env.MEDEA_PORTAL_URL;
});

describe('🚨 GET /upgrade-info — guard tenant id', () => {
  it('🚨 MEDEA_TENANT_ID mancante → 503 + ok:false', async () => {
    const res = await makeRequest('/api/v1/upgrade-info');
    expect(res.status).toBe(503);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/tenant id not configured/u);
  });

  it('🚨 MEDEA_TENANT_ID = empty string → 503', async () => {
    process.env.MEDEA_TENANT_ID = '';
    const res = await makeRequest('/api/v1/upgrade-info');
    expect(res.status).toBe(503);
  });
});

describe('🚨 GET /upgrade-info — token configuration', () => {
  beforeEach(() => {
    process.env.MEDEA_TENANT_ID = 'ws-123';
    process.env.MEDEA_PORTAL_URL = 'http://portal:3006';
  });

  it('🚨 PRIORITY: PORTAL_CALLBACK_TOKEN over MEDEA_INTERNAL_TOKEN', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'NEW-TOKEN';
    process.env.MEDEA_INTERNAL_TOKEN = 'LEGACY-TOKEN';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-123', currentVersion: '1.0.0', pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBe('NEW-TOKEN');
  });

  it('🚨 fallback MEDEA_INTERNAL_TOKEN se PORTAL_CALLBACK_TOKEN assente', async () => {
    process.env.MEDEA_INTERNAL_TOKEN = 'LEGACY-TOK';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, workspaceId: 'ws-123', currentVersion: null, pendingUpgrade: null }),
    });
    await makeRequest('/api/v1/upgrade-info');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBe('LEGACY-TOK');
  });

  it('🚨 SOFT-FAIL: nessun token → fetchFromPortal throw → response neutra (NO error UI)', async () => {
    const res = await makeRequest('/api/v1/upgrade-info');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; upgradeAvailable: boolean; pendingUpgrade: null; error: string };
    expect(json.ok).toBe(true);
    expect(json.upgradeAvailable).toBe(false);
    expect(json.pendingUpgrade).toBeNull();
    expect(json.error).toMatch(/PORTAL_CALLBACK_TOKEN nor MEDEA_INTERNAL_TOKEN/u);
  });
});

describe('🚨 GET /upgrade-info — fetch portal success', () => {
  beforeEach(() => {
    process.env.MEDEA_TENANT_ID = 'ws-prod';
    process.env.PORTAL_CALLBACK_TOKEN = 'tok-X';
    process.env.MEDEA_PORTAL_URL = 'http://portal:3006';
  });

  it('🚨 happy: pendingUpgrade non-null → upgradeAvailable=true', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        workspaceId: 'ws-prod',
        currentVersion: '1.5.0',
        pendingUpgrade: {
          latestVersion: '1.6.0',
          releasedAt: '2026-06-08T00:00:00Z',
          releaseNotesMd: '# Upgrade Notes',
          newNodes: ['action_xyz'],
          breakingChanges: [],
          securitySeverity: 'medium',
          isRequired: false,
        },
      }),
    });
    const res = await makeRequest('/api/v1/upgrade-info');
    const json = await res.json() as { ok: boolean; upgradeAvailable: boolean; pendingUpgrade: { latestVersion: string }; portalManageUrl: string };
    expect(json.ok).toBe(true);
    expect(json.upgradeAvailable).toBe(true);
    expect(json.pendingUpgrade.latestVersion).toBe('1.6.0');
    expect(json.portalManageUrl).toBe('https://flowforge.automazionezeli.com/workspaces/ws-prod/runtime');
  });

  it('🚨 pendingUpgrade null → upgradeAvailable=false', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        workspaceId: 'ws-prod',
        currentVersion: '1.5.0',
        pendingUpgrade: null,
      }),
    });
    const res = await makeRequest('/api/v1/upgrade-info');
    const json = await res.json() as { upgradeAvailable: boolean; pendingUpgrade: null };
    expect(json.upgradeAvailable).toBe(false);
    expect(json.pendingUpgrade).toBeNull();
  });

  it('🚨 upgradeInProgress passed-through (graceful overlay UI)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        workspaceId: 'ws-prod',
        currentVersion: '1.5.0',
        upgradeInProgress: true,
        pendingUpgrade: null,
      }),
    });
    const res = await makeRequest('/api/v1/upgrade-info');
    const json = await res.json() as { upgradeInProgress: boolean };
    expect(json.upgradeInProgress).toBe(true);
  });

  it('🚨 upgradeInProgress default false se portal NON include il campo', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-prod', currentVersion: '1.0', pendingUpgrade: null,
      }),
    });
    const res = await makeRequest('/api/v1/upgrade-info');
    const json = await res.json() as { upgradeInProgress: boolean };
    expect(json.upgradeInProgress).toBe(false);
  });

  it('🚨 fetch URL costruito con workspaceId path', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-prod', currentVersion: null, pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('http://portal:3006/api/v1/internal/runtime-status/ws-prod');
  });

  it('🚨 trailing slash portal URL → normalizzato', async () => {
    process.env.MEDEA_PORTAL_URL = 'http://portal:3006/';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-prod', currentVersion: null, pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('//api'); // no doppio slash
  });

  it('🚨 abort timeout 8s configurato', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-prod', currentVersion: null, pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    const opts = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('🚨 GET /upgrade-info — SOFT-FAIL response shape', () => {
  beforeEach(() => {
    process.env.MEDEA_TENANT_ID = 'ws-fail';
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
  });

  it('🚨 portal 500 → soft-fail response stabile + warn log', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('portal blew up'),
    });
    const res = await makeRequest('/api/v1/upgrade-info');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; upgradeAvailable: boolean; currentVersion: null; pendingUpgrade: null };
    expect(json.ok).toBe(true);
    expect(json.upgradeAvailable).toBe(false);
    expect(json.currentVersion).toBeNull();
    expect(json.pendingUpgrade).toBeNull();
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('🚨 network ECONNREFUSED → soft-fail (no propagate)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await makeRequest('/api/v1/upgrade-info');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('🚨 soft-fail include portalManageUrl per CTA fallback UI', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    const res = await makeRequest('/api/v1/upgrade-info');
    const json = await res.json() as { portalManageUrl: string };
    expect(json.portalManageUrl).toContain('ws-fail');
  });
});

describe('🚨 cache TTL 5 min — anti-hammer portal', () => {
  beforeEach(() => {
    process.env.MEDEA_TENANT_ID = 'ws-cache';
    process.env.PORTAL_CALLBACK_TOKEN = 'tok';
  });

  it('🚨 2x request stesso ws → 1 sola fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-cache', currentVersion: '1.0', pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    await makeRequest('/api/v1/upgrade-info');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 second call → response include cached:true', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-cache', currentVersion: '1.0', pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    const res2 = await makeRequest('/api/v1/upgrade-info');
    const json2 = await res2.json() as { cached: boolean };
    expect(json2.cached).toBe(true);
  });

  it('🚨 cache invalidata se workspaceId env change (multi-tenant scenario)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-cache', currentVersion: '1.0', pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    process.env.MEDEA_TENANT_ID = 'ws-DIFFERENT';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-DIFFERENT', currentVersion: '2.0', pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('🚨 soft-fail NON viene cached (retry su prossima call)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fail-1'));
    await makeRequest('/api/v1/upgrade-info');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true, workspaceId: 'ws-cache', currentVersion: '1.0', pendingUpgrade: null,
      }),
    });
    await makeRequest('/api/v1/upgrade-info');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
