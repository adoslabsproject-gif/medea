/**
 * Bug-bounty FULL-REQUEST-PATH — routes/{runs-archive,webhook-test}.ts
 * (audit coverage 2026-06-12: entrambe a ZERO).
 *
 * runs-archive: download di archivi run .jsonl.gz — superficie con
 * PATH-TRAVERSAL hardening (archivePathSafe). Si pinna che la route rifiuti
 * i filename ostili e applichi il tenant-guard prima di toccare il FS.
 *
 * webhook-test: "Listen for Test Event" (parità n8n). Lifecycle del listener
 * CONCORRENTE in-memory: status, publish risolve il subscribe, cancel→410,
 * un secondo subscribe SUPERSEDE il primo→409. Logica race-prone = esattamente
 * ciò che un test deve inchiodare. Workflow + test-event-bus REALI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { publishTestEvent } from '@/services/test-event-bus.service.js';
import { createRunsArchiveRoutes } from './runs-archive.js';
import { createWebhookTestRoutes } from './webhook-test.js';
import type { AuthContext } from '@/middleware/auth.js';
import type { Workflow } from '@medea/engine-core-schema';

const T_A = `test-raw-${Date.now().toString(36)}-a`;
const T_B = `test-raw-${Date.now().toString(36)}-b`;

let authCtx: AuthContext | null = null;
const asUser = (tenantId: string): void => {
  authCtx = { userId: 'u', tenantId, email: 'o@t.it', role: 'owner' };
};

let app: Hono;
let workflows: WorkflowService;
let wfA: Workflow;
const created: string[] = [];
interface SqliteLike { prepare: (s: string) => { run: (...p: unknown[]) => unknown } }
const db = (): SqliteLike => getDatabase().sqlite as unknown as SqliteLike;

beforeAll(async () => {
  runMigrations();
  const bus = new InMemoryEventBus();
  workflows = new WorkflowService(bus);
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx); await next(); });
  app.route('/api/v1', createRunsArchiveRoutes(bus));
  app.route('/api/v1', createWebhookTestRoutes());
  wfA = await workflows.create({
    name: 'archiviabile', description: 'd', enabled: false,
    nodes: [{ id: 'n1', defId: 'trigger_manual', x: 0, y: 0, config: {} }],
    edges: [], nodeDefs: [], tags: [], tenantId: T_A,
  } as never);
  created.push(wfA.id);
});

afterAll(async () => {
  for (const id of created) { try { await workflows.delete(id, T_A); } catch { /* best effort */ } }
  try { db().prepare("DELETE FROM workflows WHERE tenant_id LIKE 'test-raw-%'").run(); } catch { /* opzionale */ }
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

describe('runs-archive — sicurezza path-traversal + tenant guard', () => {
  it('senza auth → mai 200', async () => {
    authCtx = null;
    expect((await req('GET', `/workflows/${wfA.id}/runs/archive`)).status).not.toBe(200);
  });

  it('GET archive su workflow ESISTENTE → 200 con lista (vuota: nessun archivio); inesistente → 404', async () => {
    asUser(T_A);
    const res = await req('GET', `/workflows/${wfA.id}/runs/archive`);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as { archives: unknown[] }).archives)).toBe(true);
    expect((await req('GET', '/workflows/non-esiste/runs/archive')).status).toBe(404);
  });

  it('TENANT GUARD: owner di B → 404 sull archivio del workflow di A (no cross-tenant)', async () => {
    asUser(T_B);
    expect((await req('GET', `/workflows/${wfA.id}/runs/archive`)).status).toBe(404);
  });

  it('PATH-TRAVERSAL: filename ostili → 400 (mai toccano il FS fuori dalla dir archivi)', async () => {
    asUser(T_A);
    for (const evil of ['..%2F..%2Fetc%2Fpasswd', 'runs-..-x.jsonl.gz', 'arbitrary.txt', 'runs-2026-06-wf.jsonl']) {
      const res = await req('GET', `/workflows/${wfA.id}/runs/archive/${evil}`);
      expect([400, 404].includes(res.status), `filename "${evil}" → ${String(res.status)}`).toBe(true);
      expect(res.status).not.toBe(200);
    }
  });

  it('filename FORMALMENTE valido ma file inesistente → 404 (non 200, non 500)', async () => {
    asUser(T_A);
    const res = await req('GET', `/workflows/${wfA.id}/runs/archive/runs-2026-06-${wfA.id}.jsonl.gz`);
    expect(res.status).toBe(404);
  });
});

describe('webhook-test — lifecycle listener concorrente (in-memory reale)', () => {
  it('senza auth → 401 su tutti i verbi', async () => {
    authCtx = null;
    expect((await req('POST', `/workflows/${wfA.id}/webhook-test`)).status).toBe(401);
    expect((await req('DELETE', `/workflows/${wfA.id}/webhook-test`)).status).toBe(401);
    expect((await req('GET', `/workflows/${wfA.id}/webhook-test/status`)).status).toBe(401);
  });

  it('status: false prima di sottoscrivere, true mentre il listener è attivo', async () => {
    asUser(T_A);
    const before = await (await req('GET', `/workflows/${wfA.id}/webhook-test/status`)).json() as { listening: boolean };
    expect(before.listening).toBe(false);

    const pending = req('POST', `/workflows/${wfA.id}/webhook-test`); // blocca
    await new Promise((r) => setTimeout(r, 30));
    const during = await (await req('GET', `/workflows/${wfA.id}/webhook-test/status`)).json() as { listening: boolean };
    expect(during.listening).toBe(true);

    // Risveglio il listener con un evento → la POST risolve con il payload.
    publishTestEvent(T_A, wfA.id, { headers: { 'x-test': '1' }, body: { hello: 'world' }, query: {}, method: 'POST' });
    const res = await pending;
    expect(res.status).toBe(200);
    const data = await res.json() as { event: { body: { hello: string }; method: string } };
    expect(data.event.body.hello).toBe('world');
    expect(data.event.method).toBe('POST');
  });

  it('cancel → la POST in attesa risolve 410; status torna false', async () => {
    asUser(T_A);
    const pending = req('POST', `/workflows/${wfA.id}/webhook-test`);
    await new Promise((r) => setTimeout(r, 30));
    const cancel = await req('DELETE', `/workflows/${wfA.id}/webhook-test`);
    expect((await cancel.json() as { cancelled: boolean }).cancelled).toBe(true);
    expect((await pending).status).toBe(410);
    const status = await (await req('GET', `/workflows/${wfA.id}/webhook-test/status`)).json() as { listening: boolean };
    expect(status.listening).toBe(false);
  });

  it('SUPERSEDED: un secondo Listen rimpiazza il primo → la prima POST risolve 409', async () => {
    asUser(T_A);
    const first = req('POST', `/workflows/${wfA.id}/webhook-test`);
    await new Promise((r) => setTimeout(r, 30));
    const second = req('POST', `/workflows/${wfA.id}/webhook-test`); // supersede
    await new Promise((r) => setTimeout(r, 30));
    expect((await first).status).toBe(409); // il primo è stato soppiantato
    // chiudo il secondo per non lasciare timer appesi
    publishTestEvent(T_A, wfA.id, { headers: {}, body: {}, query: {}, method: 'GET' });
    expect((await second).status).toBe(200);
  });

  it('cancel senza listener attivo → cancelled false', async () => {
    asUser(T_A);
    const res = await req('DELETE', `/workflows/${wfA.id}/webhook-test`);
    expect((await res.json() as { cancelled: boolean }).cancelled).toBe(false);
  });
});
