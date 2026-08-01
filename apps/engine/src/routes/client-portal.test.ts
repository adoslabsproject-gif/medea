/**
 * Tests per /portal/:tenantId/:token/* — Client Portal public routes.
 *
 * Invarianti CRITICALI (security + UX):
 *  - Tutti gli endpoint richiedono token valido (verify → 401 standard)
 *  - Token invalido / revocato / expired / wrong tenant → 401 con messaggio
 *    generico ("Invalid or expired portal link") — NO enum del motivo
 *  - GET / → portal info REDACTED (no token raw, no createdBy, no
 *    permissions interne come allowedTriggerTypes/workflowIds/Tags)
 *  - GET /workflows → solo workflow visibili (default-deny rispettato)
 *  - GET /runs → solo run dei workflow visibili (cross-workflow filter
 *    applicativo); rispetta showHistory=false (ritorna [])
 *  - GET /runs/:id → 404 anche se run esiste ma su workflow non visibile
 *    (no leak ID enumeration)
 *  - GET /runs/:id step output NON esposto (solo nodeId/label/status/timing)
 *  - POST /workflows/:id/run → 403 con reason se gate fail, 404 se workflow
 *    non esiste, 202 + runId se OK + audit log scritto
 *  - Audit log su run sempre scritto con portalTokenId
 */
import type { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  verifyFn: vi.fn(),
  listVisibleFn: vi.fn(),
  canRunFn: vi.fn(),
  auditRunFn: vi.fn().mockResolvedValue(undefined),
  workflowGet: vi.fn(),
  runsExecute: vi.fn(),
  runsListRecent: vi.fn(),
  runsGetById: vi.fn(),
}));

vi.mock('@/services/client-portal.service.js', () => ({
  ClientPortalService: class {
    verify = m.verifyFn;
    listVisibleWorkflows = m.listVisibleFn;
    canRunWorkflow = m.canRunFn;
    auditPortalRun = m.auditRunFn;
  },
}));

vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: class {
    get = m.workflowGet;
  },
}));

vi.mock('@/services/run.service.js', () => ({
  RunService: class {
    execute = m.runsExecute;
    listRecent = m.runsListRecent;
    getById = m.runsGetById;
  },
}));

import { createClientPortalPublicRoutes } from './client-portal.js';

const fakeBus = { emit: vi.fn(), on: vi.fn() } as unknown as Parameters<typeof createClientPortalPublicRoutes>[0];

function makeApp(): Hono {
  return createClientPortalPublicRoutes(fakeBus);
}

beforeEach(() => {
  vi.resetAllMocks();
  m.auditRunFn.mockResolvedValue(undefined);
});

const VALID_TOKEN_INFO = {
  id: 'tok-1',
  tenantId: 'tenant-a',
  token: 'token-string',
  name: 'Cliente Acme',
  mode: 'portal' as const,
  permissions: {
    workflowIds: ['wf-1', 'wf-2'],
    allowRun: true,
    allowedTriggerTypes: ['trigger_manual'],
    showHistory: true,
    showLiveCanvas: true,
    brandName: 'Acme Srl',
    brandLogoUrl: 'https://acme.example.com/logo.png',
  },
  createdAt: '2026-05-29T10:00:00Z',
  expiresAt: '2027-05-29T10:00:00Z',
  accessCount: 5,
};

describe('GET /portal/:tenantId/:token — verify + info', () => {
  it('token invalido → 401 con messaggio generico (no enum)', async () => {
    m.verifyFn.mockReturnValue(null);
    const res = await makeApp().request('/portal/tenant-a/bad-token');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid or expired portal link');
  });

  it('token valido → ritorna portal info REDACTED', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    const res = await makeApp().request('/portal/tenant-a/good-token');
    expect(res.status).toBe(200);
    const body = await res.json() as { portal: { name: string; permissions: Record<string, unknown>; expiresAt?: string } };
    expect(body.portal.name).toBe('Cliente Acme');
    expect(body.portal.permissions.brandName).toBe('Acme Srl');
    expect(body.portal.permissions.allowRun).toBe(true);
    expect(body.portal.permissions.showHistory).toBe(true);
    expect(body.portal.permissions.brandLogoUrl).toBe('https://acme.example.com/logo.png');
  });

  it('REDACT: portal info NON include workflowIds/workflowTags/allowedTriggerTypes interne', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    const res = await makeApp().request('/portal/tenant-a/good-token');
    const body = await res.json() as { portal: { permissions: Record<string, unknown> } };
    expect(body.portal.permissions.workflowIds).toBeUndefined();
    expect(body.portal.permissions.workflowTags).toBeUndefined();
    expect(body.portal.permissions.allowedTriggerTypes).toBeUndefined();
  });

  it('REDACT: response NON include token raw / createdBy / tenantId', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    const res = await makeApp().request('/portal/tenant-a/good-token');
    const body = await res.text();
    expect(body).not.toContain('token-string');
    expect(body).not.toContain('createdBy');
    expect(body).not.toContain('"tenantId"');
  });
});

