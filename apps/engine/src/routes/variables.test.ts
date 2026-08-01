/**
 * Bug-bounty FULL-REQUEST-PATH — routes/variables.ts (audit coverage
 * 2026-06-12: route a ZERO). Doppia superficie: variabili tenant-global
 * (env-like) + variabili per-workflow, entrambe lette dai nodi via
 * interpreter scope (`vars.<name>`). Servizi + tabella REALI.
 *
 * Invarianti: round-trip JSON fedele dei valori (oggetti/array/bool/null,
 * NON solo stringhe), isolamento tenant + isolamento per-workflow, 404 su
 * inesistenti, no-auth mai 200.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { createVariableRoutes } from './variables.js';
import type { AuthContext } from '@/middleware/auth.js';

const T_A = `test-var-${Date.now().toString(36)}-a`;
const T_B = `test-var-${Date.now().toString(36)}-b`;

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
  app.route('/api/v1', createVariableRoutes());
});

afterAll(() => {
  for (const t of ['workflow_variables', 'tenant_variables']) {
    db().prepare(`DELETE FROM ${t} WHERE tenant_id LIKE 'test-var-%'`).run();
  }
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

describe('variables per-workflow (storage reale)', () => {
  it('senza auth → mai 200', async () => {
    authCtx = null;
    expect((await req('GET', '/workflows/wf1/variables')).status).not.toBe(200);
  });

  it('PUT poi GET: round-trip JSON FEDELE per ogni tipo (non solo stringhe)', async () => {
    asUser(T_A);
    const cases: [string, unknown][] = [
      ['stringa', 'ciao'],
      ['numero', 42],
      ['bool', true],
      ['nullo', null],
      ['oggetto', { a: 1, b: ['x', 'y'] }],
      ['array', [1, 2, 3]],
    ];
    for (const [name, value] of cases) {
      expect((await req('PUT', `/workflows/wf1/variables/${name}`, { value })).status).toBe(200);
      const got = await (await req('GET', `/workflows/wf1/variables/${name}`)).json() as { value: unknown };
      expect(got.value, `round-trip ${name}`).toEqual(value);
    }
  });

  it('GET variabile inesistente → 404', async () => {
    asUser(T_A);
    expect((await req('GET', '/workflows/wf1/variables/non-esiste')).status).toBe(404);
  });

  it('ISOLAMENTO per-workflow: una var di wf1 NON è visibile da wf2', async () => {
    asUser(T_A);
    await req('PUT', '/workflows/wf1/variables/solo-wf1', { value: 'segreto-wf1' });
    expect((await req('GET', '/workflows/wf2/variables/solo-wf1')).status).toBe(404);
  });

  it('ISOLAMENTO tenant: la var di A invisibile a B', async () => {
    asUser(T_A);
    await req('PUT', '/workflows/wfx/variables/k', { value: 'di-A' });
    asUser(T_B);
    expect((await req('GET', '/workflows/wfx/variables/k')).status).toBe(404);
  });

  it('DELETE → 204, poi GET 404, re-delete → 404', async () => {
    asUser(T_A);
    await req('PUT', '/workflows/wfd/variables/tmp', { value: 1 });
    expect((await req('DELETE', '/workflows/wfd/variables/tmp')).status).toBe(204);
    expect((await req('GET', '/workflows/wfd/variables/tmp')).status).toBe(404);
    expect((await req('DELETE', '/workflows/wfd/variables/tmp')).status).toBe(404);
  });
});

describe('variables tenant-global (env-like)', () => {
  it('PUT/GET list/DELETE round-trip + isolamento tenant', async () => {
    asUser(T_A);
    expect((await req('PUT', '/variables/API_BASE', { value: 'https://a.test' })).status).toBe(200);
    const listA = await (await req('GET', '/variables')).json() as { variables: Record<string, unknown> };
    expect(JSON.stringify(listA.variables)).toContain('https://a.test');

    asUser(T_B);
    const listB = await (await req('GET', '/variables')).json() as { variables: Record<string, unknown> };
    expect(JSON.stringify(listB.variables)).not.toContain('https://a.test');

    asUser(T_A);
    expect((await req('DELETE', '/variables/API_BASE')).status).toBe(204);
    expect((await req('DELETE', '/variables/API_BASE')).status).toBe(404);
  });
});
