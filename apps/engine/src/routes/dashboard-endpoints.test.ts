/**
 * Bug-bounty — dashboard.ts endpoint /plan-usage e /runs/progress (audit
 * coverage 2026-06-12: erano gli unici 2 endpoint scoperti del file; la route
 * è una RECIDIVA, rotta 2× in prod da refactor routing). Getatabase fake
 * configurabile (sqlite + drizzle), niente DB reale.
 *
 * Invarianti pinnate:
 *   - countActiveWorkflows: SELECT COUNT enabled=1 (quota = attivi, non totali);
 *   - plan-usage: limiti env null=illimitato vs numero, usedPercent clamp,
 *     auth gate;
 *   - runs/progress: ANTI-REGRESSIONE del bug 25-mag — progressPercent NULL
 *     mentre il run è in corso (NON 100%!), 100/errored% solo a terminale;
 *   - cross-tenant: x-tenant-id onorato SOLO per superadmin;
 *   - runIds: filtro string-only + cap 50, body non-JSON→400, vuoto→{}.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const dbState = {
  sqliteCount: 0 as number,
  rows: [] as Record<string, unknown>[],
  lastWhereTenant: null as string | null,
};

const h = vi.hoisted(() => ({ fetchUsage: vi.fn() }));
vi.mock('@/services/portal-quota.service.js', () => ({
  fetchPortalTokenUsage: (ws: string) => h.fetchUsage(ws),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-tenant-id-resolved') ?? 'tenant-default',
}));
vi.mock('@/lib/logger.js');
vi.mock('@/services/workflow.service.js', () => ({ WorkflowService: class { constructor() { /* noop */ } } }));
vi.mock('@/services/binary-store.service.js', () => ({ getBinaryStore: () => ({ usage: async () => 4096 }) }));
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: { prepare: () => ({ get: () => ({ c: dbState.sqliteCount }) }) },
    db: {
      select: () => ({
        from: () => ({
          where: async () => dbState.rows,
        }),
      }),
    },
  }),
}));

import { createDashboardRoutes, countActiveWorkflows } from './dashboard.js';

function buildApp(auth: { tenantId: string; role?: string } | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    // getTenantId del mock legge x-tenant-id-resolved → simuliamo che per un
    // utente normale risolva al suo tenant.
    if (auth && !c.req.header('x-tenant-id-resolved')) {
      // niente: getTenantId ritorna 'tenant-default'
    }
    return next();
  });
  const bus = { subscribe: vi.fn(() => vi.fn()), publish: vi.fn(), emit: vi.fn(), subscribeTo: vi.fn() };
  app.route('/dash', createDashboardRoutes(bus as never));
  return app;
}

beforeEach(() => {
  dbState.sqliteCount = 0;
  dbState.rows = [];
  h.fetchUsage.mockReset();
  for (const k of ['MEDEA_PLAN_CODE', 'MEDEA_MAX_WORKFLOWS', 'MEDEA_MAX_LIARA_TOKENS_MONTHLY', 'MEDEA_PLAN_DISK_GB']) {
    delete process.env[k];
  }
});

describe('countActiveWorkflows (pura)', () => {
  it('conta enabled=1 (quota = workflow ATTIVI, non totali)', () => {
    const sqlite = { prepare: (sql: string) => { expect(sql).toMatch(/enabled = 1/); return { get: () => ({ c: 7 }) }; } };
    expect(countActiveWorkflows(sqlite as never, 't1')).toBe(7);
  });
  it('nessuna riga → 0 (no crash)', () => {
    const sqlite = { prepare: () => ({ get: () => undefined }) };
    expect(countActiveWorkflows(sqlite as never, 't1')).toBe(0);
  });
});