describe('GET /portal/.../workflows — lista visibile', () => {
  it('token invalido → 401', async () => {
    m.verifyFn.mockReturnValue(null);
    const res = await makeApp().request('/portal/tenant-a/bad/workflows');
    expect(res.status).toBe(401);
  });

  it('token valido → ritorna listVisibleWorkflows()', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.listVisibleFn.mockReturnValue([
      { id: 'wf-1', name: 'A', description: '', enabled: true, tags: ['client-facing'], canRun: true },
      { id: 'wf-2', name: 'B', description: '', enabled: true, tags: [], canRun: false },
    ]);
    const res = await makeApp().request('/portal/tenant-a/good/workflows');
    expect(res.status).toBe(200);
    const body = await res.json() as { workflows: { id: string }[] };
    expect(body.workflows.map((w) => w.id)).toEqual(['wf-1', 'wf-2']);
  });
});

describe('GET /portal/.../runs — cronologia filtered', () => {
  it('showHistory=false → ritorna []', async () => {
    m.verifyFn.mockReturnValue({
      ...VALID_TOKEN_INFO,
      permissions: { ...VALID_TOKEN_INFO.permissions, showHistory: false },
    });
    const res = await makeApp().request('/portal/tenant-a/good/runs');
    const body = await res.json() as { runs: unknown[] };
    expect(body.runs).toEqual([]);
    expect(m.runsListRecent).not.toHaveBeenCalled();
  });

  it('senza workflow visibili → ritorna []', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.listVisibleFn.mockReturnValue([]);
    const res = await makeApp().request('/portal/tenant-a/good/runs');
    const body = await res.json() as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it('filtra cross-workflow per visibility', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.listVisibleFn.mockReturnValue([{ id: 'wf-1', name: 'A', description: '', enabled: true, tags: [], canRun: true }]);
    m.runsListRecent.mockResolvedValue([
      { id: 'run-1', workflowId: 'wf-1', status: 'success', startedAt: '2026-05-29T10:00:00Z', finishedAt: '2026-05-29T10:00:05Z', totalDurationMs: 5000 },
      { id: 'run-2', workflowId: 'wf-INVISIBLE', status: 'success', startedAt: '2026-05-29T09:00:00Z', finishedAt: '2026-05-29T09:00:05Z', totalDurationMs: 5000 },
      { id: 'run-3', workflowId: 'wf-1', status: 'error', startedAt: '2026-05-29T08:00:00Z', finishedAt: '2026-05-29T08:00:10Z', totalDurationMs: 10000 },
    ]);
    const res = await makeApp().request('/portal/tenant-a/good/runs');
    const body = await res.json() as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id)).toEqual(['run-1', 'run-3']);
  });

  it('rispetta query ?limit=N (clamped 1-100)', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.listVisibleFn.mockReturnValue([{ id: 'wf-1', name: 'A', description: '', enabled: true, tags: [], canRun: true }]);
    m.runsListRecent.mockResolvedValue([]);
    await makeApp().request('/portal/tenant-a/good/runs?limit=50');
    expect(m.runsListRecent).toHaveBeenCalledWith('tenant-a', 150); // 50 * 3 over-fetch
  });
});

