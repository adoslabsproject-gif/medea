/**
 * Endpoint lock di editing (#7 Tier 1) — test e2e con Hono reale + SQLite
 * :memory: reale (service vero, no mock della logica). Copre auth gate, acquire
 * 200/409, heartbeat, release, status.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));

import { WorkflowLockService } from '@/services/workflow-lock.service.js';
import { registerWorkflowLockRoutes } from './workflow-lock.routes.js';
import type { WorkflowService } from '@/services/workflow.service.js';

/**
 * Stub WorkflowService — il test simula il tenant gate H3+M3.
 * `existsIds` è il set di workflow id che `get()` riconoscerà come esistenti
 * per il tenant `defaultTenant`. Tutti gli id NON in `existsIds` ritornano null
 * → handler dovrebbe rispondere 404.
 */
function makeStubWorkflowService(existsIds: Set<string>, tenantId = 't1'): WorkflowService {
  return {
    get: async (id: string, tid = 'default') => {
      if (tid !== tenantId) return null;
      return existsIds.has(id) ? ({ id, tenantId: tid } as never) : null;
    },
  } as unknown as WorkflowService;
}

function makeApp(
  auth: { userId: string; email: string; tenantId?: string } | null,
  options: { existsIds?: Set<string>; tenantId?: string } = {},
): Hono {
  const app = new Hono();
  const tenantId = options.tenantId ?? 't1';
  const fullAuth = auth ? { tenantId, ...auth } : null;
  app.use('*', async (c, next) => {
    c.set('auth', fullAuth as never);
    await next();
  });
  const stubWf = makeStubWorkflowService(options.existsIds ?? new Set(['wf1']), tenantId);
  registerWorkflowLockRoutes(app, new WorkflowLockService(), stubWf);
  return app;
}

const marco = { userId: 'marco', email: 'marco@x.it' };
const ada = { userId: 'ada', email: 'ada@x.it' };

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`CREATE TABLE workflow_locks (workflow_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    user_name TEXT NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL);`);
});

describe('workflow lock routes', () => {
  it('no auth → 401 su ogni endpoint', async () => {
    const app = makeApp(null);
    expect((await app.request('/wf1/lock')).status).toBe(401);
    expect((await app.request('/wf1/lock', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/wf1/lock/heartbeat', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/wf1/lock', { method: 'DELETE' })).status).toBe(401);
  });

  it('POST acquire libero → 200 acquired + status mine', async () => {
    const res = await makeApp(marco).request('/wf1/lock', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acquired: boolean; status: { mine: boolean } };
    expect(body.acquired).toBe(true);
    expect(body.status.mine).toBe(true);
  });

  it('POST acquire occupato da altro → 409 con chi edita', async () => {
    await makeApp(marco).request('/wf1/lock', { method: 'POST' });
    const res = await makeApp(ada).request('/wf1/lock', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      acquired: boolean;
      decision: { by?: { userName: string } };
    };
    expect(body.acquired).toBe(false);
    expect(body.decision.by?.userName).toBe('marco@x.it');
  });

  it('GET status riflette il lock', async () => {
    await makeApp(marco).request('/wf1/lock', { method: 'POST' });
    const res = await makeApp(ada).request('/wf1/lock');
    const body = (await res.json()) as { locked: boolean; mine: boolean };
    expect(body.locked).toBe(true);
    expect(body.mine).toBe(false);
  });

  it('heartbeat del proprietario → renewed true; di un altro → 409', async () => {
    await makeApp(marco).request('/wf1/lock', { method: 'POST' });
    const ok = await makeApp(marco).request('/wf1/lock/heartbeat', { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { renewed: boolean }).renewed).toBe(true);
    const ko = await makeApp(ada).request('/wf1/lock/heartbeat', { method: 'POST' });
    expect(ko.status).toBe(409);
  });

  it('DELETE release libera il lock', async () => {
    await makeApp(marco).request('/wf1/lock', { method: 'POST' });
    const del = await makeApp(marco).request('/wf1/lock', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const st = await makeApp(ada).request('/wf1/lock');
    expect(((await st.json()) as { locked: boolean }).locked).toBe(false);
  });

  /**
   * 🚨 AUDIT FIX H3+M3 (2026-06-09) — REGRESSION GUARD:
   *
   * Pre-fix: POST/POST hb/DELETE su /:id/lock con id workflow inesistente nel
   * tenant corrente creava comunque una row in workflow_locks (zombie). E
   * permetteva a superadmin impersonate di rubare/refreshare/releasare lock di
   * un altro tenant conoscendo l'id. Fix: gate workflowService.get(id, tenantId)
   * come prima check di ogni mutating handler → 404 se non trovato.
   */
  it('🚨 [REGRESSION H3+M3] POST /wf-ghost/lock → 404 (workflow non esiste nel tenant)', async () => {
    const app = makeApp(marco, { existsIds: new Set(['wf1']) });
    const res = await app.request('/wf-ghost/lock', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('🚨 [REGRESSION H3+M3] POST hb /wf-ghost → 404, DELETE /wf-ghost → 404', async () => {
    const app = makeApp(marco, { existsIds: new Set(['wf1']) });
    expect((await app.request('/wf-ghost/lock/heartbeat', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/wf-ghost/lock', { method: 'DELETE' })).status).toBe(404);
  });

  it('🚨 [REGRESSION H3] cross-tenant via impersonate → 404 (tenantId diverso = workflow non visibile)', async () => {
    // Tenant nel test = 't1'. Workflow esiste in 't1'. Impersonate user con tenant 't2' → service.get(wf1, t2) → null → 404.
    const app = makeApp(
      { ...marco, tenantId: 't2' },
      { existsIds: new Set(['wf1']), tenantId: 't1' },
    );
    expect((await app.request('/wf1/lock', { method: 'POST' })).status).toBe(404);
  });

  /**
   * 🚨 AUDIT FIX M4 (2026-06-09) — POST /lock/release alias per sendBeacon:
   * navigator.sendBeacon supporta solo POST. Alias che fa stesso release()
   * del DELETE classico → garantisce release immediato anche su tab brutally
   * chiusa (window close, OS shutdown).
   */
  it('🚨 [REGRESSION M4] POST /lock/release rilascia il lock identico al DELETE', async () => {
    await makeApp(marco).request('/wf1/lock', { method: 'POST' });
    const rel = await makeApp(marco).request('/wf1/lock/release', { method: 'POST' });
    expect(rel.status).toBe(200);
    expect(((await rel.json()) as { released: boolean }).released).toBe(true);
    // Ada può ora prendere il lock
    const ada2 = await makeApp(ada).request('/wf1/lock', { method: 'POST' });
    expect(ada2.status).toBe(200);
  });

  it('🚨 [REGRESSION M4] POST /lock/release con auth ma workflow inesistente → 404', async () => {
    const app = makeApp(marco, { existsIds: new Set(['wf1']) });
    const rel = await app.request('/wf-ghost/lock/release', { method: 'POST' });
    expect(rel.status).toBe(404);
  });

  it('🚨 [REGRESSION M4] POST /lock/release senza auth → 401', async () => {
    const rel = await makeApp(null).request('/wf1/lock/release', { method: 'POST' });
    expect(rel.status).toBe(401);
  });
});