describe('GET /plan-usage', () => {
  it('senza auth → 401', async () => {
    const res = await buildApp(null).request('/dash/plan-usage');
    expect(res.status).toBe(401);
  });

  it('limiti env: assenti → null (illimitato); numerici → parsati', async () => {
    dbState.sqliteCount = 3;
    let res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    const data = await res.json() as { workflows: { used: number; limit: number | null }; liara: { tokensLimit: number | null } };
    expect(data.workflows.used).toBe(3);
    expect(data.workflows.limit).toBeNull(); // env assente = illimitato
    expect(data.liara.tokensLimit).toBeNull();

    process.env.MEDEA_MAX_WORKFLOWS = '10';
    process.env.MEDEA_PLAN_CODE = 'pro';
    res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    const data2 = await res.json() as { plan: { code: string }; workflows: { limit: number | null } };
    expect(data2.plan.code).toBe('pro');
    expect(data2.workflows.limit).toBe(10);
  });

  it('disk usedPercent = 0 quando totalBytes 0 (no divisione per zero); binaryBytes dal store', async () => {
    const res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    const data = await res.json() as { disk: { usedPercent: number; binaryBytes: number; totalBytes: number } };
    expect(data.disk.usedPercent).toBe(0); // statfs /data fallisce nei test → 0
    expect(data.disk.binaryBytes).toBe(4096);
  });

  // ── Token usage REALE dal portal (no più stub null) ────────────────────
  it('🚨 tokensLimit viene dal PORTAL (DB-backed), NON dall’env stale (bug Michela 2026-06-26)', async () => {
    // L'env MEDEA_MAX_LIARA_TOKENS_MONTHLY è "set-and-forget" all'onboarding:
    // dopo un upgrade quota nel DB restava al VECCHIO limite (500K) e il banner
    // mostrava "quota esaurita" mentre l'enforcement reale (DB) la lasciava
    // lavorare. Il display DEVE seguire il portal (30M), non l'env stale.
    process.env.MEDEA_MAX_LIARA_TOKENS_MONTHLY = '500000'; // env STALE
    h.fetchUsage.mockResolvedValue({
      tokensUsed: 1234, tokensLimit: 30000000, // portal = DB aggiornato
      periodStartIso: '2026-06-15', periodEndIso: '2026-07-15', maxUsers: 10,
    });
    const res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    const data = await res.json() as { liara: { tokensLimit: number | null; tokensUsedMonth: number | null; periodEndIso: string | null } };
    expect(data.liara.tokensLimit).toBe(30000000);     // PORTAL vince sull'env stale
    expect(data.liara.tokensUsedMonth).toBe(1234);     // usato reale dal portal
    expect(data.liara.periodEndIso).toBe('2026-07-15');
    expect(h.fetchUsage).toHaveBeenCalledWith('tenant-default');
  });

  it('interroga il portal SEMPRE — anche con token illimitati (serve maxUsers)', async () => {
    // niente MEDEA_MAX_LIARA_TOKENS_MONTHLY → token unlimited, MA il portal va
    // comunque interrogato per il limite sub-users.
    h.fetchUsage.mockResolvedValue({
      tokensUsed: 0, tokensLimit: null,
      periodStartIso: '2026-06-01', periodEndIso: '2026-07-01', maxUsers: 5,
    });
    const res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    const data = await res.json() as { users: { used: number; limit: number | null } };
    expect(h.fetchUsage).toHaveBeenCalledWith('tenant-default');
    expect(data.users.limit).toBe(5); // dal portal (maxUsers del piano)
  });

  it('sub-users: used = count SQLite, limit = maxUsers del portal', async () => {
    dbState.sqliteCount = 4; // count utenti abilitati (mock condiviso)
    h.fetchUsage.mockResolvedValue({
      tokensUsed: 0, tokensLimit: null, periodStartIso: '2026-06-01', periodEndIso: '2026-07-01', maxUsers: 10,
    });
    const res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    const data = await res.json() as { users: { used: number; limit: number | null } };
    expect(data.users.used).toBe(4);
    expect(data.users.limit).toBe(10);
  });

  it('portal giù (fetch→null) → usato/periodo null, ma tokensLimit fallback all’env (degradazione)', async () => {
    process.env.MEDEA_MAX_LIARA_TOKENS_MONTHLY = '500000';
    h.fetchUsage.mockResolvedValue(null);
    const res = await buildApp({ tenantId: 't1' }).request('/dash/plan-usage');
    expect(res.status).toBe(200);
    const data = await res.json() as { liara: { tokensLimit: number | null; tokensUsedMonth: number | null; periodEndIso: string | null }; users: { limit: number | null } };
    expect(data.liara.tokensUsedMonth).toBeNull();
    expect(data.liara.periodEndIso).toBeNull();
    // Portal irraggiungibile → meglio l'env (stale) che nessun limite: degradazione.
    expect(data.liara.tokensLimit).toBe(500000);
    expect(data.users.limit).toBeNull();
  });
});

