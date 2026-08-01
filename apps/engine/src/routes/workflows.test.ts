/**
 * Test 2026-grade — workflows route (17 endpoint, file 883 LOC).
 *
 * Coverage REALE Hono pipeline + WorkflowService/EstimatorService/aiScaffold/
 * tenantService/computeAutoLayout/dbStudio/pending-secrets/global-variables
 * mockati. Tutti i 17 endpoint coperti con happy + edge cases security.
 *
 * Highlights:
 *  - GET /: superadmin cross-tenant flag (listAllAcrossTenants)
 *  - GET /:id: superadmin getByIdAnyTenant, draft caricato in payload
 *  - GET /:id/pending-secrets: 404, scan via analyzePendingSecrets dynamic import
 *  - PATCH /:id/draft: 400 JSON malformato, 404 not found, savedAt response
 *  - GET /:id/error-workflow: 404 + happy
 *  - PATCH /:id/error-workflow: 🚨 anti-self-loop (errorWorkflowId === id),
 *    404 target non trovato nel tenant, null = remove binding
 *  - POST /:id/discard-draft: 404
 *  - GET /:id/export: filename sanitizzato anti-path-traversal
 *  - POST /import: 400 bundle malformato, IMPORT_FAILED su throw
 *  - POST /: 🚨 quota enforcement su enabled=true (402 WORKFLOW_QUOTA_EXCEEDED),
 *    TENANT_NOT_FOUND 404, tablesToCreate happy path + isDuplicate idempotent
 *  - PUT /:id: 🚨 quota su enable transition (false→true), CONFIG MERGE
 *    preservante (R-recurring bug)
 *  - POST /:id/apply-ai-patch: updateNodes + addNodes + removeNodes cascade
 *    edges, addEdges con from/to validation, issues array popolato
 *  - DELETE /:id: 204, 404
 *  - POST /:id/auto-layout: 404, persist nodes layout + stats, persist fail 500
 *  - POST /:id/estimate: 404, body parse tollerant, estimator throw 500
 *  - POST /ai-scaffold: 400 goal missing/non-string, AiScaffoldError httpStatus
 *  - POST /ai-scaffold/stream: SSE response (Content-Type, eventi)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => {
  class QuotaExceededError extends Error {
    override name = 'QuotaExceededError';
    kind: string; limit: number; current: number;
    constructor(msg: string, kind = 'workflows', limit = 0, current = 0) {
      super(msg); this.kind = kind; this.limit = limit; this.current = current;
    }
  }
  class TenantNotFoundError extends Error { override name = 'TenantNotFoundError'; }
  class AiScaffoldError extends Error {
    override name = 'AiScaffoldError';
    httpStatus: number;
    constructor(msg: string, httpStatus = 500) { super(msg); this.httpStatus = httpStatus; }
  }
  return {
    QuotaExceededError, TenantNotFoundError, AiScaffoldError,
    list: vi.fn(),
    listAllAcrossTenants: vi.fn(),
    get: vi.fn(),
    getByIdAnyTenant: vi.fn(),
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    discardDraft: vi.fn(),
    getErrorWorkflowId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    exportBundle: vi.fn(),
    importBundle: vi.fn(),
    checkQuota: vi.fn(),
    aiScaffoldRun: vi.fn(),
    autoLayout: vi.fn(),
    estimatorEstimate: vi.fn(),
    dbStudioList: vi.fn(),
    dbStudioCreate: vi.fn(),
    dbStudioApplyMigration: vi.fn(),
    analyzePendingSecrets: vi.fn(),
    globalVariablesList: vi.fn(),
    getActorId: vi.fn(),
    getTenantId: vi.fn(),
  };
});

vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: class {
    constructor(_bus: unknown) { void _bus; }
    list(t: string) { return m.list(t); }
    listAllAcrossTenants() { return m.listAllAcrossTenants(); }
    get(id: string, t: string) { return m.get(id, t); }
    getByIdAnyTenant(id: string) { return m.getByIdAnyTenant(id); }
    getDraft(id: string, t: string) { return m.getDraft(id, t); }
    saveDraft(id: string, p: unknown, t: string) { return m.saveDraft(id, p, t); }
    discardDraft(id: string, t: string) { return m.discardDraft(id, t); }
    getErrorWorkflowId(id: string, t: string) { return m.getErrorWorkflowId(id, t); }
    create(args: unknown) { return m.create(args); }
    update(id: string, p: unknown, t: string) { return m.update(id, p, t); }
    delete(id: string, t: string, a?: string) { return m.delete(id, t, a); }
    exportBundle(id: string, t: string) { return m.exportBundle(id, t); }
    importBundle(b: unknown, t: string, a?: string) { return m.importBundle(b, t, a); }
  },
}));

vi.mock('@/services/estimator.service.js', () => ({
  EstimatorService: class {
    estimate(args: unknown) { return m.estimatorEstimate(args); }
  },
}));

vi.mock('@/services/ai-scaffold.service.js', () => ({
  AiScaffoldError: m.AiScaffoldError,
  aiScaffold: { scaffold: (...a: unknown[]) => m.aiScaffoldRun(...a) },
}));

vi.mock('@/services/auto-layout.service.js', () => ({
  autoLayout: (...a: unknown[]) => m.autoLayout(...a),
}));

vi.mock('@/services/tenant.service.js', () => ({
  QuotaExceededError: m.QuotaExceededError,
  TenantNotFoundError: m.TenantNotFoundError,
  tenantService: { checkQuota: (t: string, k: string) => m.checkQuota(t, k) },
}));

vi.mock('@/lib/logger.js');

vi.mock('@/services/db-studio.service.js', () => ({
  DbStudioService: class {
    list(t: string) { return m.dbStudioList(t); }
    create(input: unknown) { return m.dbStudioCreate(input); }
    applyMigration(dbId: string, actions: unknown, t: string) { return m.dbStudioApplyMigration(dbId, actions, t); }
  },
}));

vi.mock('@/services/ai-scaffold/pending-secrets.js', () => ({
  analyzePendingSecrets: (args: unknown) => m.analyzePendingSecrets(args),
}));

vi.mock('@/services/global-variables.service.js', () => ({
  GlobalVariablesService: class {
    list(t: string) { return m.globalVariablesList(t); }
  },
}));

import { createWorkflowRoutes } from './workflows.js';
import type { AuthContext } from '@/middleware/auth.js';

function buildApp(auth: Partial<AuthContext> | null): Hono {
  const bus = { emit: vi.fn() } as never;
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) {
      const full: AuthContext = { userId: 'u1', email: 'e@x', tenantId: 't1', role: 'owner', ...auth } as AuthContext;
      c.set('auth', full);
    }
    await next();
  });
  app.route('/', createWorkflowRoutes(bus));
  return app;
}

const baseWf = {
  id: 'wf-1', tenantId: 't1', name: 'WF', description: '',
  enabled: false, nodes: [], edges: [], nodeDefs: [],
  tags: [], folderId: null, onError: null, concurrencyLimit: 0,
  createdAt: '2026', updatedAt: '2026',
};

beforeEach(() => {
  Object.values(m).forEach((f) => { if (typeof f === 'function' && 'mockReset' in f) (f as { mockReset: () => void }).mockReset(); });
  m.list.mockResolvedValue([]);
  m.listAllAcrossTenants.mockResolvedValue([]);
  m.get.mockResolvedValue(baseWf);
  m.getByIdAnyTenant.mockResolvedValue(baseWf);
  m.getDraft.mockResolvedValue(null);
  m.create.mockResolvedValue(baseWf);
  m.update.mockResolvedValue(baseWf);
  m.delete.mockResolvedValue(true);
  m.saveDraft.mockResolvedValue({ savedAt: '2026-06-07T00:00:00Z' });
  m.discardDraft.mockResolvedValue(true);
  m.getErrorWorkflowId.mockResolvedValue(null);
  m.exportBundle.mockResolvedValue({ workflow: { name: 'wf-export' }, schemaVersion: '1.0' });
  m.importBundle.mockResolvedValue({ workflow: baseWf, warnings: [] });
  m.checkQuota.mockReturnValue(undefined);
  m.analyzePendingSecrets.mockReturnValue([]);
  m.globalVariablesList.mockReturnValue([]);
  m.dbStudioList.mockReturnValue([]);
  m.dbStudioCreate.mockReturnValue({ id: 'db-ondemand', tenantId: 't1' });
  m.dbStudioApplyMigration.mockResolvedValue({ sql: 'OK', affectedTables: [] });
  m.autoLayout.mockResolvedValue({ nodes: [], stats: { width: 800, height: 600 } });
  m.estimatorEstimate.mockReturnValue({ costUsd: 0.05, etaMs: 1000 });
  m.aiScaffoldRun.mockResolvedValue({ workflow: { nodes: [], edges: [] } });
});

describe('GET / — list workflows + cross-tenant', () => {
  it('🚨 superadmin senza header → listAllAcrossTenants, crossTenant=true', async () => {
    m.listAllAcrossTenants.mockResolvedValue([baseWf, { ...baseWf, id: 'wf-2', tenantId: 't2' }]);
    const res = await buildApp({ role: 'superadmin', tenantId: 'platform' }).request('/');
    const body = await res.json() as { crossTenant: boolean; total: number };
    expect(body.crossTenant).toBe(true);
    expect(body.total).toBe(2);
    expect(m.listAllAcrossTenants).toHaveBeenCalled();
  });

  it('owner → list tenant-scoped', async () => {
    m.list.mockResolvedValue([baseWf]);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/');
    const body = await res.json() as { crossTenant: boolean };
    expect(body.crossTenant).toBe(false);
    expect(m.list).toHaveBeenCalledWith('t1');
  });

  it('superadmin con x-tenant-id → list scoped (impersonate)', async () => {
    const res = await buildApp({ role: 'superadmin', tenantId: 'platform' }).request('/', {
      headers: { 'x-tenant-id': 't1' },
    });
    const body = await res.json() as { crossTenant: boolean };
    expect(body.crossTenant).toBe(false);
    expect(m.list).toHaveBeenCalled();
  });
});

describe('GET /:id — workflow + draft', () => {
  it('🚨 superadmin senza header → getByIdAnyTenant', async () => {
    const res = await buildApp({ role: 'superadmin', tenantId: 'platform' }).request('/wf-1');
    expect(res.status).toBe(200);
    expect(m.getByIdAnyTenant).toHaveBeenCalledWith('wf-1');
  });

  it('owner → get tenant-scoped', async () => {
    await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1');
    expect(m.get).toHaveBeenCalledWith('wf-1', 't1');
  });

  it('404 se non trovato', async () => {
    m.get.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-fake');
    expect(res.status).toBe(404);
  });

  it('payload include draft (anche null)', async () => {
    m.getDraft.mockResolvedValue({ savedAt: '2026', nodes: [] });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1');
    const body = await res.json() as { workflow: unknown; draft: unknown };
    expect(body.workflow).toBeDefined();
    expect(body.draft).toBeDefined();
  });
});

describe('GET /:id/pending-secrets', () => {
  it('404 se workflow non trovato', async () => {
    m.get.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/pending-secrets');
    expect(res.status).toBe(404);
  });

  it('happy: lista pending + configured set', async () => {
    m.get.mockResolvedValue({ ...baseWf, nodes: [{ id: 'n1', config: { token: '{{secrets.SLACK}}' } }] });
    m.globalVariablesList.mockReturnValue([{ name: 'OPENAI_KEY' }]);
    m.analyzePendingSecrets.mockReturnValue([{ name: 'SLACK', referencedBy: ['n1'], fields: ['token'] }]);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/pending-secrets');
    expect(res.status).toBe(200);
    const body = await res.json() as { pending: unknown[]; total: number };
    expect(body.total).toBe(1);
    const args = m.analyzePendingSecrets.mock.calls[0]![0] as { configuredSecrets: Set<string> };
    expect(args.configuredSecrets.has('OPENAI_KEY')).toBe(true);
  });
});

describe('PATCH /:id/draft — autosave', () => {
  it('400 JSON non valido', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/draft', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('404 saveDraft returns null', async () => {
    m.saveDraft.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/draft', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('happy: ritorna savedAt', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/draft', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'n1' }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { savedAt: string }).savedAt).toBeDefined();
  });
});

describe('GET + PATCH /:id/error-workflow', () => {
  it('GET 404 se workflow non esiste', async () => {
    m.get.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/error-workflow');
    expect(res.status).toBe(404);
  });

  it('GET happy: errorWorkflowId', async () => {
    m.getErrorWorkflowId.mockResolvedValue('wf-error');
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/error-workflow');
    expect(await res.json()).toEqual({ errorWorkflowId: 'wf-error' });
  });

  it('🚨 PATCH anti-self loop (errorWorkflowId === id) → 400', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/error-workflow', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ errorWorkflowId: 'wf-1' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('Anti-self');
  });

  it('PATCH 404 se target error workflow non esiste nel tenant', async () => {
    m.get.mockImplementation(async (id: string) => id === 'wf-1' ? baseWf : null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/error-workflow', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ errorWorkflowId: 'wf-target-missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH null → remove binding', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/error-workflow', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ errorWorkflowId: null }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { errorWorkflowId: null }).errorWorkflowId).toBeNull();
  });
});

describe('POST /:id/discard-draft', () => {
  it('happy', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/discard-draft', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('404', async () => {
    m.discardDraft.mockResolvedValue(false);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/discard-draft', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /:id/export', () => {
  it('404', async () => {
    m.exportBundle.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/export');
    expect(res.status).toBe(404);
  });

  it('🚨 filename sanitizzato (anti path-traversal)', async () => {
    m.exportBundle.mockResolvedValue({ workflow: { name: '../../etc/passwd' }, schemaVersion: '1.0' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/export');
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).not.toContain('../');
    expect(cd).toContain('.flowforge.json');
  });
});

describe('POST /import', () => {
  it('400 JSON malformato', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'garbage',
    });
    expect(res.status).toBe(400);
  });

  it('IMPORT_FAILED su throw service', async () => {
    m.importBundle.mockRejectedValue(new Error('schemaVersion incompatibile'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('IMPORT_FAILED');
  });

  it('happy → 201', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}',
    });
    expect(res.status).toBe(201);
  });
});

describe('POST / — create workflow', () => {
  it('happy enabled=false: no quota check, 201', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wf-new', enabled: false }),
    });
    expect(res.status).toBe(201);
    expect(m.checkQuota).not.toHaveBeenCalled();
  });

  it('🚨 enabled=true + quota piena → 402 WORKFLOW_QUOTA_EXCEEDED', async () => {
    m.checkQuota.mockImplementation(() => { throw new m.QuotaExceededError('limit hit', 'workflows', 5, 5); });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wf-new', enabled: true }),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as { code: string; quota: { limit: number }; upgradeUrl: string };
    expect(body.code).toBe('WORKFLOW_QUOTA_EXCEEDED');
    expect(body.quota.limit).toBe(5);
    expect(body.upgradeUrl).toContain('/account/billing');
  });

  it('TenantNotFoundError → 404 TENANT_NOT_FOUND', async () => {
    m.checkQuota.mockImplementation(() => { throw new m.TenantNotFoundError('not found'); });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wf-new', enabled: true }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe('TENANT_NOT_FOUND');
  });

  it('zod 400 name vuoto', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 tablesToCreate > 5', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x',
        tablesToCreate: Array.from({ length: 6 }, (_, i) => ({
          name: `t_${i}`, columns: [{ name: 'id', type: 'integer' }],
        })),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('zod 400 table name non lowercase snake', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x',
        tablesToCreate: [{ name: 'BadName', columns: [{ name: 'id', type: 'integer' }] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('tablesToCreate happy: dbStudio.applyMigration chiamato', async () => {
    m.dbStudioList.mockReturnValue([{ id: 'db-1', tenantId: 't1', connection: { embedded: true } }]);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf', enabled: false,
        tablesToCreate: [{ name: 'orders', columns: [{ name: 'id', type: 'integer' }] }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { tablesCreated: { ok: boolean }[] };
    expect(body.tablesCreated[0]!.ok).toBe(true);
  });

  it('🚨 tablesToCreate "already exists" → ok=true (idempotent semantic)', async () => {
    m.dbStudioList.mockReturnValue([{ id: 'db-1', tenantId: 't1', connection: { embedded: true } }]);
    m.dbStudioApplyMigration.mockRejectedValue(new Error('table already exists'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf', enabled: false,
        tablesToCreate: [{ name: 'orders', columns: [{ name: 'id', type: 'integer' }] }],
      }),
    });
    const body = await res.json() as { tablesCreated: { ok: boolean; error?: string }[] };
    expect(body.tablesCreated[0]!.ok).toBe(true);
    expect(body.tablesCreated[0]!.error).toBeUndefined();
  });

  it('🚨 FIX: SOLO DB remoto (NHA read-only) → NON ci scrive, crea un LOCALE on-demand + applyMigration sul nuovo', async () => {
    m.dbStudioList.mockReturnValue([{ id: 'nha-remote', tenantId: 't1', connection: { embedded: false } }]);
    m.dbStudioCreate.mockReturnValue({ id: 'db-local-new', tenantId: 't1' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf', enabled: false,
        tablesToCreate: [{ name: 'news_audit', databaseId: 'nha-remote', columns: [{ name: 'id', type: 'uuid' }] }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { tablesCreated: { ok: boolean }[] };
    expect(body.tablesCreated[0]!.ok).toBe(true);
    expect(m.dbStudioCreate).toHaveBeenCalledOnce(); // ha creato un locale, NON usato il remoto
    const migDbIds = m.dbStudioApplyMigration.mock.calls.map((c: unknown[]) => c[0]);
    expect(migDbIds).toContain('db-local-new');
    expect(migDbIds).not.toContain('nha-remote'); // mai sul remoto read-only
  });

  it('tablesToCreate senza DB locale + create on-demand FALLISCE → ok=false "Nessun database disponibile"', async () => {
    m.dbStudioList.mockReturnValue([]);
    m.dbStudioCreate.mockImplementation(() => { throw new Error('disco pieno'); });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wf', enabled: false,
        tablesToCreate: [{ name: 'orders', columns: [{ name: 'id', type: 'integer' }] }],
      }),
    });
    const body = await res.json() as { tablesCreated: { ok: boolean; error?: string }[] };
    expect(body.tablesCreated[0]!.ok).toBe(false);
    expect(body.tablesCreated[0]!.error).toContain('Nessun database');
  });

  it('service.create throw → 400 con error message', async () => {
    m.create.mockRejectedValue(new Error('db lock'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wf-new' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /:id — update + quota on enable transition', () => {
  it('happy update', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(200);
  });

  it('🚨 quota check su enable false→true transition', async () => {
    m.get.mockResolvedValue({ ...baseWf, enabled: false });
    m.checkQuota.mockImplementation(() => { throw new m.QuotaExceededError('full', 'workflows', 3, 3); });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(402);
    expect((await res.json() as { code: string }).code).toBe('WORKFLOW_QUOTA_EXCEEDED');
  });

  it('quota NON checked se già enabled (no transition)', async () => {
    m.get.mockResolvedValue({ ...baseWf, enabled: true });
    await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(m.checkQuota).not.toHaveBeenCalled();
  });

  it('🚨 CONFIG MERGE preservante (R-recurring): chiavi non-passate mantenute', async () => {
    m.get.mockResolvedValue({
      ...baseWf, enabled: false,
      nodes: [{ id: 'n1', defId: 'http', config: { url: 'https://x', onlyUnseen: true } }],
    });
    await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: [{ id: 'n1', defId: 'http', config: { url: 'https://y' } }],
      }),
    });
    const updateInput = m.update.mock.calls[0]![1] as { nodes: { config: Record<string, unknown> }[] };
    expect(updateInput.nodes[0]!.config.onlyUnseen).toBe(true); // preservato
    expect(updateInput.nodes[0]!.config.url).toBe('https://y'); // updated
  });

  it('nodi con id sconosciuto → passa through senza merge', async () => {
    m.get.mockResolvedValue({ ...baseWf, nodes: [{ id: 'old' }] });
    await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'new-node', defId: 'x' }] }),
    });
    const updateInput = m.update.mock.calls[0]![1] as { nodes: { id: string }[] };
    expect(updateInput.nodes[0]!.id).toBe('new-node');
  });

  it('404 se workflow non esiste', async () => {
    m.update.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-fake', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /:id/apply-ai-patch — AI explain patch', () => {
  it('404 workflow not found', async () => {
    m.get.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('updateNodes happy + issues array per id non esistente', async () => {
    m.get.mockResolvedValue({
      ...baseWf,
      nodes: [{ id: 'n1', defId: 'http', config: { url: 'old' } }],
      edges: [],
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: { updateNodes: [
          { id: 'n1', patch: { config: { url: 'new' } } },
          { id: 'fantasma', patch: { config: { x: 1 } } },
        ] },
      }),
    });
    const body = await res.json() as { applied: { updateCount: number }; issues: string[] };
    expect(body.applied.updateCount).toBe(1);
    expect(body.issues[0]).toContain('fantasma');
  });

  it('removeNodeIds + cascade edges', async () => {
    m.get.mockResolvedValue({
      ...baseWf,
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }],
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { removeNodeIds: ['n1'] } }),
    });
    const body = await res.json() as { applied: { removeNodeCount: number; removeEdgeCount: number } };
    expect(body.applied.removeNodeCount).toBe(1);
    expect(body.applied.removeEdgeCount).toBe(2); // cascade su entrambi
  });

  it('addNodes con id duplicato → issues', async () => {
    m.get.mockResolvedValue({ ...baseWf, nodes: [{ id: 'n1', defId: 'http' }] });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { addNodes: [{ id: 'n1', defId: 'duplicate' }] } }),
    });
    const body = await res.json() as { applied: { addCount: number }; issues: string[] };
    expect(body.applied.addCount).toBe(0);
    expect(body.issues[0]).toContain('già esiste');
  });

  it('🚨 addEdges con from/to non esistenti → issues, NO add', async () => {
    m.get.mockResolvedValue({ ...baseWf, nodes: [{ id: 'n1' }], edges: [] });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { addEdges: [{ from: 'fantasma', to: 'n1' }] } }),
    });
    const body = await res.json() as { applied: { addEdgeCount: number }; issues: string[] };
    expect(body.applied.addEdgeCount).toBe(0);
    expect(body.issues[0]).toContain('non esistono');
  });

  it('removeEdgeIds format "from|to" match', async () => {
    m.get.mockResolvedValue({
      ...baseWf,
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b' }],
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { removeEdgeIds: ['a|b'] } }),
    });
    const body = await res.json() as { applied: { removeEdgeCount: number } };
    expect(body.applied.removeEdgeCount).toBe(1);
  });

  it('response include sourceRunId + aiConfidence', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/apply-ai-patch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: {}, sourceRunId: 'run-42', confidence: 0.85 }),
    });
    const body = await res.json() as { sourceRunId: string; aiConfidence: number };
    expect(body.sourceRunId).toBe('run-42');
    expect(body.aiConfidence).toBe(0.85);
  });
});

describe('DELETE /:id', () => {
  it('happy 204', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('404', async () => {
    m.delete.mockResolvedValue(false);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-fake', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('POST /:id/auto-layout', () => {
  it('404', async () => {
    m.get.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/auto-layout', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('happy: persist nodes layout + stats', async () => {
    m.autoLayout.mockResolvedValue({
      nodes: [{ id: 'n1', x: 100, y: 100 }],
      stats: { width: 800, height: 600 },
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/auto-layout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rankdir: 'TB', nodesep: 100 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { layout: { width: number } };
    expect(body.layout.width).toBe(800);
  });

  it('persist fail → 500', async () => {
    m.update.mockRejectedValue(new Error('db lock'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/auto-layout', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  it('opts zod invalido → ignorato, defaults', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/auto-layout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rankdir: 'EVIL' }),
    });
    expect(res.status).toBe(200); // graceful: ignora opt sbagliata
  });
});

describe('POST /:id/estimate', () => {
  it('404', async () => {
    m.get.mockResolvedValue(null);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/estimate', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('happy', async () => {
    m.estimatorEstimate.mockReturnValue({ costUsd: 0.10, etaMs: 5000 });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/estimate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sampleInput: { x: 1 } }),
    });
    const body = await res.json() as { estimate: { costUsd: number } };
    expect(body.estimate.costUsd).toBe(0.10);
  });

  it('estimator throw → 500', async () => {
    m.estimatorEstimate.mockImplementation(() => { throw new Error('node missing'); });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/estimate', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  it('body JSON malformato → continua con defaults', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/wf-1/estimate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /ai-scaffold (sync)', () => {
  it('400 body JSON non valido', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('400 goal missing', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('happy: forward al service', async () => {
    m.aiScaffoldRun.mockResolvedValue({ workflow: { nodes: [], edges: [] } });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'fetch RSS daily' }),
    });
    expect(res.status).toBe(200);
  });

  it('🚨 AiScaffoldError → httpStatus dell\'error', async () => {
    m.aiScaffoldRun.mockRejectedValue(new m.AiScaffoldError('rate limit', 429));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x' }),
    });
    expect(res.status).toBe(429);
  });

  it('generic error → 500', async () => {
    m.aiScaffoldRun.mockRejectedValue(new Error('crashed'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /ai-scaffold/stream (SSE)', () => {
  it('400 body JSON non valido', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('400 goal missing', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('SSE response: Content-Type text/event-stream + no-cache', async () => {
    m.aiScaffoldRun.mockImplementation(async (_input: unknown, callback: (e: { type: string }) => void) => {
      callback({ type: 'done' });
      return { workflow: {} };
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/ai-scaffold/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'fetch RSS' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });
});
