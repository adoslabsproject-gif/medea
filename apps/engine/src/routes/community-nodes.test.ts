/**
 * Test 2026-grade — community-nodes route.
 *
 * 🚨 SECURITY: requireRole('owner') GLOBAL — installing 3rd-party code è
 *    privilegio max. Owner/superadmin OK; admin/editor/viewer → 403.
 *
 * 🚨 INSTALL Zod union: { url } | { base64 } | { registryId, vendor }
 *  - url must be valid URL
 *  - base64 must be non-empty string
 *  - registryId + vendor entrambi richiesti
 *
 * 🚨 EVENT EMIT: install/uninstall → emitCommunityNodesChanged (palette refresh)
 *
 * 🚨 REGISTRY: enrich entries con installed:true|false (no 2nd roundtrip)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { Hono } from 'hono';

vi.mock('@/middleware/rbac.js', () => ({
  requireRole: (role: string) => async (c: { get: (k: string) => { role?: string } | undefined }, next: () => Promise<void>) => {
    const auth = c.get('auth');
    if (!auth) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const roleHierarchy = ['viewer', 'editor', 'admin', 'owner', 'superadmin'];
    const userLevel = roleHierarchy.indexOf(auth.role ?? 'viewer');
    const requiredLevel = roleHierarchy.indexOf(role);
    if (userLevel < requiredLevel) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return next();
  },
}));

const installFromBufferMock = vi.fn();
const installFromUrlMock = vi.fn();
const uninstallMock = vi.fn();
const listInstalledMock = vi.fn();
const getInstalledMock = vi.fn();
vi.mock('@/services/community-nodes.service.js', () => ({
  installFromBuffer: installFromBufferMock,
  installFromUrl: installFromUrlMock,
  uninstall: uninstallMock,
  listInstalled: listInstalledMock,
  getInstalled: getInstalledMock,
}));

const emitCommunityNodesChangedMock = vi.fn();
vi.mock('@/services/community-nodes-events.js', () => ({
  emitCommunityNodesChanged: emitCommunityNodesChangedMock,
}));

const fetchRegistryMock = vi.fn();
const findEntryMock = vi.fn();
const clearRegistryCacheMock = vi.fn();
vi.mock('@/services/community-registry.service.js', () => ({
  fetchRegistry: fetchRegistryMock,
  findEntry: findEntryMock,
  clearRegistryCache: clearRegistryCacheMock,
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { createCommunityNodesRoutes } = await import('./community-nodes.js');

function makeApp(role: 'viewer' | 'editor' | 'admin' | 'owner' | 'superadmin' = 'owner'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { role, userId: 'u1' } as never);
    return next();
  });
  app.route('/cn', createCommunityNodesRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listInstalledMock.mockReturnValue([]);
});

describe('🚨 SECURITY: owner-only RBAC global', () => {
  it('🚨 viewer → 403 su GET /installed', async () => {
    const res = await makeApp('viewer').request('/cn/installed');
    expect(res.status).toBe(403);
  });

  it('🚨 editor → 403 su POST /install', async () => {
    const res = await makeApp('editor').request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/pkg.ffnode' }),
    });
    expect(res.status).toBe(403);
  });

  it('🚨 admin → 403 (NON owner)', async () => {
    const res = await makeApp('admin').request('/cn/installed');
    expect(res.status).toBe(403);
  });

  it('🚨 owner → 200 access ok', async () => {
    const res = await makeApp('owner').request('/cn/installed');
    expect(res.status).toBe(200);
  });

  it('🚨 superadmin → 200 (hierarchy higher than owner)', async () => {
    const res = await makeApp('superadmin').request('/cn/installed');
    expect(res.status).toBe(200);
  });
});

describe('🚨 GET /installed', () => {
  it('🚨 vuoto → []', async () => {
    const res = await makeApp().request('/cn/installed');
    const json = await res.json() as { nodes: unknown[]; total: number };
    expect(json.nodes).toEqual([]);
    expect(json.total).toBe(0);
  });

  it('🚨 mapping completo: manifest fields + actionsCount + verified', async () => {
    listInstalledMock.mockReturnValue([{
      manifest: {
        vendor: 'acme', id: 'foo', version: '1.0.0',
        displayName: 'Foo Node', description: 'desc',
        license: 'MIT', homepage: 'https://x.com', category: 'data',
      },
      installedAt: '2026-06-08T10:00:00Z',
      verified: true,
      def: { actions: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] },
    }]);
    const res = await makeApp().request('/cn/installed');
    const json = await res.json() as { nodes: { vendor: string; actionsCount: number; verified: boolean }[] };
    expect(json.nodes[0]).toMatchObject({
      vendor: 'acme', id: 'foo', version: '1.0.0',
      verified: true, actionsCount: 3,
    });
  });

  it('🚨 actionsCount default 0 se def.actions undefined', async () => {
    listInstalledMock.mockReturnValue([{
      manifest: { vendor: 'a', id: 'b', version: '1' },
      def: {}, installedAt: '', verified: false,
    }]);
    const res = await makeApp().request('/cn/installed');
    const json = await res.json() as { nodes: { actionsCount: number }[] };
    expect(json.nodes[0]!.actionsCount).toBe(0);
  });
});

describe('🚨 GET /:vendor/:id — detail', () => {
  it('🚨 NOT installed → 404', async () => {
    getInstalledMock.mockReturnValue(null);
    const res = await makeApp().request('/cn/acme/foo');
    expect(res.status).toBe(404);
  });

  it('🚨 happy: ritorna manifest+def+readme+iconSvg+verified+installedAt', async () => {
    getInstalledMock.mockReturnValue({
      manifest: { vendor: 'acme', id: 'foo', version: '1.0.0' },
      def: { actions: [] },
      readmeMd: '# README',
      iconSvg: '<svg/>',
      verified: true,
      installedAt: '2026-06-08T10:00:00Z',
    });
    const res = await makeApp().request('/cn/acme/foo');
    const json = await res.json() as { readme: string; iconSvg: string; verified: boolean };
    expect(json.readme).toBe('# README');
    expect(json.iconSvg).toBe('<svg/>');
    expect(json.verified).toBe(true);
  });

  it('🚨 readme/iconSvg undefined → null (NO undefined leak in JSON)', async () => {
    getInstalledMock.mockReturnValue({
      manifest: { vendor: 'a', id: 'b' }, def: {},
      verified: false, installedAt: '',
    });
    const res = await makeApp().request('/cn/a/b');
    const json = await res.json() as { readme: null; iconSvg: null };
    expect(json.readme).toBeNull();
    expect(json.iconSvg).toBeNull();
  });
});

describe('🚨 POST /install — Zod union validation', () => {
  it('🚨 body url valida → installFromUrl chiamato', async () => {
    installFromUrlMock.mockResolvedValue({
      manifest: { vendor: 'acme', id: 'foo', version: '1' },
      verified: true,
    });
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://registry.example/pkg.ffnode' }),
    });
    expect(res.status).toBe(201);
    expect(installFromUrlMock).toHaveBeenCalledWith('https://registry.example/pkg.ffnode');
    expect(emitCommunityNodesChangedMock).toHaveBeenCalled();
  });

  it('🚨 body url non valida → 400', async () => {
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 body base64 → installFromBuffer + decode', async () => {
    installFromBufferMock.mockResolvedValue({
      manifest: { vendor: 'acme', id: 'foo', version: '1' },
      verified: false,
    });
    const b64 = Buffer.from('zip-content').toString('base64');
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: b64 }),
    });
    expect(res.status).toBe(201);
    const bufArg = installFromBufferMock.mock.calls[0]![0] as Buffer;
    expect(bufArg.toString('utf8')).toBe('zip-content');
  });

  it('🚨 body base64 vuoto → 400', async () => {
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 body registryId+vendor → findEntry + installFromUrl', async () => {
    findEntryMock.mockResolvedValue({ downloadUrl: 'https://reg/abc.ffnode' });
    installFromUrlMock.mockResolvedValue({
      manifest: { vendor: 'acme', id: 'foo', version: '1' },
      verified: true,
    });
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registryId: 'foo', vendor: 'acme' }),
    });
    expect(res.status).toBe(201);
    expect(findEntryMock).toHaveBeenCalledWith('acme', 'foo');
    expect(installFromUrlMock).toHaveBeenCalledWith('https://reg/abc.ffnode');
  });

  it('🚨 registry findEntry returns null → 404 con messaggio descrittivo', async () => {
    findEntryMock.mockResolvedValue(null);
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registryId: 'ghost', vendor: 'acme' }),
    });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/"acme\/ghost".*non trovato/u);
  });

  it('🚨 install throw → 400 + warn log + NO emit event', async () => {
    installFromUrlMock.mockRejectedValue(new Error('signature verification failed'));
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.com/bad.ffnode' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('signature verification failed');
    expect(emitCommunityNodesChangedMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('🚨 install throw non-Error → coerced a String', async () => {
    installFromUrlMock.mockRejectedValue('raw-string-err');
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.com/p.ffnode' }),
    });
    const json = await res.json() as { error: string };
    expect(json.error).toBe('raw-string-err');
  });

  it('🚨 body invalid (NONE of url/base64/registryId+vendor) → 400', async () => {
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrongField: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 registryId solo SENZA vendor → 400 (entrambi richiesti)', async () => {
    const res = await makeApp().request('/cn/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registryId: 'foo' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('🚨 GET /registry', () => {
  it('🚨 enrich entries con installed:true|false', async () => {
    listInstalledMock.mockReturnValue([{
      manifest: { vendor: 'acme', id: 'foo' }, def: {}, installedAt: '', verified: true,
    }]);
    fetchRegistryMock.mockResolvedValue({
      updatedAt: '2026-06-08',
      nodes: [
        { vendor: 'acme', id: 'foo', displayName: 'Foo' },
        { vendor: 'other', id: 'bar', displayName: 'Bar' },
      ],
    });
    const res = await makeApp().request('/cn/registry');
    const json = await res.json() as { nodes: { vendor: string; installed: boolean }[] };
    expect(json.nodes[0]!.installed).toBe(true);
    expect(json.nodes[1]!.installed).toBe(false);
  });

  it('🚨 registry unreachable → 502 con details', async () => {
    fetchRegistryMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await makeApp().request('/cn/registry');
    expect(res.status).toBe(502);
    const json = await res.json() as { error: string; details: string };
    expect(json.error).toMatch(/Registry non raggiungibile/u);
    expect(json.details).toBe('ECONNREFUSED');
  });
});

describe('🚨 POST /registry/refresh', () => {
  it('🚨 clearRegistryCache chiamato + fetchRegistry(true) force', async () => {
    fetchRegistryMock.mockResolvedValue({ nodes: [{ vendor: 'a', id: 'b' }] });
    const res = await makeApp().request('/cn/registry/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(clearRegistryCacheMock).toHaveBeenCalled();
    expect(fetchRegistryMock).toHaveBeenCalledWith(true);
    const json = await res.json() as { total: number };
    expect(json.total).toBe(1);
  });

  it('🚨 fetchRegistry throw → 502', async () => {
    fetchRegistryMock.mockRejectedValue(new Error('registry down'));
    const res = await makeApp().request('/cn/registry/refresh', { method: 'POST' });
    expect(res.status).toBe(502);
  });
});

describe('🚨 DELETE /:vendor/:id — uninstall', () => {
  it('🚨 happy: uninstall + emit event + ok:true', async () => {
    uninstallMock.mockResolvedValue(undefined);
    const res = await makeApp().request('/cn/acme/foo', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(uninstallMock).toHaveBeenCalledWith('acme', 'foo');
    expect(emitCommunityNodesChangedMock).toHaveBeenCalled();
  });

  it('🚨 uninstall throw → 404 con message + NO emit event', async () => {
    uninstallMock.mockRejectedValue(new Error('package not found'));
    const res = await makeApp().request('/cn/ghost/x', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('package not found');
    expect(emitCommunityNodesChangedMock).not.toHaveBeenCalled();
  });
});
