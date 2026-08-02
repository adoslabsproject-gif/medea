/**
 * AUDIT FIX WE-1 (2026-06-09 CRITICAL) — REGRESSION GUARD E2E:
 *
 * Invariante CRITICO:
 *   "X-Subworkflow-Depth è internal-only: caller esterni che lo settano NON
 *    devono bypassare il quota gate su workflow disabilitati."
 *
 * Pre-fix bug:
 *   - body.triggerType !== 'subworkflow' MA header X-Subworkflow-Depth: 0
 *   - subworkflowDepth = 0 (defined) → isInternalTrigger=true
 *   - skip del quota check `workflows.checkQuota` → workflow disabled eseguito
 *   - Free tier al cap = bypass slot quota (paga 0, ottiene esecuzione)
 *
 * Test scenari:
 *   1. external + depth → workflow disabled + quota piena → 402 QUOTA_TEST_BLOCKED
 *      (pre-fix questo era 202 = bypass)
 *   2. internal (X-Internal-Token valido) + depth → 202 (legittimo)
 *   3. external NO depth → comportamento invariato (gate funziona)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock servizi downstream + tenantService + WorkflowService
const m = vi.hoisted(() => ({
  startAsync: vi.fn(),
  getWorkflow: vi.fn(),
  checkQuota: vi.fn(),
}));

vi.mock('@/services/run.service.js', () => ({
  RunService: class {
    startAsync = m.startAsync;
  },
}));
vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: class {
    get = m.getWorkflow;
  },
}));

// vi.hoisted per garantire QuotaExceededError disponibile durante vi.mock hoisting
const errors = vi.hoisted(() => {
  class QuotaExceededError extends Error {
    limit: number;
    current: number;
    constructor(limit: number, current: number) {
      super('quota exceeded');
      this.name = 'QuotaExceededError';
      this.limit = limit;
      this.current = current;
    }
  }
  return { QuotaExceededError };
});
vi.mock('@/services/tenant.service.js', () => ({
  tenantService: { checkQuota: m.checkQuota },
  QuotaExceededError: errors.QuotaExceededError,
}));

vi.mock('@/lib/logger.js');
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'ten1' }));
vi.mock('@/lib/actor.js', () => ({ getActorId: () => 'user-ext' }));
vi.mock('@/middleware/rate-limit.js', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@/executors/debug-run-failure.js', () => ({ debugRunFailureExecutor: vi.fn() }));

import { createRunRoutes } from './runs.js';

function makeApp(authContext: { userId: string; role?: string } | null): Hono {
  const app = new Hono();
  // Middleware "stub auth" che setta c.set('auth', ...) come fa il vero
  // authMiddleware del runtime: 'internal' se X-Internal-Token matcha,
  // altrimenti userId reale dal cookie/Bearer.
  app.use('*', async (c, next) => {
    c.set('auth', authContext as never);
    await next();
  });
  app.route('/', createRunRoutes({} as never));
  return app;
}

beforeEach(() => {
  m.startAsync.mockReset();
  m.getWorkflow.mockReset();
  m.checkQuota.mockReset();
  m.startAsync.mockResolvedValue({ runId: 'r1', status: 'queued' });
});

describe('🚨 [REGRESSION WE-1] X-Subworkflow-Depth richiede X-Internal-Token', () => {
  /**
   * SCENARIO BUG ORIGINALE:
   * Pre-fix: external caller passa `X-Subworkflow-Depth: 0` insieme a
   * triggerType='manual'. La route legge il header e setta isInternalTrigger=true
   * → skip quota check. Workflow disabled + free tier piena → eseguito gratis.
   *
   * Post-fix: il header è ignorato per caller NON-internal → quota check
   * triggera correttamente → 402.
   */
  it('🚨 external caller + workflow DISABLED + quota piena + X-Subworkflow-Depth=0 → 402 (NO bypass)', async () => {
    m.getWorkflow.mockResolvedValue({ id: 'wf-disabled', enabled: false });
    m.checkQuota.mockImplementation(() => {
      throw new errors.QuotaExceededError(5, 5);
    });

    const app = makeApp({ userId: 'user-external', role: 'editor' });
    const res = await app.request('/workflows/wf-disabled/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Subworkflow-Depth': '0', // exploit attempt: claim "internal"
      },
      body: JSON.stringify({ triggerType: 'manual', triggerInput: { x: 1 } }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('QUOTA_TEST_BLOCKED');
    // Conferma: startAsync NON è stato chiamato (request rejected)
    expect(m.startAsync).not.toHaveBeenCalled();
  });

  it('🚨 internal caller (auth.userId="internal") + X-Subworkflow-Depth=3 → 202 (bypass legittimo)', async () => {
    m.getWorkflow.mockResolvedValue({ id: 'wf-disabled', enabled: false });
    // Anche se quota fosse piena, il bypass è legittimo per internal caller.
    m.checkQuota.mockImplementation(() => {
      throw new errors.QuotaExceededError(5, 5);
    });

    const app = makeApp({ userId: 'internal', role: 'owner' });
    const res = await app.request('/workflows/wf-disabled/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Subworkflow-Depth': '3',
      },
      body: JSON.stringify({ triggerType: 'subworkflow', triggerInput: { x: 1 } }),
    });
    expect(res.status).toBe(202);
    expect(m.startAsync).toHaveBeenCalledTimes(1);
    // Internal: depth propagato correttamente al RunService
    expect(m.startAsync).toHaveBeenCalledWith(expect.objectContaining({ subworkflowDepth: 3 }));
  });

  it('🚨 external caller NO depth header → quota gate funziona (regression base)', async () => {
    m.getWorkflow.mockResolvedValue({ id: 'wf-disabled', enabled: false });
    m.checkQuota.mockImplementation(() => {
      throw new errors.QuotaExceededError(5, 5);
    });

    const app = makeApp({ userId: 'user-external', role: 'editor' });
    const res = await app.request('/workflows/wf-disabled/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerType: 'manual' }),
    });
    expect(res.status).toBe(402);
    expect(m.startAsync).not.toHaveBeenCalled();
  });

  it('🚨 external caller + workflow ENABLED + depth header → eseguito, depth STRIPPED (no propagation)', async () => {
    m.getWorkflow.mockResolvedValue({ id: 'wf-ok', enabled: true });

    const app = makeApp({ userId: 'user-external', role: 'editor' });
    const res = await app.request('/workflows/wf-ok/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Subworkflow-Depth': '999', // exploit: external claims deep nesting
      },
      body: JSON.stringify({ triggerType: 'manual' }),
    });
    expect(res.status).toBe(202);
    // CRITICO: depth stripped → RunService NON riceve subworkflowDepth.
    // Senza questo, l'attacker poteva mascherare run come "deep subworkflow"
    // per skippare engine limits futuri.
    expect(m.startAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({ subworkflowDepth: expect.anything() }),
    );
  });
});