describe('GET /portal/.../runs/:id — dettaglio gated', () => {
  it('run non esiste → 404', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.runsGetById.mockResolvedValue(null);
    const res = await makeApp().request('/portal/tenant-a/good/runs/nonexistent');
    expect(res.status).toBe(404);
  });

  it('run di workflow NON visibile → 404 (no enum ID)', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.runsGetById.mockResolvedValue({
      id: 'run-X', workflowId: 'wf-INVISIBLE', status: 'success',
      startedAt: null, finishedAt: null, totalDurationMs: null, errorCount: 0, steps: [],
    });
    m.listVisibleFn.mockReturnValue([{ id: 'wf-1', name: 'A', description: '', enabled: true, tags: [], canRun: true }]);
    const res = await makeApp().request('/portal/tenant-a/good/runs/run-X');
    expect(res.status).toBe(404); // NOT 403 — no enumeration
  });

  it('run visibile → 200 con steps REDACTED (no output)', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.runsGetById.mockResolvedValue({
      id: 'run-1', workflowId: 'wf-1', status: 'success',
      startedAt: '2026-05-29T10:00:00Z', finishedAt: '2026-05-29T10:00:05Z',
      totalDurationMs: 5000, errorCount: 0,
      steps: [
        { nodeId: 'n1', nodeLabel: 'Trigger', status: 'success', durationMs: 100 },
        { nodeId: 'n2', nodeLabel: 'Email', status: 'success', durationMs: 4800 },
      ],
    });
    m.listVisibleFn.mockReturnValue([{ id: 'wf-1', name: 'A', description: '', enabled: true, tags: [], canRun: true }]);
    const res = await makeApp().request('/portal/tenant-a/good/runs/run-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { run: { steps: Record<string, unknown>[] } };
    expect(body.run.steps).toHaveLength(2);
    expect(body.run.steps[0]!.nodeId).toBe('n1');
    expect(body.run.steps[0]!.nodeLabel).toBe('Trigger');
    // REDACT: nessun campo output/error nei step esposti
    expect(body.run.steps[0]!.output).toBeUndefined();
    expect(body.run.steps[0]!.error).toBeUndefined();
  });
});

describe('POST /portal/.../workflows/:id/run — execute gated', () => {
  const RUN_URL = '/portal/tenant-a/good/workflows/wf-1/run';

  it('workflow non esiste → 404', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.workflowGet.mockResolvedValue(null);
    const res = await makeApp().request(RUN_URL, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(404);
  });

  it('gate fail → 403 con reason', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.workflowGet.mockResolvedValue({ id: 'wf-1', nodes: [{ defId: 'trigger_webhook' }] });
    m.canRunFn.mockReturnValue({ ok: false, reason: 'allowRun=false' });
    const res = await makeApp().request(RUN_URL, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; reason: string };
    expect(body.error).toBe('Not allowed');
    expect(body.reason).toBe('allowRun=false');
    expect(m.runsExecute).not.toHaveBeenCalled();
  });

  it('happy path → 202 + runId + audit log', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.workflowGet.mockResolvedValue({ id: 'wf-1', nodes: [{ defId: 'trigger_manual' }] });
    m.canRunFn.mockReturnValue({ ok: true });
    m.runsExecute.mockResolvedValue({ runId: 'run-new-1', status: 'running' });
    const res = await makeApp().request(RUN_URL, {
      method: 'POST',
      body: JSON.stringify({ triggerInput: { destinatario: 'a@b.it' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { runId: string; status: string };
    expect(body.runId).toBe('run-new-1');
    expect(body.status).toBe('running');

    // Audit chiamato con portalTokenId, workflowId, runId
    expect(m.auditRunFn).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      tokenId: 'tok-1',
      workflowId: 'wf-1',
      runId: 'run-new-1',
    }));
    // PII redaction: triggerInputSummary ha valori redatti
    const auditCall = m.auditRunFn.mock.calls[0]![0] as { triggerInputSummary: Record<string, string> };
    expect(auditCall.triggerInputSummary.destinatario).toBe('<redacted>');
  });

  it('execute con triggeredBy=portal:<tokenId> (tracciabilità)', async () => {
    m.verifyFn.mockReturnValue(VALID_TOKEN_INFO);
    m.workflowGet.mockResolvedValue({ id: 'wf-1', nodes: [{ defId: 'trigger_manual' }] });
    m.canRunFn.mockReturnValue({ ok: true });
    m.runsExecute.mockResolvedValue({ runId: 'run-X', status: 'running' });
    await makeApp().request(RUN_URL, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(m.runsExecute).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      workflowId: 'wf-1',
      triggerType: 'portal',
      triggeredBy: 'portal:tok-1',
    }));
  });
});

describe('Cross-cutting: param validation', () => {
  it('GET con :tenantId vuoto → 401 (route mismatch)', async () => {
    const res = await makeApp().request('/portal//bad');
    expect([400, 401, 404]).toContain(res.status);
  });
});