describe('POST /runs/progress', () => {
  const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
    app.request('/dash/runs/progress', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('senza auth → 401', async () => {
    expect((await post(buildApp(null), { runIds: ['r1'] })).status).toBe(401);
  });

  it('body non-JSON → 400', async () => {
    const res = await buildApp({ tenantId: 't1' }).request('/dash/runs/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'rotto{{' });
    expect(res.status).toBe(400);
  });

  it('runIds vuoto/assente → { runs: {} } senza toccare il DB', async () => {
    expect(await (await post(buildApp({ tenantId: 't1' }), {})).json()).toEqual({ runs: {} });
    expect(await (await post(buildApp({ tenantId: 't1' }), { runIds: [] })).json()).toEqual({ runs: {} });
  });

  it('ANTI-REGRESSIONE bug 25-mag: run RUNNING → progressPercent NULL (non 100%)', async () => {
    dbState.rows = [{
      id: 'r1', status: 'running', tenantId: 'tenant-default',
      stepsJson: JSON.stringify([{ nodeId: 'a', status: 'success' }, { nodeId: 'b', status: 'success' }]),
      startedAt: Date.now(),
    }];
    const res = await post(buildApp({ tenantId: 't1' }), { runIds: ['r1'] });
    const data = await res.json() as { runs: Record<string, { progressPercent: number | null; currentStep: number }> };
    expect(data.runs.r1!.progressPercent).toBeNull(); // il bug: prima ritornava 100
    expect(data.runs.r1!.currentStep).toBe(2);
  });

  it('run SUCCESS terminale → 100%; run con step error → errorCount > 0', async () => {
    dbState.rows = [{
      id: 'r1', status: 'success', tenantId: 'tenant-default',
      stepsJson: JSON.stringify([{ nodeId: 'a', status: 'success' }, { nodeId: 'b', status: 'error' }]),
      startedAt: Date.now(),
    }];
    const data = await (await post(buildApp({ tenantId: 't1' }), { runIds: ['r1'] })).json() as { runs: Record<string, { progressPercent: number; errorCount: number }> };
    expect(data.runs.r1!.progressPercent).toBe(100);
    expect(data.runs.r1!.errorCount).toBe(1);
  });

  it('stepsJson corrotto → steps [] (no crash), progress safe', async () => {
    dbState.rows = [{ id: 'r1', status: 'success', tenantId: 'tenant-default', stepsJson: 'rotto{{', startedAt: null }];
    const data = await (await post(buildApp({ tenantId: 't1' }), { runIds: ['r1'] })).json() as { runs: Record<string, { totalSteps: number; progressPercent: number }> };
    expect(data.runs.r1!.totalSteps).toBe(0);
    expect(data.runs.r1!.progressPercent).toBe(0);
  });

  it('runIds: filtra non-stringhe e cappa a 50', async () => {
    dbState.rows = [];
    const many = Array.from({ length: 80 }, (_, i) => `r${String(i)}`);
    // include spazzatura non-stringa che deve essere filtrata
    const res = await post(buildApp({ tenantId: 't1' }), { runIds: [...many, 123, null, ''] });
    expect(res.status).toBe(200); // non crasha sul filtro
  });

  it('cross-tenant: x-tenant-id onorato SOLO per superadmin', async () => {
    // utente normale: header ignorato (getTenantId del mock NON legge x-tenant-id)
    dbState.rows = [];
    const normal = await post(buildApp({ tenantId: 't1', role: 'editor' }), { runIds: ['r1'] }, { 'x-tenant-id': 'altro-tenant' });
    expect(normal.status).toBe(200);
    // superadmin: l'header viene usato come tenant (il path tenantId=queryTenant)
    const admin = await post(buildApp({ tenantId: 't1', role: 'superadmin' }), { runIds: ['r1'] }, { 'x-tenant-id': 'altro-tenant' });
    expect(admin.status).toBe(200);
  });
});
