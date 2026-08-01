/**
 * Test 2026-grade — admin/workers.ts (fleet workers control).
 *
 * 🚨 ADMIN-CRITICAL: super_admin restart/drain/resume/concurrency dei worker
 * di produzione. Action queue pattern (DB column, worker la legge in <=10s).
 *
 * Coverage 7 endpoint:
 *  - GET   /admin/workers
 *  - POST  /admin/workers/:id/restart
 *  - POST  /admin/workers/:id/drain
 *  - POST  /admin/workers/:id/resume (NOTA: no audit nel source — verifico gap)
 *  - PATCH /admin/workers/:id/concurrency (Zod 1-64)
 *  - GET   /admin/workers/:id/logs (tail clamped 2000, PID-safe via execFile)
 *
 * NOTA: stream endpoint (SSE) NON testato qui — richiede pipe child process
 * + signal abort, fuori scope per unit test.
 *
 * 🚨 Security:
 *  - id param mandatory + 404 esplicito (no info leak)
 *  - concurrency Zod 1-64 (no 0, no negative, no >64 anti-DoS)
 *  - tail CAPPED 2000 (anti-DoS journalctl)
 *  - PID sanitize digits-only (no shell injection)
 *  - audit log per restart/drain/concurrency (resume NO — gap del source)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  listActive: vi.fn(),
  requestAction: vi.fn(),
  requestConcurrency: vi.fn(),
  auditAppend: vi.fn(),
  prepareGet: vi.fn(),
  readWorkerLogs: vi.fn(),
}));

vi.mock('@/services/worker-coordination.service.js', () => ({
  WorkerCoordinationService: class {
    listActive = m.listActive;
    requestAction = m.requestAction;
    requestConcurrency = m.requestConcurrency;
  },
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append = m.auditAppend;
  },
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      prepare: () => ({
        get: (id: string) => m.prepareGet(id),
      }),
    },
  }),
}));

vi.mock('./worker-logs.js', () => ({
  readWorkerLogs: (...a: unknown[]) => m.readWorkerLogs(...a),
}));

import { registerWorkersRoutes } from './workers.js';

interface Auth { userId: string; email: string }

function makeApp(auth: Auth | null = { userId: 'u-admin', email: 'admin@x.com' }): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth' as never, auth as never);
    await next();
  });
  registerWorkersRoutes(app);
  return app;
}

beforeEach(() => {
  m.listActive.mockReset().mockReturnValue([]);
  m.requestAction.mockReset().mockReturnValue(true);
  m.requestConcurrency.mockReset().mockReturnValue(true);
  m.auditAppend.mockReset().mockResolvedValue(undefined);
  m.prepareGet.mockReset();
  m.readWorkerLogs.mockReset();
});

describe('GET /admin/workers', () => {
  it('returns list from WorkerCoordinationService.listActive', async () => {
    m.listActive.mockReturnValue([
      { id: 'w-1', hostname: 'host1', pid: 1234, concurrency: 4 },
      { id: 'w-2', hostname: 'host2', pid: 5678, concurrency: 8 },
    ]);
    const res = await makeApp().request('/admin/workers');
    expect(res.status).toBe(200);
    const body = await res.json() as { workers: unknown[] };
    expect(body.workers).toHaveLength(2);
  });
});

describe('POST /admin/workers/:id/restart', () => {
  it('🚨 happy: requestAction("restart") + audit', async () => {
    const res = await makeApp().request('/admin/workers/w-1/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(m.requestAction).toHaveBeenCalledWith('w-1', 'restart', 'admin@x.com');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'system',
      action: 'admin.worker.restart',
      resourceType: 'worker',
      resourceId: 'w-1',
      actorId: 'u-admin',
      metadata: { action: 'restart', actorEmail: 'admin@x.com' },
    }));
    const body = await res.json() as { ok: boolean; action: string; appliedWithin: string };
    expect(body).toEqual({ ok: true, action: 'restart', appliedWithin: '10s' });
  });

  it('🚨 worker not found → 404 + no audit', async () => {
    m.requestAction.mockReturnValue(false);
    const res = await makeApp().request('/admin/workers/ghost/restart', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('senza auth → actor email fallback "admin" + actorId undefined', async () => {
    await makeApp(null).request('/admin/workers/w-1/restart', { method: 'POST' });
    expect(m.requestAction).toHaveBeenCalledWith('w-1', 'restart', 'admin');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ actorEmail: null }),
    }));
  });
});

describe('POST /admin/workers/:id/drain', () => {
  it('🚨 happy: drain action + audit', async () => {
    const res = await makeApp().request('/admin/workers/w-1/drain', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(m.requestAction).toHaveBeenCalledWith('w-1', 'drain', 'admin@x.com');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.worker.drain',
    }));
  });

  it('worker not found → 404', async () => {
    m.requestAction.mockReturnValue(false);
    const res = await makeApp().request('/admin/workers/ghost/drain', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/workers/:id/resume', () => {
  it('🚨 happy: resume action → audit DUREVOLE come restart/drain (audit #7)', async () => {
    const res = await makeApp().request('/admin/workers/w-1/resume', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(m.requestAction).toHaveBeenCalledWith('w-1', 'resume', 'admin@x.com');
    // Anti-regressione: resume NON deve più essere l'unica azione senza traccia.
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    const a = m.auditAppend.mock.calls[0]![0] as { action: string; resourceId: string; actorId?: string };
    expect(a.action).toBe('admin.worker.resume');
    expect(a.resourceId).toBe('w-1');
  });

  it('worker not found → 404, niente audit', async () => {
    m.requestAction.mockReturnValue(false);
    const res = await makeApp().request('/admin/workers/ghost/resume', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });
});

describe('PATCH /admin/workers/:id/concurrency', () => {
  it('🚨 happy: concurrency 8 in range 1-64 → requestConcurrency + audit', async () => {
    const res = await makeApp().request('/admin/workers/w-1/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 8 }),
    });
    expect(res.status).toBe(200);
    expect(m.requestConcurrency).toHaveBeenCalledWith('w-1', 8, 'admin@x.com');
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.worker.concurrency',
      metadata: { concurrency: 8, actorEmail: 'admin@x.com' },
    }));
  });

  it('🚨 concurrency 0 → 400 (Zod min 1)', async () => {
    const res = await makeApp().request('/admin/workers/w-1/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 concurrency 65 → 400 (Zod max 64, anti-DoS)', async () => {
    const res = await makeApp().request('/admin/workers/w-1/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 65 }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 concurrency non-integer → 400', async () => {
    const res = await makeApp().request('/admin/workers/w-1/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 3.5 }),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 body mancante → 400', async () => {
    const res = await makeApp().request('/admin/workers/w-1/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('🚨 worker not found → 404', async () => {
    m.requestConcurrency.mockReturnValue(false);
    const res = await makeApp().request('/admin/workers/ghost/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 4 }),
    });
    expect(res.status).toBe(404);
  });

  it('🚨 service throws → 400 con error message', async () => {
    m.requestConcurrency.mockImplementation(() => { throw new Error('Cannot set: worker is draining'); });
    const res = await makeApp().request('/admin/workers/w-1/concurrency', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 4 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('draining');
  });
});

describe('GET /admin/workers/:id/logs', () => {
  it('🚨 happy: get pid from DB + readWorkerLogs(pid, tail) + return lines', async () => {
    m.prepareGet.mockReturnValue({ pid: 1234, hostname: 'host-1' });
    m.readWorkerLogs.mockReturnValue('line1\nline2\nline3');
    const res = await makeApp().request('/admin/workers/w-1/logs');
    expect(res.status).toBe(200);
    expect(m.readWorkerLogs).toHaveBeenCalledWith(1234, 200);
    const body = await res.json() as {
      workerId: string; pid: number; tail: number; lines: string[];
    };
    expect(body.pid).toBe(1234);
    expect(body.lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('🚨 tail CAPPED a 2000 (anti-DoS)', async () => {
    m.prepareGet.mockReturnValue({ pid: 1, hostname: 'h' });
    m.readWorkerLogs.mockReturnValue('');
    await makeApp().request('/admin/workers/w-1/logs?tail=99999');
    expect(m.readWorkerLogs).toHaveBeenCalledWith(1, 2000);
  });

  it('tail default = 200 quando query mancante', async () => {
    m.prepareGet.mockReturnValue({ pid: 1, hostname: 'h' });
    m.readWorkerLogs.mockReturnValue('');
    await makeApp().request('/admin/workers/w-1/logs');
    expect(m.readWorkerLogs).toHaveBeenCalledWith(1, 200);
  });

  it('🚨 worker not found in DB → 404', async () => {
    m.prepareGet.mockReturnValue(undefined);
    const res = await makeApp().request('/admin/workers/ghost/logs');
    expect(res.status).toBe(404);
    expect(m.readWorkerLogs).not.toHaveBeenCalled();
  });

  it('🚨 readWorkerLogs throws → 500 con detail', async () => {
    m.prepareGet.mockReturnValue({ pid: 1, hostname: 'h' });
    m.readWorkerLogs.mockImplementation(() => { throw new Error('journalctl access denied'); });
    const res = await makeApp().request('/admin/workers/w-1/logs');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe('Log fetch failed');
    expect(body.detail).toContain('access denied');
  });
});
