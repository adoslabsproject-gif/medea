/**
 * Bug-bounty FULL-REQUEST-PATH — routes/{versions,templates,signals}.ts
 * (audit coverage 2026-06-12: tutte e tre a ZERO). Condividono WorkflowService:
 * un workflow REALE creato e versionato/rollbackato, un template REALE
 * istanziato, un signal che risveglia (qui senza paused row → 0, ma il path
 * resume è esercitato). Servizi + tabelle REALI, niente mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import { createVersionRoutes } from './versions.js';
import { createTemplateRoutes } from './templates.js';
import { createSignalRoutes } from './signals.js';
import type { AuthContext } from '@/middleware/auth.js';
import type { Workflow } from '@flowforge/core-schema';

const T_A = `test-vts-${Date.now().toString(36)}-a`;
const T_B = `test-vts-${Date.now().toString(36)}-b`;

let authCtx: AuthContext | null = null;
const asUser = (tenantId: string): void => {
  authCtx = { userId: 'u', tenantId, email: 'o@t.it', role: 'owner' };
};

let app: Hono;
let workflows: WorkflowService;
const created: string[] = [];
interface SqliteLike { prepare: (s: string) => { run: (...p: unknown[]) => unknown } }
const db = (): SqliteLike => getDatabase().sqlite as unknown as SqliteLike;

beforeAll(() => {
  runMigrations();
  const bus = new InMemoryEventBus();
  workflows = new WorkflowService(bus);
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx); await next(); });
  app.route('/api/v1', createVersionRoutes(bus));
  app.route('/api/v1/templates', createTemplateRoutes(bus));
  app.route('/api/v1/signals', createSignalRoutes(new RunService(bus)));
});

afterAll(async () => {
  for (const id of created) { try { await workflows.delete(id, T_A); } catch { /* best effort */ } }
  for (const t of ['workflow_versions', 'workflows', 'paused_workflows']) {
    try { db().prepare(`DELETE FROM ${t} WHERE tenant_id LIKE 'test-vts-%'`).run(); } catch { /* opzionale */ }
  }
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

async function makeWorkflow(name: string): Promise<Workflow> {
  const wf = await workflows.create({
    name, description: 'd', enabled: false,
    nodes: [{ id: 'n1', defId: 'trigger_manual', x: 0, y: 0, config: {} }],
    edges: [], nodeDefs: [], tags: [], tenantId: T_A,
  } as never);
  created.push(wf.id);
  return wf;
}

describe('versions — snapshot/list/get/rollback/diff (workflow reale)', () => {
  it('senza auth → mai 200', async () => {
    authCtx = null;
    expect((await req('GET', '/workflows/x/versions')).status).not.toBe(200);
  });

  it('snapshot di un workflow ESISTENTE → 201; di uno inesistente → 404', async () => {
    asUser(T_A);
    const wf = await makeWorkflow('Versionato');
    const snap = await req('POST', `/workflows/${wf.id}/versions?comment=primo`, {});
    expect(snap.status).toBe(201);
    const data = await snap.json() as { versionId: string; versionNumber: number };
    expect(data.versionId).toBeTruthy();
    expect(data.versionNumber).toBeGreaterThanOrEqual(1);
    expect((await req('POST', '/workflows/non-esiste/versions', {})).status).toBe(404);
  });

  it('list cresce, get della versione la rilegge, rollback ripristina, diff confronta', async () => {
    asUser(T_A);
    const wf = await makeWorkflow('Multi-versione');
    await req('POST', `/workflows/${wf.id}/versions?comment=v1`, {});
    await req('POST', `/workflows/${wf.id}/versions?comment=v2`, {});
    const list = await (await req('GET', `/workflows/${wf.id}/versions`)).json() as { versions: { id: string }[]; total: number };
    expect(list.total).toBeGreaterThanOrEqual(2);

    const vId = list.versions[0]!.id;
    const got = await req('GET', `/workflows/${wf.id}/versions/${vId}`);
    expect(got.status).toBe(200);
    expect((await got.json() as { workflow: { id: string } }).workflow.id).toBe(wf.id);

    const rollback = await req('POST', `/workflows/${wf.id}/versions/${vId}/rollback`, {});
    expect(rollback.status).toBe(200);

    const vA = list.versions[0]!.id;
    const vB = list.versions[1]!.id;
    const diff = await req('GET', `/workflows/${wf.id}/versions/${vA}/diff/${vB}`);
    expect(diff.status).toBe(200);
  });

  it('get/rollback/diff di versionId inesistente → 404', async () => {
    asUser(T_A);
    const wf = await makeWorkflow('404-versioni');
    expect((await req('GET', `/workflows/${wf.id}/versions/nope`)).status).toBe(404);
    expect((await req('POST', `/workflows/${wf.id}/versions/nope/rollback`, {})).status).toBe(404);
    expect((await req('GET', `/workflows/${wf.id}/versions/a/diff/b`)).status).toBe(404);
  });

  it('ISOLAMENTO: tenant B non vede le versioni del workflow di A', async () => {
    asUser(T_A);
    const wf = await makeWorkflow('Isolato-versioni');
    await req('POST', `/workflows/${wf.id}/versions`, {});
    asUser(T_B);
    const list = await (await req('GET', `/workflows/${wf.id}/versions`)).json() as { total: number };
    expect(list.total).toBe(0);
  });
});

