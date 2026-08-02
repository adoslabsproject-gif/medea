/**
 * Test 2026-grade — Portal Client per Shared Workflow Templates.
 *
 * AUTH: x-internal-token + PORTAL_CALLBACK_TOKEN > MEDEA_INTERNAL_TOKEN.
 * GRACEFUL: tutti i metodi catch + return null/false (graceful degrade).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { at } from '@/__testkit__/assert.js';

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.MEDEA_PORTAL_URL;
  delete process.env.PORTAL_CALLBACK_TOKEN;
  delete process.env.MEDEA_INTERNAL_TOKEN;
});

async function load() {
  return import('./portal-client.js');
}

describe('🚨 no token configured → warn + return null', () => {
  it('🚨 promoteToCommunity → null', async () => {
    const m = await load();
    const r = await m.promoteToCommunity({} as any);
    expect(r).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('MEDEA_INTERNAL_TOKEN not set'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('🚨 token resolution', () => {
  it('🚨 PORTAL_CALLBACK_TOKEN precedence', async () => {
    process.env.PORTAL_CALLBACK_TOKEN = 'shared-token';
    process.env.MEDEA_INTERNAL_TOKEN = 'per-tenant-token';
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const m = await load();
    await m.recordCommunityImport('tpl-1');
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as any;
    expect(headers['x-internal-token']).toBe('shared-token');
  });

  it('🚨 MEDEA_INTERNAL_TOKEN fallback', async () => {
    process.env.MEDEA_INTERNAL_TOKEN = 'per-tenant';
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const m = await load();
    await m.recordCommunityImport('tpl-1');
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as any;
    expect(headers['x-internal-token']).toBe('per-tenant');
  });
});

describe('🚨 promoteToCommunity', () => {
  beforeEach(() => { process.env.MEDEA_INTERNAL_TOKEN = 'token'; });

  it('🚨 POST /api/v1/internal/templates/promote con body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, id: 'tpl-x', isNew: true }),
    });
    const m = await load();
    const req: any = {
      name: 'My Tpl', language: 'it', graphSignature: 'sig',
      graphDefIds: ['http'], workflowJson: {}, promptText: 'P', promptTokens: ['t'],
      sourceWorkspaceId: 'ws-1',
    };
    const r = await m.promoteToCommunity(req);
    expect(r?.id).toBe('tpl-x');
    expect(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]).toContain('/api/v1/internal/templates/promote');
    const body = JSON.parse((at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).body as string);
    expect(body.name).toBe('My Tpl');
  });

  it('🚨 non-2xx → null + warn log', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('busy') });
    const m = await load();
    expect(await m.promoteToCommunity({} as any)).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }), expect.any(String));
  });

  it('🚨 fetch throw → null (graceful)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const m = await load();
    expect(await m.promoteToCommunity({} as any)).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      expect.any(String),
    );
  });
});

describe('🚨 retrieveFromCommunity', () => {
  beforeEach(() => { process.env.MEDEA_INTERNAL_TOKEN = 'token'; });

  it('🚨 happy: templates parsed', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, templates: [{ id: 't1' }], count: 1 }),
    });
    const m = await load();
    const r = await m.retrieveFromCommunity({ language: 'it', limit: 5 });
    expect(r?.count).toBe(1);
  });
});

describe('🚨 recordCommunityImport + unshareFromCommunity', () => {
  beforeEach(() => { process.env.MEDEA_INTERNAL_TOKEN = 'token'; });

  it('🚨 import ok=true → return true', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const m = await load();
    expect(await m.recordCommunityImport('tpl')).toBe(true);
  });

  it('🚨 import response ok=false → return false', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: false }) });
    const m = await load();
    expect(await m.recordCommunityImport('tpl')).toBe(false);
  });

  it('🚨 import network fail → false', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const m = await load();
    expect(await m.recordCommunityImport('tpl')).toBe(false);
  });

  it('🚨 unshare con reason', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const m = await load();
    expect(await m.unshareFromCommunity({ templateId: 't', sourceWorkspaceId: 'ws', reason: 'GDPR' })).toBe(true);
    const body = JSON.parse((at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).body as string);
    expect(body.reason).toBe('GDPR');
  });
});

describe('🚨 timeout', () => {
  it('🚨 AbortSignal.timeout(5000) usato', async () => {
    process.env.MEDEA_INTERNAL_TOKEN = 'token';
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const m = await load();
    await m.recordCommunityImport('tpl');
    expect((at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).signal).toBeDefined();
  });
});
