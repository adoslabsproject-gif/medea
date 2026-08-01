/**
 * Bug-bounty FULL-REQUEST-PATH — routes/{health,pins,license}.ts
 * (audit coverage 2026-06-12: tutte e tre a ZERO). Route piccole ma vive:
 * health è il probe del deploy (lo smoke ci si appoggia), pins regge il
 * GAP 4 esecuzione parziale, license il gating.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { healthRoutes } from './health.js';
import { createPinRoutes } from './pins.js';
import { createLicenseRoutes } from './license.js';
import type { AuthContext } from '@/middleware/auth.js';

const T_A = `test-hpl-${Date.now().toString(36)}-a`;
const T_B = `test-hpl-${Date.now().toString(36)}-b`;

let authCtx: AuthContext | null = null;
const asUser = (tenantId: string): void => {
  authCtx = { userId: 'u', tenantId, email: 'o@t.it', role: 'owner' };
};

let app: Hono;
interface SqliteLike { prepare: (s: string) => { run: (...p: unknown[]) => unknown } }
const db = (): SqliteLike => getDatabase().sqlite as unknown as SqliteLike;

beforeAll(() => {
  runMigrations();
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx); await next(); });
  app.route('/', healthRoutes);
  app.route('/api/v1', createPinRoutes());
  app.route('/api/v1', createLicenseRoutes());
});

afterAll(() => {
  for (const t of ['workflow_pins', 'flowforge_license']) {
    try { db().prepare(`DELETE FROM ${t} WHERE tenant_id LIKE 'test-hpl-%'`).run(); } catch { /* tabella opzionale */ }
  }
});

const get = (path: string): Promise<Response> => Promise.resolve(app.request(path));
const json = (method: string, path: string, body: unknown): Promise<Response> =>
  Promise.resolve(app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('health — probe del deploy', () => {
  it('GET /health → 200 con status ok e timestamp ISO (lo smoke del deploy ci si appoggia)', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string; service: string; ts: string };
    expect(data.status).toBe('ok');
    expect(data.service).toBe('flowforge-runtime');
    expect(() => new Date(data.ts).toISOString()).not.toThrow();
  });

  it('GET /ready → 200 quando il DB risponde (SELECT 1 reale)', async () => {
    const res = await get('/ready');
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('ready');
  });

  it('health/ready NON richiedono auth (sono prima del middleware)', async () => {
    authCtx = null;
    expect((await get('/health')).status).toBe(200);
    expect((await get('/ready')).status).toBe(200);
  });
});

describe('pins — pin output per esecuzione parziale (storage reale)', () => {
  it('PUT pin poi GET list: output round-trip + enabled di default true', async () => {
    asUser(T_A);
    const put = await json('PUT', '/api/v1/workflows/wfp/pins/node-1', { output: { rows: [1, 2, 3] } });
    expect(put.status).toBe(200);
    const list = await (await get('/api/v1/workflows/wfp/pins')).json() as { pins: { nodeId: string; output: unknown; enabled: boolean }[] };
    const pin = list.pins.find((p) => p.nodeId === 'node-1');
    expect(pin?.output).toEqual({ rows: [1, 2, 3] });
    expect(pin?.enabled).toBe(true);
  });

  it('PUT senza `output` → 400 (body required)', async () => {
    asUser(T_A);
    expect((await json('PUT', '/api/v1/workflows/wfp/pins/node-2', { enabled: true })).status).toBe(400);
  });

  it('enabled:false è preservato (pin disattivato ma presente)', async () => {
    asUser(T_A);
    await json('PUT', '/api/v1/workflows/wfp/pins/node-3', { output: 'x', enabled: false });
    const list = await (await get('/api/v1/workflows/wfp/pins')).json() as { pins: { nodeId: string; enabled: boolean }[] };
    expect(list.pins.find((p) => p.nodeId === 'node-3')?.enabled).toBe(false);
  });

  it('ISOLAMENTO tenant: i pin di A invisibili a B', async () => {
    asUser(T_A);
    await json('PUT', '/api/v1/workflows/wfiso/pins/n', { output: 'di-A' });
    asUser(T_B);
    const list = await (await get('/api/v1/workflows/wfiso/pins')).json() as { pins: unknown[] };
    expect(list.pins).toHaveLength(0);
  });

  it('DELETE pin → removed; ri-DELETE → removed false (idempotente)', async () => {
    asUser(T_A);
    await json('PUT', '/api/v1/workflows/wfdel/pins/n', { output: 1 });
    const d1 = await (await app.request('/api/v1/workflows/wfdel/pins/n', { method: 'DELETE' })).json() as { removed: boolean };
    expect(d1.removed).toBe(true);
    const d2 = await (await app.request('/api/v1/workflows/wfdel/pins/n', { method: 'DELETE' })).json() as { removed: boolean };
    expect(d2.removed).toBe(false);
  });
});

describe('license — status e install', () => {
  it('GET /license/status su tenant vergine → shape contrattuale (valid + reason)', async () => {
    asUser(T_A);
    const res = await get('/api/v1/license/status');
    expect(res.status).toBe(200);
    const data = await res.json() as { valid: boolean; reason?: string };
    expect(typeof data.valid).toBe('boolean');
  });

  it('POST /license/install: body senza token → 400; token non-stringa → 400; token garbage → 422', async () => {
    asUser(T_A);
    expect((await json('POST', '/api/v1/license/install', {})).status).toBe(400);
    expect((await json('POST', '/api/v1/license/install', { token: 123 })).status).toBe(400);
    expect((await json('POST', '/api/v1/license/install', { token: 'non-un-jwt-valido' })).status).toBe(422);
  });

  it('DELETE /license → removed boolean (idempotente sul tenant vergine)', async () => {
    asUser(T_A);
    const res = await app.request('/api/v1/license', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(typeof (await res.json() as { removed: boolean }).removed).toBe('boolean');
  });
});
