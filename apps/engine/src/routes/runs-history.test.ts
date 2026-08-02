/**
 * Test 2026-grade — runs-history routes (4 endpoint + AI explain).
 *
 * Coverage REALE con sqlite :memory: + auth injection. Verifica:
 *  - GET /runs: tenant scope, filter status/workflowId/since, limit cap 250,
 *    crossTenant flag superadmin senza header
 *  - 🚨 superadmin con x-tenant-id header → NON crossTenant (impersonate)
 *  - POST /runs/bulk-delete: 400 lista vuota, 400 > 1000, eventBus emit
 *    fire-and-forget cap 100, tenant filter
 *  - DELETE /runs/:id: 404 idempotente, eventBus emit
 *  - 🚨 cross-tenant delete: tenant A non può cancellare run di tenant B
 *  - GET /runs/:id: steps_json parse + fallback []
 *  - POST /ai-explain: RunNotFound → 404, RunSucceeded → 400, NoLlmProvider
 *    → httpStatus dell'error, LlmResponseError → 502 + raw
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => {
  class RunNotFoundError extends Error {
    override name = 'RunNotFoundError';
  }
  class RunSucceededError extends Error {
    override name = 'RunSucceededError';
  }
  class NoFailedStepError extends Error {
    override name = 'NoFailedStepError';
  }
  class LlmResponseError extends Error {
    override name = 'LlmResponseError';
    raw: unknown;
    constructor(msg: string, raw: unknown) {
      super(msg);
      this.raw = raw;
    }
  }
  class NoLlmProviderError extends Error {
    override name = 'NoLlmProviderError';
    httpStatus: number;
    constructor(msg: string, httpStatus = 503) {
      super(msg);
      this.httpStatus = httpStatus;
    }
  }
  return {
    db: null as Database.Database | null,
    explain: vi.fn(),
    RunNotFoundError,
    RunSucceededError,
    NoFailedStepError,
    LlmResponseError,
    NoLlmProviderError,
  };
});
const {
  RunNotFoundError,
  RunSucceededError,
  NoFailedStepError,
  LlmResponseError,
  NoLlmProviderError,
} = m;

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/middleware/rate-limit.js', () => ({
  llmRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock('@/services/ai-explain.service.js', () => ({
  RunNotFoundError: m.RunNotFoundError,
  RunSucceededError: m.RunSucceededError,
  NoFailedStepError: m.NoFailedStepError,
  LlmResponseError: m.LlmResponseError,
  NoLlmProviderError: m.NoLlmProviderError,
  aiExplainService: { explain: (a: unknown) => m.explain(a) },
}));

import { createRunHistoryRoutes } from './runs-history.js';
import type { AuthContext } from '@/middleware/auth.js';

function setupSchema(): void {
  m.db!.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workflow_id TEXT, tenant_id TEXT, status TEXT,
      trigger_type TEXT, input TEXT, error_count INTEGER DEFAULT 0,
      total_duration_ms INTEGER, started_at TEXT, ended_at TEXT, steps_json TEXT
    );
  `);
}

function insertRun(over: Partial<Record<string, unknown>> = {}): string {
  const id = (over.id as string) ?? `run-${Math.random().toString(36).slice(2, 8)}`;
  m.db!.prepare(
    'INSERT INTO runs (id, workflow_id, tenant_id, status, trigger_type, input, started_at, steps_json) VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    id,
    over.workflow_id ?? 'wf-1',
    over.tenant_id ?? 't1',
    over.status ?? 'success',
    over.trigger_type ?? 'manual',
    over.input ?? '{}',
    over.started_at ?? new Date().toISOString(),
    over.steps_json ?? '[]',
  );
  return id;
}

function buildApp(auth: Partial<AuthContext> | null, bus?: { emit: (e: unknown) => void }): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) {
      const full = {
        userId: 'u',
        email: 'e@x',
        tenantId: 't1',
        role: 'owner',
        ...auth,
      } as AuthContext;
      c.set('auth', full);
    }
    await next();
  });
  app.route('/', createRunHistoryRoutes(bus as never));
  return app;
}

beforeEach(() => {
  m.db = new Database(':memory:');
  setupSchema();
  m.explain.mockReset();
});

describe('GET /runs — list + filter', () => {
  it('happy path tenant-scoped', async () => {
    insertRun({ tenant_id: 't1' });
    insertRun({ tenant_id: 't1' });
    insertRun({ tenant_id: 't2' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: unknown[];
      totalCount: number;
      crossTenant: boolean;
    };
    expect(body.runs).toHaveLength(2);
    expect(body.totalCount).toBe(2);
    expect(body.crossTenant).toBe(false);
  });

  it('🚨 superadmin senza header → crossTenant=true, vede tutti i tenant', async () => {
    insertRun({ tenant_id: 't1' });
    insertRun({ tenant_id: 't2' });
    insertRun({ tenant_id: 't3' });
    const res = await buildApp({ role: 'superadmin', tenantId: 'platform' }).request('/runs');
    const body = (await res.json()) as { runs: unknown[]; crossTenant: boolean };
    expect(body.runs).toHaveLength(3);
    expect(body.crossTenant).toBe(true);
  });

  it('superadmin con x-tenant-id header → impersonate, NO crossTenant', async () => {
    insertRun({ tenant_id: 't1' });
    insertRun({ tenant_id: 't2' });
    const res = await buildApp({ role: 'superadmin', tenantId: 'platform' }).request('/runs', {
      headers: { 'x-tenant-id': 't1' },
    });
    const body = (await res.json()) as { runs: unknown[]; crossTenant: boolean };
    expect(body.runs).toHaveLength(1);
    expect(body.crossTenant).toBe(false);
  });

  it('filter status=error', async () => {
    insertRun({ status: 'success' });
    insertRun({ status: 'error' });
    insertRun({ status: 'error' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs?status=error');
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toHaveLength(2);
  });

  it('filter workflowId', async () => {
    insertRun({ workflow_id: 'wf-1' });
    insertRun({ workflow_id: 'wf-2' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs?workflowId=wf-2');
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toHaveLength(1);
  });

  it('limit cap 250 anti-DoS', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs?limit=99999');
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(250);
  });

  it('limit default 25', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs');
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(25);
  });
});

describe('POST /runs/bulk-delete', () => {
  it('400 body senza ids', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400 Bad JSON', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 ids > 1000 → 400 (DoS guard)', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `r-${i}`);
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/bulk-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('1000');
  });

  it('happy path: deleted + skipped count, eventBus.emit per ciascuno', async () => {
    const r1 = insertRun({ tenant_id: 't1' });
    const r2 = insertRun({ tenant_id: 't1' });
    const r3 = insertRun({ tenant_id: 't2' }); // NOT touched (tenant filter)
    const bus = { emit: vi.fn() };
    const res = await buildApp({ role: 'owner', tenantId: 't1' }, bus).request(
      '/runs/bulk-delete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [r1, r2, r3] }),
      },
    );
    const body = (await res.json()) as { deleted: number; skipped: number };
    expect(body.deleted).toBe(2);
    expect(body.skipped).toBe(1); // r3 di altro tenant
    expect(bus.emit).toHaveBeenCalledTimes(2);
  });
});

describe('DELETE /runs/:runId', () => {
  it('happy path → ok:true + eventBus.emit', async () => {
    const id = insertRun({ tenant_id: 't1' });
    const bus = { emit: vi.fn() };
    const res = await buildApp({ role: 'owner', tenantId: 't1' }, bus).request(`/runs/${id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(bus.emit).toHaveBeenCalledTimes(1);
  });

  it('404 quando id non esiste', async () => {
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/fake', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('🚨 cross-tenant: tenant A non può delete run di B', async () => {
    const id = insertRun({ tenant_id: 'tB' });
    const res = await buildApp({ role: 'owner', tenantId: 'tA' }).request(`/runs/${id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    // verifica che il run NON sia stato cancellato
    expect(m.db!.prepare('SELECT COUNT(*) AS c FROM runs WHERE id = ?').get(id)).toEqual({ c: 1 });
  });

  it('superadmin senza header può delete qualsiasi tenant + emit con tenant REALE', async () => {
    const id = insertRun({ tenant_id: 'tX' });
    const bus = { emit: vi.fn() };
    const res = await buildApp({ role: 'superadmin', tenantId: 'platform' }, bus).request(
      `/runs/${id}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const emitArg = bus.emit.mock.calls[0]![0] as { tenantId: string };
    expect(emitArg.tenantId).toBe('tX');
  });
});

describe('GET /runs/:runId', () => {
  it('happy path con steps parsed', async () => {
    const id = insertRun({
      tenant_id: 't1',
      steps_json: JSON.stringify([{ nodeId: 'n1', status: 'ok' }]),
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(`/runs/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { steps: { nodeId: string }[] } };
    expect(body.run.steps[0]!.nodeId).toBe('n1');
  });

  it('steps_json non valido → fallback []', async () => {
    const id = insertRun({ tenant_id: 't1', steps_json: 'garbage{' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(`/runs/${id}`);
    const body = (await res.json()) as { run: { steps: unknown[] } };
    expect(body.run.steps).toEqual([]);
  });

  it('404 + 🚨 cross-tenant ritorna 404 (no leak)', async () => {
    const id = insertRun({ tenant_id: 'tB' });
    const res = await buildApp({ role: 'owner', tenantId: 'tA' }).request(`/runs/${id}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /runs/:runId/ai-explain', () => {
  it('happy path: forward al service', async () => {
    m.explain.mockResolvedValue({ explanation: 'why', fix: 'change foo' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(
      '/runs/run-x/ai-explain',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ explanation: 'why', fix: 'change foo' });
  });

  it('RunNotFoundError → 404', async () => {
    m.explain.mockRejectedValue(new RunNotFoundError('run not found'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/x/ai-explain', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('RunSucceededError → 400', async () => {
    m.explain.mockRejectedValue(new RunSucceededError('run ok no need explain'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/x/ai-explain', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('NoFailedStepError → 400', async () => {
    m.explain.mockRejectedValue(new NoFailedStepError('no failed step'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/x/ai-explain', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it("NoLlmProviderError → httpStatus dell'error (custom 402/503)", async () => {
    m.explain.mockRejectedValue(new NoLlmProviderError('no llm', 402));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/x/ai-explain', {
      method: 'POST',
    });
    expect(res.status).toBe(402);
  });

  it('LlmResponseError → 502 + raw', async () => {
    m.explain.mockRejectedValue(new LlmResponseError('bad response', { raw: 'oops' }));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/x/ai-explain', {
      method: 'POST',
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ raw: { raw: 'oops' } });
  });

  it('errore generico → 500', async () => {
    m.explain.mockRejectedValue(new Error('connection drop'));
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request('/runs/x/ai-explain', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /runs/:runId/ai-logs — Fase 3 (#15): cancellazione log prompt/risposta', () => {
  const llmLog = (seq: number, msg: string) => ({
    ts: '2026-07-06T20:00:00.000Z',
    seq,
    level: 'info',
    source: 'llm',
    msg,
    fields: { kind: 'llm_prompt', text: 'segreto' },
  });
  const engineLog = (seq: number) => ({
    ts: '2026-07-06T20:00:00.000Z',
    seq,
    level: 'info',
    source: 'engine',
    msg: 'retry 1',
  });
  const stepsWithLogs = () =>
    JSON.stringify([
      {
        nodeId: 'agent_a',
        status: 'success',
        logs: [engineLog(1), llmLog(2, 'prompt·system (1/1)'), llmLog(3, 'risposta (1/1)')],
        logsTotal: 3,
      },
      {
        nodeId: 'agent_b',
        status: 'success',
        logs: [llmLog(1, 'prompt·user (1/1)')],
        logsTotal: 1,
      },
      { nodeId: 'http_c', status: 'success', logs: [engineLog(1)], logsTotal: 1 },
    ]);

  const readSteps = (
    runId: string,
  ): { nodeId: string; logs: { source: string; msg: string }[] }[] => {
    const row = m.db!.prepare('SELECT steps_json FROM runs WHERE id = ?').get(runId) as {
      steps_json: string;
    };
    return JSON.parse(row.steps_json) as never;
  };

  it('🚨 senza nodeId → strippa i log llm di TUTTI gli step, conserva gli altri, aggiunge marker onesto', async () => {
    const runId = insertRun({ tenant_id: 't1', steps_json: stepsWithLogs() });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(
      `/runs/${runId}/ai-logs`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 3 });
    const steps = readSteps(runId);
    expect(steps[0]!.logs.filter((l) => l.source === 'llm')).toHaveLength(0);
    expect(steps[0]!.logs.some((l) => l.source === 'engine' && l.msg === 'retry 1')).toBe(true);
    expect(steps[0]!.logs.some((l) => /log AI.*cancellati/i.test(l.msg))).toBe(true);
    expect(steps[1]!.logs.some((l) => /cancellati/i.test(l.msg))).toBe(true);
    // Nessun testo dei prompt sopravvive nel record
    expect(JSON.stringify(steps)).not.toContain('segreto');
  });

  it('con ?nodeId= → strippa SOLO quel nodo', async () => {
    const runId = insertRun({ tenant_id: 't1', steps_json: stepsWithLogs() });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(
      `/runs/${runId}/ai-logs?nodeId=agent_b`,
      { method: 'DELETE' },
    );
    expect(await res.json()).toEqual({ ok: true, removed: 1, nodeId: 'agent_b' });
    const steps = readSteps(runId);
    expect(steps[0]!.logs.filter((l) => l.source === 'llm')).toHaveLength(2); // intatto
    expect(steps[1]!.logs.filter((l) => l.source === 'llm')).toHaveLength(0);
  });

  it('🚨 tenant B NON può cancellare i log di tenant A → 404', async () => {
    const runId = insertRun({ tenant_id: 't1', steps_json: stepsWithLogs() });
    const res = await buildApp({ role: 'owner', tenantId: 't2' }).request(
      `/runs/${runId}/ai-logs`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    expect(readSteps(runId)[0]!.logs.filter((l) => l.source === 'llm')).toHaveLength(2); // intatto
  });

  it('run senza log llm → removed:0, steps_json NON riscritto', async () => {
    const runId = insertRun({
      tenant_id: 't1',
      steps_json: JSON.stringify([{ nodeId: 'x', logs: [engineLog(1)] }]),
    });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(
      `/runs/${runId}/ai-logs`,
      { method: 'DELETE' },
    );
    expect(await res.json()).toEqual({ ok: true, removed: 0 });
    expect(readSteps(runId)[0]!.logs).toHaveLength(1);
  });

  it('steps_json corrotto → 500 esplicito, non crash', async () => {
    const runId = insertRun({ tenant_id: 't1', steps_json: '{non-json' });
    const res = await buildApp({ role: 'owner', tenantId: 't1' }).request(
      `/runs/${runId}/ai-logs`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(500);
  });
});
