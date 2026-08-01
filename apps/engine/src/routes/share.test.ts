/**
 * Test 2026-grade — share routes (workflow public shareable links).
 *
 * 🚨 SECURITY: redactConfig() strippa key/secret/password/token/credential
 *    case-insensitive. Test verifica TUTTE le variant (uppercase/mixed/embedded).
 *
 * 🚨 ROLE GUARD: viewer NON deve poter creare share link → escalation.
 *    Allowed: owner, admin, editor, superadmin.
 *
 * 🚨 EXPIRY: link scaduti → 410 Gone (NOT 404 — convey to client che link
 *    esisteva ma è expired).
 *
 * 🚨 VIEW COUNTER: ogni GET pubblico incrementa view_count atomicamente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const mockDb = { sqlite: null as DB | null };
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: mockDb.sqlite }),
}));

const workflowsGetMock = vi.fn();
class WorkflowServiceMock {
  get = workflowsGetMock;
}
vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: WorkflowServiceMock,
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-tenant-id') ?? 'tenant-A',
}));

vi.mock('@/lib/actor.js', () => ({
  getActorId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-actor-id') ?? 'actor-1',
}));

const { createShareRoutes } = await import('./share.js');

interface AuthOpts { role?: 'owner' | 'admin' | 'editor' | 'viewer' | 'superadmin' }

function makeApp(authOpts: AuthOpts = {}) {
  const app = new Hono();
  // Auth middleware mocked: setta auth.role per share.ts c.get('auth')
  app.use('*', async (c, next) => {
    if (authOpts.role) c.set('auth' as never, { role: authOpts.role } as never);
    return next();
  });
  app.route('/api/v1', createShareRoutes({} as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.sqlite = new Database(':memory:');
  // Init schema same as source
  mockDb.sqlite.exec(`
    CREATE TABLE workflow_shares (
      token TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      created_by TEXT,
      view_count INTEGER NOT NULL DEFAULT 0
    );
  `);
});

describe('🚨 POST /workflows/:id/shares — role guard', () => {
  beforeEach(() => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: 'Test WF' });
  });

  it('🚨 SECURITY: viewer → 403 ROLE_FORBIDDEN', async () => {
    const app = makeApp({ role: 'viewer' });
    const res = await app.request('/api/v1/workflows/wf-1/shares', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant-A' },
    });
    expect(res.status).toBe(403);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('ROLE_FORBIDDEN');
  });

  it('🚨 SECURITY: nessuna role (auth null) → 403 (default viewer)', async () => {
    const app = makeApp({});
    const res = await app.request('/api/v1/workflows/wf-1/shares', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant-A' },
    });
    expect(res.status).toBe(403);
  });

  it('🚨 editor → 201 token creato', async () => {
    const app = makeApp({ role: 'editor' });
    const res = await app.request('/api/v1/workflows/wf-1/shares', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant-A' },
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { token: string; url: string; expiresAt: string };
    expect(json.token).toMatch(/^[A-Za-z0-9_-]+$/u); // base64url
    expect(json.url).toBe(`/shared/${json.token}`);
    expect(json.expiresAt).toBeDefined();
  });

  it('🚨 owner / admin / superadmin → 201', async () => {
    for (const role of ['owner', 'admin', 'superadmin'] as const) {
      mockDb.sqlite!.exec('DELETE FROM workflow_shares');
      const app = makeApp({ role });
      const res = await app.request('/api/v1/workflows/wf-1/shares', {
        method: 'POST',
        headers: { 'x-tenant-id': 'tenant-A' },
      });
      expect(res.status).toBe(201);
    }
  });
});

describe('🚨 POST /workflows/:id/shares — TTL handling', () => {
  beforeEach(() => {
    workflowsGetMock.mockResolvedValue({ id: 'wf-1', name: 'Test' });
  });

  it('🚨 default ttlDays=30 → expires ~30gg', async () => {
    const app = makeApp({ role: 'editor' });
    const res = await app.request('/api/v1/workflows/wf-1/shares', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant-A' },
    });
    const json = await res.json() as { expiresAt: string };
    const exp = new Date(json.expiresAt).getTime();
    const expected = Date.now() + 30 * 86400_000;
    expect(Math.abs(exp - expected)).toBeLessThan(5000); // ±5s tolerance
  });

  it('🚨 ttlDays=0 → expiresAt null (perma-link)', async () => {
    const app = makeApp({ role: 'editor' });
    const res = await app.request('/api/v1/workflows/wf-1/shares?ttlDays=0', {
      method: 'POST',
    });
    const json = await res.json() as { expiresAt: string | null };
    expect(json.expiresAt).toBeNull();
  });

  it('🚨 ttlDays custom = 7 → expires ~7gg', async () => {
    const app = makeApp({ role: 'editor' });
    const res = await app.request('/api/v1/workflows/wf-1/shares?ttlDays=7', {
      method: 'POST',
    });
    const json = await res.json() as { expiresAt: string };
    const exp = new Date(json.expiresAt).getTime();
    expect(Math.abs(exp - (Date.now() + 7 * 86400_000))).toBeLessThan(5000);
  });
});

describe('🚨 POST workflow not found / bad params', () => {
  it('🚨 workflow inesistente → 404', async () => {
    workflowsGetMock.mockResolvedValue(null);
    const app = makeApp({ role: 'editor' });
    const res = await app.request('/api/v1/workflows/none/shares', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('🚨 GET /workflows/:id/shares — list', () => {
  it('🚨 ritorna shares filtrate per workflow+tenant', async () => {
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('tok-A', 'wf-1', 'tenant-A', new Date().toISOString());
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('tok-B', 'wf-2', 'tenant-A', new Date().toISOString());
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('tok-C', 'wf-1', 'tenant-OTHER', new Date().toISOString());

    const app = makeApp({ role: 'viewer' });
    const res = await app.request('/api/v1/workflows/wf-1/shares', {
      headers: { 'x-tenant-id': 'tenant-A' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { shares: { token: string }[] };
    expect(json.shares).toHaveLength(1);
    expect(json.shares[0]!.token).toBe('tok-A');
  });
});

describe('🚨 DELETE /workflows/:id/shares/:token', () => {
  it('🚨 elimina solo if tenant+workflow match (no cross-tenant)', async () => {
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('tok-OTHER', 'wf-1', 'tenant-OTHER', new Date().toISOString());
    const app = makeApp({ role: 'editor' });
    const res = await app.request('/api/v1/workflows/wf-1/shares/tok-OTHER', {
      method: 'DELETE',
      headers: { 'x-tenant-id': 'tenant-A' },
    });
    expect(res.status).toBe(204);
    // Row OTHER tenant deve restare
    const remaining = mockDb.sqlite!.prepare(
      'SELECT COUNT(*) AS c FROM workflow_shares WHERE token=?',
    ).get('tok-OTHER') as { c: number };
    expect(remaining.c).toBe(1);
  });
});

describe('🚨 GET /public/shared/:token — anonymous viewer', () => {
  it('🚨 token inesistente → 404', async () => {
    const app = makeApp({ role: 'viewer' });
    const res = await app.request('/api/v1/public/shared/non-existent');
    expect(res.status).toBe(404);
  });

  it('🚨 expired → 410 Gone (NON 404)', async () => {
    const expiredAt = new Date(Date.now() - 86400_000).toISOString();
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run('expired-tok', 'wf-1', 'tenant-A', new Date().toISOString(), expiredAt);
    const app = makeApp({});
    const res = await app.request('/api/v1/public/shared/expired-tok');
    expect(res.status).toBe(410);
  });

  it('🚨 workflow gone → 404 "Workflow no longer exists"', async () => {
    workflowsGetMock.mockResolvedValue(null);
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('orphan-tok', 'deleted-wf', 'tenant-A', new Date().toISOString());
    const app = makeApp({});
    const res = await app.request('/api/v1/public/shared/orphan-tok');
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/no longer/u);
  });

  it('🚨 SECURITY redactConfig: keys con "key|secret|password|token|credential" → [REDACTED]', async () => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1',
      name: 'Test',
      description: 'desc',
      schemaVersion: 1,
      nodes: [{
        id: 'n1',
        defId: 'action_http',
        config: {
          url: 'https://example.com',
          api_key: 'sk-SECRET',
          MyToken: 'tok-xyz',
          password: 'pwd',
          credentialRef: 'cred-1',
          xSecretValue: 'shh',
          publicHeader: 'X-Header',
        },
      }],
      edges: [],
      nodeDefs: [],
      createdAt: '2026-06-08',
      updatedAt: '2026-06-08',
    });
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('redact-tok', 'wf-1', 'tenant-A', new Date().toISOString());

    const app = makeApp({});
    const res = await app.request('/api/v1/public/shared/redact-tok');
    expect(res.status).toBe(200);
    const json = await res.json() as { workflow: { nodes: { config: Record<string, string> }[] } };
    const cfg = json.workflow.nodes[0]!.config;
    expect(cfg.url).toBe('https://example.com'); // safe
    expect(cfg.api_key).toBe('[REDACTED]');
    expect(cfg.MyToken).toBe('[REDACTED]');
    expect(cfg.password).toBe('[REDACTED]');
    expect(cfg.credentialRef).toBe('[REDACTED]');
    expect(cfg.xSecretValue).toBe('[REDACTED]');
    expect(cfg.publicHeader).toBe('X-Header'); // safe
  });

  it('🚨 view_count incrementato ad ogni GET pubblico', async () => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1', name: 'X', description: '', schemaVersion: 1,
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '', updatedAt: '',
    });
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('count-tok', 'wf-1', 'tenant-A', new Date().toISOString());

    const app = makeApp({});
    await app.request('/api/v1/public/shared/count-tok');
    await app.request('/api/v1/public/shared/count-tok');
    await app.request('/api/v1/public/shared/count-tok');
    const row = mockDb.sqlite!.prepare(
      'SELECT view_count FROM workflow_shares WHERE token=?',
    ).get('count-tok') as { view_count: number };
    expect(row.view_count).toBe(3);
  });

  it('🚨 response include readOnly:true', async () => {
    workflowsGetMock.mockResolvedValue({
      id: 'wf-1', name: 'X', description: '', schemaVersion: 1,
      nodes: [], edges: [], nodeDefs: [],
      createdAt: '', updatedAt: '',
    });
    mockDb.sqlite!.prepare(
      'INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at) VALUES (?, ?, ?, ?)',
    ).run('ro-tok', 'wf-1', 'tenant-A', new Date().toISOString());

    const app = makeApp({});
    const res = await app.request('/api/v1/public/shared/ro-tok');
    const json = await res.json() as { readOnly: boolean };
    expect(json.readOnly).toBe(true);
  });
});
