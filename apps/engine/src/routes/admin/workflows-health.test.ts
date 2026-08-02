/**
 * Bug-bounty — routes/admin/workflows-health.ts (audit coverage 2026-06-12:
 * 24%, nessun test dedicato). Endpoint ops che rende VISIBILI i workflow
 * corrotti (skippati dal GET /workflows resiliente). Servizi mockati.
 *
 * Invarianti: tenant filter (specifico vs tutti i tenant via tenantService),
 * aggregazione corretta (total/ok/corrupted), issues incluse SOLO se presenti,
 * diagnoseWorkflowRow guida ok/issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const tenantListMock = vi.fn();
const listRowsMock = vi.fn();
const diagnoseMock = vi.fn();

vi.mock('@/services/tenant.service.js', () => ({
  tenantService: { list: () => ({ tenants: tenantListMock() }) },
}));
vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: class {
    listRowsForHealth = listRowsMock;
  },
  diagnoseWorkflowRow: (...a: unknown[]) => diagnoseMock(...a),
}));
vi.mock('@/adapters/event-bus-memory.js', () => ({ InMemoryEventBus: class {} }));

import { registerWorkflowsHealthRoutes } from './workflows-health.js';

function buildApp(): Hono {
  const app = new Hono();
  registerWorkflowsHealthRoutes(app);
  return app;
}

beforeEach(() => {
  tenantListMock.mockReset();
  listRowsMock.mockReset();
  diagnoseMock.mockReset();
});

describe('GET /admin/workflows/health', () => {
  it('senza tenantId → itera TUTTI i tenant da tenantService', async () => {
    tenantListMock.mockReturnValue([{ id: 'ta' }, { id: 'tb' }]);
    listRowsMock.mockResolvedValue([]);
    await buildApp().request('/admin/workflows/health');
    expect(listRowsMock).toHaveBeenCalledTimes(2);
    expect(listRowsMock).toHaveBeenCalledWith('ta');
    expect(listRowsMock).toHaveBeenCalledWith('tb');
  });

  it('con tenantId=X → SOLO quel tenant (tenantService.list NON usato per l elenco)', async () => {
    listRowsMock.mockResolvedValue([]);
    await buildApp().request('/admin/workflows/health?tenantId=solo-questo');
    expect(listRowsMock).toHaveBeenCalledTimes(1);
    expect(listRowsMock).toHaveBeenCalledWith('solo-questo');
    expect(tenantListMock).not.toHaveBeenCalled();
  });

  it('aggregazione: total/ok/corrupted contati correttamente; issues incluse solo se corrotto', async () => {
    listRowsMock.mockResolvedValue([
      { id: 'w1', name: 'Buono' },
      { id: 'w2', name: 'Rotto' },
    ]);
    diagnoseMock.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({
      ok: false,
      issues: [{ path: 'nodes.0', code: 'INVALID', message: 'defId mancante' }],
    });
    const res = await buildApp().request('/admin/workflows/health?tenantId=t1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      total: number;
      ok: number;
      corrupted: number;
      workflows: { workflowId: string; ok: boolean; issues?: unknown[] }[];
    };
    expect(data.total).toBe(2);
    expect(data.ok).toBe(1);
    expect(data.corrupted).toBe(1);
    const buono = data.workflows.find((w) => w.workflowId === 'w1')!;
    const rotto = data.workflows.find((w) => w.workflowId === 'w2')!;
    expect('issues' in buono).toBe(false); // ok → niente chiave issues
    expect(rotto.issues).toHaveLength(1);
  });

  it('nessun workflow → total 0, corrupted 0, lista vuota', async () => {
    tenantListMock.mockReturnValue([{ id: 'ta' }]);
    listRowsMock.mockResolvedValue([]);
    const data = (await (await buildApp().request('/admin/workflows/health')).json()) as {
      total: number;
      corrupted: number;
      workflows: unknown[];
    };
    expect(data).toMatchObject({ total: 0, ok: 0, corrupted: 0 });
    expect(data.workflows).toEqual([]);
  });

  it('multi-tenant: aggrega i workflow di tutti i tenant nello stesso report', async () => {
    tenantListMock.mockReturnValue([{ id: 'ta' }, { id: 'tb' }]);
    listRowsMock.mockResolvedValueOnce([{ id: 'a1', name: 'A1' }]).mockResolvedValueOnce([
      { id: 'b1', name: 'B1' },
      { id: 'b2', name: 'B2' },
    ]);
    diagnoseMock.mockReturnValue({ ok: true });
    const data = (await (await buildApp().request('/admin/workflows/health')).json()) as {
      total: number;
      workflows: { tenantId: string }[];
    };
    expect(data.total).toBe(3);
    expect(new Set(data.workflows.map((w) => w.tenantId))).toEqual(new Set(['ta', 'tb']));
  });
});
