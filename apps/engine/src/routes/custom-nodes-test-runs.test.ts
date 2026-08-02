/**
 * Test route GET /:id/test-runs — ring buffer history (FIX A3).
 *
 * Prima il buffer veniva scritto ma mai esposto. Verifica:
 *  - success → 200 { runs } con workspaceId risolto dal ctx auth
 *  - buffer vuoto → { runs: [] } (non 404)
 *  - errore service → status d'errore (NON 200)
 *  - newest-first preservato (pass-through del service, nessun re-sort)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/middleware/rbac.js', () => ({
  requireRole: () => (_c: unknown, next: () => Promise<unknown>) => next(),
}));
vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: () => (_c: unknown, next: () => Promise<unknown>) => next(),
}));
vi.mock('@/lib/logger.js');

const listTestRunsMock = vi.fn();
vi.mock('@/services/custom-nodes/index.js', () => ({
  createCustomNode: vi.fn(),
  getCustomNode: vi.fn(),
  listCustomNodes: vi.fn(),
  updateCustomNode: vi.fn(),
  listVersions: vi.fn(),
  rollbackToVersion: vi.fn(),
  archiveCustomNode: vi.fn(),
  compileAndPersist: vi.fn(),
  countActiveCustomNodes: vi.fn(),
  resolveTenantPlan: vi.fn(),
  publishCustomNodePrivate: vi.fn(),
  unpublishCustomNode: vi.fn(),
  submitCustomNodeToMarketplace: vi.fn(),
  withdrawCustomNodeFromMarketplace: vi.fn(),
  appendTestRun: vi.fn(),
  listTestRuns: (...args: unknown[]) => listTestRunsMock(...args),
  PLAN_CAPABILITIES: {},
  CustomNodeError: class extends Error {},
  CustomNodeCreateInputSchema: { parse: vi.fn() },
  CustomNodeUpdateInputSchema: { parse: vi.fn() },
  CustomNodeListFilterSchema: { parse: vi.fn() },
  semverField: { parse: vi.fn() },
}));

import { createCustomNodesRoutes } from './custom-nodes.js';

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('auth', {
      userId: 'u_test',
      tenantId: 'ws_test',
    });
    await next();
  });
  app.route('/', createCustomNodesRoutes());
  return app;
}

const rec = (over: Record<string, unknown> = {}) => ({
  at: '2026-06-13T10:00:00Z',
  input: { a: 1 },
  output: { ok: true },
  ok: true,
  durationMs: 42,
  ...over,
});

describe('GET /:id/test-runs', () => {
  beforeEach(() => {
    listTestRunsMock.mockReset();
  });

  it('success → 200 { runs }, service chiamato con workspaceId risolto + id', async () => {
    listTestRunsMock.mockResolvedValue([rec(), rec({ ok: false, error: 'boom', durationMs: 7 })]);
    const res = await makeApp().request('/cn_abc/test-runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toHaveLength(2);
    expect(listTestRunsMock).toHaveBeenCalledWith({ workspaceId: 'ws_test', id: 'cn_abc' });
  });

  it('buffer vuoto → { runs: [] } (non 404)', async () => {
    listTestRunsMock.mockResolvedValue([]);
    const res = await makeApp().request('/cn_x/test-runs');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runs: unknown[] }).runs).toEqual([]);
  });

  it('ordine newest-first preservato (pass-through, nessun re-sort lato route)', async () => {
    const a = rec({ at: '2026-06-13T12:00:00Z' });
    const b = rec({ at: '2026-06-13T08:00:00Z' });
    listTestRunsMock.mockResolvedValue([a, b]); // già newest-first dal service
    const res = await makeApp().request('/cn_x/test-runs');
    const body = (await res.json()) as { runs: { at: string }[] };
    expect(body.runs.map((r) => r.at)).toEqual(['2026-06-13T12:00:00Z', '2026-06-13T08:00:00Z']);
  });

  it("errore service → status d'errore, NON 200", async () => {
    listTestRunsMock.mockRejectedValue(new Error('db down'));
    const res = await makeApp().request('/cn_x/test-runs');
    expect(res.status).not.toBe(200);
  });
});