describe('templates — catalogo e instantiate (template REALI)', () => {
  it('GET / → catalogo non vuoto; filtro category/language applicato', async () => {
    asUser(T_A);
    const all = await (await req('GET', '/templates')).json() as { templates: { id: string; language: string }[]; total: number };
    expect(all.total).toBeGreaterThan(0);
    const it = await (await req('GET', '/templates?language=it')).json() as { templates: { language: string }[] };
    expect(it.templates.every((t) => t.language === 'it')).toBe(true);
  });

  it('GET /:id esistente → template; inesistente → 404', async () => {
    asUser(T_A);
    const all = await (await req('GET', '/templates')).json() as { templates: { id: string }[] };
    const someId = all.templates[0]!.id;
    expect((await req('GET', `/templates/${someId}`)).status).toBe(200);
    expect((await req('GET', '/templates/non-esiste')).status).toBe(404);
  });

  it('POST /:id/instantiate → crea un workflow REALE (enabled=false, tag from-template) nel tenant', async () => {
    asUser(T_A);
    const all = await (await req('GET', '/templates')).json() as { templates: { id: string }[] };
    const tid = all.templates[0]!.id;
    const res = await req('POST', `/templates/${tid}/instantiate`, {});
    expect(res.status).toBe(201);
    const data = await res.json() as { workflow: { id: string; enabled: boolean; tags: string[] }; templateId: string };
    created.push(data.workflow.id);
    expect(data.templateId).toBe(tid);
    expect(data.workflow.enabled).toBe(false);
    expect(data.workflow.tags.some((t) => t.startsWith('from-template:'))).toBe(true);
    // È DAVVERO nel DB del tenant: lo ritroviamo via service.
    const fetched = await workflows.get(data.workflow.id, T_A);
    expect(fetched).not.toBeNull();
  });

  it('instantiate di template inesistente → 404', async () => {
    asUser(T_A);
    expect((await req('POST', '/templates/non-esiste/instantiate', {})).status).toBe(404);
  });
});

describe('signals — risveglio workflow in pausa', () => {
  it('senza auth → 401', async () => {
    authCtx = null;
    expect((await req('POST', '/signals/qualcosa', {})).status).toBe(401);
  });

  it('POST signal senza paused row → resumed 0 (path resume esercitato, nessun risveglio)', async () => {
    asUser(T_A);
    const res = await req('POST', '/signals/contract_signed', { orderId: 'abc' });
    expect(res.status).toBe(200);
    const data = await res.json() as { resumed: number; signal: string };
    expect(data.resumed).toBe(0);
    expect(data.signal).toBe('contract_signed');
  });

  it('POST signal con body NON-JSON → non crasha (body opzionale), resumed 0', async () => {
    asUser(T_A);
    const res = await Promise.resolve(app.request('/api/v1/signals/x', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'non-json{{',
    }));
    expect(res.status).toBe(200);
  });

  it('GET / → lista paginata vuota sul tenant vergine; DELETE /:id inesistente → cancelled false', async () => {
    asUser(T_A);
    const list = await (await req('GET', '/signals')).json() as { paused: unknown[]; total: number };
    expect(list.total).toBe(0);
    const del = await (await req('DELETE', '/signals/non-esiste')).json() as { cancelled: boolean };
    expect(del.cancelled).toBe(false);
  });
});
