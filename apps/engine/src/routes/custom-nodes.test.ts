/**
 * routes/custom-nodes.test.ts — Integration test REALI per le REST API.
 *
 * Coverage 2026-grade end-to-end (request → service → DB → response):
 *   - GET  /quota             — plan info + counter
 *   - GET  /                  — list filtered/paginated
 *   - POST /                  — create draft (success + 400 zod + 409 conflict + 402 quota)
 *   - GET  /:id               — fetch full (404 not-found)
 *   - PUT  /:id               — update + semver bump
 *   - DELETE /:id             — archive soft-delete
 *   - GET  /:id/versions      — history
 *   - POST /:id/rollback      — load + bump
 *   - POST /:id/compile       — esbuild + persist
 *   - RBAC: editor → 403 sui write endpoints; null auth → 401
 *
 * Pattern: monto la rotta reale + DB SQLite in-memory + auth mock c.set('auth').
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import SqliteDatabase from 'better-sqlite3';
import { SCHEMA_SQL } from '@/storage/migrate.schema.js';

const dbConnections: ReturnType<typeof SqliteDatabase>[] = [];

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    const conn = dbConnections[dbConnections.length - 1]!;
    return {
      sqlite: {
        prepare: (sql: string) => {
          const stmt = conn.prepare(sql);
          return {
            run: (...p: unknown[]) => stmt.run(...p),
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => stmt.all(...p),
          };
        },
        exec: (sql: string) => {
          conn.exec(sql);
        },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) =>
          conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));
vi.mock('@/lib/logger.js');

const { createCustomNodesRoutes } = await import('./custom-nodes.js');

interface TestAuth {
  userId: string;
  role: 'viewer' | 'operator' | 'editor' | 'owner';
  email: string;
  tenantId: string;
}
const OWNER: TestAuth = { userId: 'owner-1', role: 'owner', email: 'o@x.it', tenantId: 'ws-test' };
const EDITOR: TestAuth = {
  userId: 'editor-1',
  role: 'editor',
  email: 'e@x.it',
  tenantId: 'ws-test',
};

function buildApp(auth: TestAuth | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    return next();
  });
  app.route('/api/v1/custom-nodes', createCustomNodesRoutes());
  return app;
}

const validBody = {
  slug: 'route-test',
  displayName: 'Route Test Node',
  description: 'IT',
  sourceExecutor: 'export const executor = async () => ({ output: {} });',
  sourceDefinition: 'export const definition = { defId: "rt" };',
  sourceSchema: 'export const schema = {};',
};

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function putJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
  process.env.MEDEA_PLAN_CODE = 'pro';
  process.env.MEDEA_TENANT_ID = 'ws-test';
});
afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
  delete process.env.MEDEA_PLAN_CODE;
  delete process.env.MEDEA_TENANT_ID;
});

describe('🚨 GET /quota', () => {
  it('🚨 owner → 200 + plan capability + counter 0', async () => {
    const res = await buildApp(OWNER).request('/api/v1/custom-nodes/quota');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.plan).toBe('pro');
    expect(body.current).toBe(0);
    expect(body.limit).toBe(20);
    expect(body.canPublishMarketplace).toBe(true);
  });

  it('🚨 owner free plan → limit 0', async () => {
    process.env.MEDEA_PLAN_CODE = 'free';
    const res = await buildApp(OWNER).request('/api/v1/custom-nodes/quota');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.plan).toBe('free');
    expect(body.limit).toBe(0);
  });
});

describe('🚨 POST / (create)', () => {
  it('🚨 owner + valid → 201 + body', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe('route-test');
    expect(body.status).toBe('draft');
    expect(body.semver).toBe('0.1.0');
  });

  it('🚨 editor (no owner) → 403', async () => {
    const res = await postJson(buildApp(EDITOR), '/api/v1/custom-nodes', validBody);
    expect(res.status).toBe(403);
  });

  it('🚨 null auth → 401', async () => {
    const res = await postJson(buildApp(null), '/api/v1/custom-nodes', validBody);
    expect(res.status).toBe(401);
  });

  it('🚨 slug invalido → 400 con issues Zod', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', {
      ...validBody,
      slug: 'UPPER',
    });
    // Hono zValidator ritorna 400 con shape standard zValidator (success:false + error)
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    // Verifica generica: rispondiamo con qualcosa che descrive l'errore Zod
    const serialized = JSON.stringify(body);
    expect(serialized).toMatch(/slug|UPPER|kebab|invalid|validation/i);
  });

  it('🚨 slug duplicato → 409 conflict', async () => {
    await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CUSTOM_NODE_CONFLICT');
  });

  it('🚨 plan free quota=0 → 402 Payment Required', async () => {
    process.env.MEDEA_PLAN_CODE = 'free';
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; meta: { planCode: string } } };
    expect(body.error.code).toBe('CUSTOM_NODE_QUOTA_EXCEEDED');
    expect(body.error.meta.planCode).toBe('free');
  });
});

describe('🚨 GET / (list)', () => {
  it('🚨 list vuota → 200 con items:[]', async () => {
    const res = await buildApp(OWNER).request('/api/v1/custom-nodes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('🚨 dopo create → list contiene 1 item summary', async () => {
    await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const res = await buildApp(OWNER).request('/api/v1/custom-nodes');
    const body = (await res.json()) as { items: { slug: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.slug).toBe('route-test');
  });

  it('🚨 query filter status → applicato', async () => {
    await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const res = await buildApp(OWNER).request('/api/v1/custom-nodes?status=draft');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });
});

describe('🚨 GET /:id + PUT /:id + DELETE /:id', () => {
  it('🚨 get not-found → 404 con error shape', async () => {
    const res = await buildApp(OWNER).request(
      '/api/v1/custom-nodes/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('🚨 put source touch → 200 + semver bumped', async () => {
    const created = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const createdBody = (await created.json()) as { id: string };
    const put = await putJson(buildApp(OWNER), `/api/v1/custom-nodes/${createdBody.id}`, {
      sourceExecutor: 'export const executor = async () => ({ output: { v: 2 } });',
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { semver: string };
    expect(putBody.semver).toBe('0.1.1');
  });

  it('🚨 delete archive → 200 + slug riusabile', async () => {
    const c1 = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const c1Body = (await c1.json()) as { id: string };
    const del = await buildApp(OWNER).request(`/api/v1/custom-nodes/${c1Body.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const c2 = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    expect(c2.status).toBe(201);
  });
});

describe('🚨 GET /:id/versions + POST /:id/rollback', () => {
  it('🚨 versions iniziali = 1 + dopo update = 2', async () => {
    const c = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const cBody = (await c.json()) as { id: string };
    const v1 = await buildApp(OWNER).request(`/api/v1/custom-nodes/${cBody.id}/versions`);
    expect(((await v1.json()) as { versions: unknown[] }).versions).toHaveLength(1);
    await putJson(buildApp(OWNER), `/api/v1/custom-nodes/${cBody.id}`, {
      sourceExecutor: 'export const executor = async () => ({});',
    });
    const v2 = await buildApp(OWNER).request(`/api/v1/custom-nodes/${cBody.id}/versions`);
    expect(((await v2.json()) as { versions: unknown[] }).versions).toHaveLength(2);
  });

  it('🚨 rollback semver inesistente → 404', async () => {
    const c = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const cBody = (await c.json()) as { id: string };
    const res = await postJson(buildApp(OWNER), `/api/v1/custom-nodes/${cBody.id}/rollback`, {
      semverTarget: '99.0.0',
    });
    expect(res.status).toBe(404);
  });
});

describe('🚨 POST /:id/compile (esbuild + persist)', () => {
  it('🚨 owner + sources clean → 200 + warnings []', async () => {
    const c = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const cBody = (await c.json()) as { id: string };
    const res = await postJson(buildApp(OWNER), `/api/v1/custom-nodes/${cBody.id}/compile`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { compiled: number; warnings: unknown[] };
    expect(body.compiled).toBeGreaterThan(50);
    expect(body.warnings).toEqual([]);
  });

  it('🚨 sources con eval → 422 SecurityViolation', async () => {
    const c = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const cBody = (await c.json()) as { id: string };
    const res = await postJson(buildApp(OWNER), `/api/v1/custom-nodes/${cBody.id}/compile`, {
      sources: {
        executor: 'eval("hack")',
        definition: 'export const definition = {};',
        schema: 'export const schema = {};',
      },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CUSTOM_NODE_SECURITY_VIOLATION');
  });

  it('🚨 id not-found → 404', async () => {
    const res = await postJson(
      buildApp(OWNER),
      '/api/v1/custom-nodes/00000000-0000-0000-0000-000000000000/compile',
      {},
    );
    expect(res.status).toBe(404);
  });
});

describe('🚨 RBAC enforcement su tutti i write endpoints', () => {
  it('🚨 editor → 403 su POST', async () => {
    const res = await postJson(buildApp(EDITOR), '/api/v1/custom-nodes', validBody);
    expect(res.status).toBe(403);
  });

  it('🚨 editor → 403 su PUT (anche se id esiste)', async () => {
    const c = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const cBody = (await c.json()) as { id: string };
    const res = await putJson(buildApp(EDITOR), `/api/v1/custom-nodes/${cBody.id}`, {
      displayName: 'X',
    });
    expect(res.status).toBe(403);
  });

  it('🚨 editor → 403 su DELETE', async () => {
    const c = await postJson(buildApp(OWNER), '/api/v1/custom-nodes', validBody);
    const cBody = (await c.json()) as { id: string };
    const res = await buildApp(EDITOR).request(`/api/v1/custom-nodes/${cBody.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('🚨 viewer → 403 su GET (anche read è owner-only per privacy)', async () => {
    const viewer: TestAuth = { userId: 'v', role: 'viewer', email: 'v@x.it', tenantId: 'ws-test' };
    const res = await buildApp(viewer).request('/api/v1/custom-nodes');
    expect(res.status).toBe(403);
  });
});

describe('🚨 POST /import/openapi (genera custom node da OpenAPI)', () => {
  const SPEC = {
    openapi: '3.0.0',
    info: { title: 'Tiny API', version: '1.0.0' },
    servers: [{ url: 'https://tiny.test' }],
    components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } },
    paths: { '/ping': { get: { operationId: 'ping', summary: 'Ping', tags: ['Health'] } } },
  };

  it('🚨 owner + spec valido → 201 draft persistito + stats + warnings', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', {
      spec: SPEC,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      node: { slug: string; status: string };
      stats: { operations: number };
      warnings: string[];
    };
    expect(body.node.slug).toBe('tiny-api');
    expect(body.node.status).toBe('draft');
    expect(body.stats.operations).toBe(1);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('🚨 il draft creato è recuperabile via GET e ha defId custom_<slug>', async () => {
    const created = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', {
      spec: SPEC,
    });
    const { node } = (await created.json()) as { node: { id: string } };
    const got = await buildApp(OWNER).request(`/api/v1/custom-nodes/${node.id}`);
    expect(got.status).toBe(200);
    const full = (await got.json()) as { sourceDefinition: string };
    expect(full.sourceDefinition).toContain('"defId": "custom_tiny-api"');
  });

  it('🚨 slug override rispettato', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', {
      spec: SPEC,
      slug: 'my-tiny',
    });
    const body = (await res.json()) as { node: { slug: string } };
    expect(body.node.slug).toBe('my-tiny');
  });

  it('🚨 swagger 2.0 → 400 OPENAPI_PARSE_ERROR (non 500)', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', {
      spec: { swagger: '2.0', paths: {} },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('OPENAPI_PARSE_ERROR');
  });

  it('🚨 body senza spec → 400 validation', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', {
      slug: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 editor (non owner) → 403', async () => {
    const res = await postJson(buildApp(EDITOR), '/api/v1/custom-nodes/import/openapi', {
      spec: SPEC,
    });
    expect(res.status).toBe(403);
  });

  it('🚨 import dello stesso slug due volte → 409 conflict', async () => {
    await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', { spec: SPEC });
    const dup = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/openapi', {
      spec: SPEC,
    });
    expect(dup.status).toBe(409);
  });
});

describe('🚨 POST /import/postman (genera custom node da Postman Collection)', () => {
  const COLLECTION = {
    info: { name: 'Tiny Postman', schema: 'v2.1.0' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] },
    item: [
      { name: 'Ping', request: { method: 'GET', url: { host: ['tiny', 'test'], path: ['ping'] } } },
    ],
  };

  it('🚨 owner + collection valida → 201 draft + stats + warnings', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/postman', {
      collection: COLLECTION,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      node: { slug: string; status: string };
      stats: { operations: number };
      warnings: string[];
    };
    expect(body.node.slug).toBe('tiny-postman');
    expect(body.node.status).toBe('draft');
    expect(body.stats.operations).toBe(1);
  });

  it('🚨 collection senza info.name → 400 POSTMAN_PARSE_ERROR', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/postman', {
      collection: { item: [] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('POSTMAN_PARSE_ERROR');
  });

  it('🚨 body senza collection → 400 validation', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/custom-nodes/import/postman', {
      slug: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('🚨 editor (non owner) → 403', async () => {
    const res = await postJson(buildApp(EDITOR), '/api/v1/custom-nodes/import/postman', {
      collection: COLLECTION,
    });
    expect(res.status).toBe(403);
  });
});
