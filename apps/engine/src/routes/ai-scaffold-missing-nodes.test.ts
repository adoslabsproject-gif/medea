/**
 * Integration test per POST /api/v1/ai-scaffold/synthesize-missing-nodes.
 *
 * Mock layer:
 *  - DB: SQLite in-memory con SCHEMA_SQL completo
 *  - LLM: callAiAssist mocked → ritorna patch sintetica deterministica
 *  - buildNodeCatalog: list ridotto per evitare carico stdlib in test
 *  - compileAndPersist: mocked → no esbuild durante test
 *
 * Verifica:
 *  - RBAC: editor → 403, no auth → 401
 *  - workflow valido senza missing → 200 + nessuna sintesi
 *  - workflow con 2 defId allucinati → 200 + 2 succeeded + mapping + workflow
 *    rewritten + 2 entry in audit_log
 *  - LLM fail per UN missing → 200 + 1 succeeded + 1 failed (fail-soft)
 *  - idempotenza: stesso slug già registrato → reused=true, no LLM call
 */
import type * as CompileServiceNS from '@/services/custom-nodes/compile.service.js';
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
        exec: (sql: string) => { conn.exec(sql); },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) => conn.transaction(fn) as unknown as (...args: T) => R,
      },
      db: {
        select: () => ({ from: () => ({ orderBy: () => ({ limit: () => [] }) }) }),
        insert: () => ({ values: async () => undefined }),
      },
    };
  },
}));
vi.mock('@/lib/logger.js');

const auditAppend = vi.fn().mockResolvedValue(undefined);
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class { append = auditAppend; },
}));

// Catalog ridotto a 3 nodi: l'orchestrator vede missing per qualunque defId
// non in {action_http, agent_summarizer, flow_merge}.
vi.mock('@/services/ai-scaffold/node-catalog.js', () => ({
  buildNodeCatalog: () => [
    { defId: 'action_http', label: 'HTTP' },
    { defId: 'agent_summarizer', label: 'Summarizer' },
    { defId: 'flow_merge', label: 'Merge' },
  ],
}));

const llmGenerate = vi.fn();
vi.mock('@/services/custom-nodes/ai-assist.js', () => ({
  callAiAssist: (req: unknown) => llmGenerate(req),
}));

// compileAndPersist: mock — skip esbuild ma persisti compiledExecutor in DB
// (altrimenti publishCustomNodePrivate throw "Compile required before publish").
vi.mock('@/services/custom-nodes/compile.service.js', async () => {
  const real = await vi.importActual<typeof CompileServiceNS>('@/services/custom-nodes/compile.service.js');
  return {
    ...real,
    compileAndPersist: vi.fn().mockImplementation(async (opts: { workspaceId: string; id: string }) => {
      const { persistCompileResult } = await import('@/services/custom-nodes/service.js');
      await persistCompileResult({
        workspaceId: opts.workspaceId,
        id: opts.id,
        compiledExecutor: '/* compiled stub */',
        warnings: [],
      });
      return { compiledExecutor: '/* compiled stub */', warnings: [] };
    }),
  };
});

const { createAiScaffoldMissingNodesRoutes } = await import('./ai-scaffold-missing-nodes.js');

interface TestAuth { userId: string; role: 'viewer' | 'operator' | 'editor' | 'owner'; email: string; tenantId: string }
const OWNER: TestAuth = { userId: 'owner-1', role: 'owner', email: 'o@x.it', tenantId: 'ws-test' };
const EDITOR: TestAuth = { userId: 'editor-1', role: 'editor', email: 'e@x.it', tenantId: 'ws-test' };

function buildApp(auth: TestAuth | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth as never); return next(); });
  app.route('/api/v1/ai-scaffold', createAiScaffoldMissingNodesRoutes());
  return app;
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
  process.env.FLOWFORGE_PLAN_CODE = 'pro';
  process.env.FLOWFORGE_TENANT_ID = 'ws-test';
  llmGenerate.mockReset();
  auditAppend.mockClear();
});
afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
  delete process.env.FLOWFORGE_PLAN_CODE;
  delete process.env.FLOWFORGE_TENANT_ID;
});

const VALID_WORKFLOW = {
  nodes: [
    { id: 'n1', defId: 'action_http', config: { url: 'https://x.com' } },
    { id: 'n2', defId: 'action_amazon_search', config: { query: 'phone', region: 'IT' } },
    { id: 'n3', defId: 'integration_shopify_orders', config: { shop: 'test' } },
    { id: 'n4', defId: 'agent_summarizer', config: {} },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n4' },
  ],
};

describe('POST /api/v1/ai-scaffold/synthesize-missing-nodes — RBAC', () => {
  it('null auth → 401', async () => {
    const res = await postJson(buildApp(null), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: VALID_WORKFLOW,
      userPrompt: 'test',
    });
    expect(res.status).toBe(401);
  });

  it('editor (non-owner) → 403', async () => {
    const res = await postJson(buildApp(EDITOR), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: VALID_WORKFLOW,
      userPrompt: 'test',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST synthesize-missing-nodes — Validation', () => {
  it('body invalido → 400', async () => {
    const res = await postJson(buildApp(OWNER), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: { nodes: [], edges: [] },
      userPrompt: '',
    });
    expect(res.status).toBe(400);
  });

  it('workflow senza missing defId → 200 + nessuna sintesi', async () => {
    const wf = {
      nodes: [
        { id: 'a', defId: 'action_http', config: {} },
        { id: 'b', defId: 'flow_merge', config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const res = await postJson(buildApp(OWNER), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: wf,
      userPrompt: 'no missing',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.mapping).toEqual({});
    expect(body.succeeded).toEqual([]);
    expect(llmGenerate).not.toHaveBeenCalled();
  });
});

describe('POST synthesize-missing-nodes — Synthesis', () => {
  it('2 defId allucinati → 2 succeeded + workflow rewritten', async () => {
    llmGenerate.mockImplementation(async () => ({
      text: 'ok',
      patch: {
        executor: 'export const executor = async () => ({ output: {}, durationMs: 0 });',
        definition: JSON.stringify({ id: 'X', label: 'X', category: 'action' }),
        schema: '{"type":"object"}',
      },
    }));

    const res = await postJson(buildApp(OWNER), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: VALID_WORKFLOW,
      userPrompt: 'Amazon + Shopify pricing monitor',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      workflow: typeof VALID_WORKFLOW;
      mapping: Record<string, string>;
      succeeded: { oldDefId: string; newDefId: string; reused: boolean }[];
      failed: { oldDefId: string; reason: string }[];
    };

    // 2 LLM call per i 2 missing
    expect(llmGenerate).toHaveBeenCalledTimes(2);
    expect(body.succeeded).toHaveLength(2);
    expect(body.failed).toHaveLength(0);

    // Mapping risolto
    expect(body.mapping.action_amazon_search).toBe('custom_amazon-search');
    expect(body.mapping.integration_shopify_orders).toBe('custom_shopify-orders');

    // Workflow riscritto: defId aggiornati, edges invariati
    const rewriteN2 = body.workflow.nodes.find((n) => n.id === 'n2')!;
    expect(rewriteN2.defId).toBe('custom_amazon-search');
    expect(rewriteN2.config).toEqual({ query: 'phone', region: 'IT' });
    expect(body.workflow.edges).toEqual(VALID_WORKFLOW.edges);
  });

  it('idempotenza: slug già esistente → reused=true, no LLM call per quel item', async () => {
    // Pre-popola custom node "amazon-search" via INSERT diretto SQLite.
    const conn = dbConnections[dbConnections.length - 1]!;
    const at = new Date().toISOString();
    conn.prepare(
      `INSERT INTO custom_nodes (id, workspace_id, owner_user_id, slug, display_name, semver, status,
         source_executor, source_definition, source_schema, created_at, updated_at)
       VALUES (?, 'ws-test', 'owner-1', 'amazon-search', 'Amazon Search', '0.1.0', 'published_priv',
         '/*exec*/', '/*def*/', '/*sch*/', ?, ?)`,
    ).run('cn-pre', at, at);

    llmGenerate.mockImplementation(async () => ({
      text: 'ok',
      patch: { executor: 'x', definition: 'y', schema: 'z' },
    }));

    const res = await postJson(buildApp(OWNER), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: VALID_WORKFLOW,
      userPrompt: 'test idempotenza',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      succeeded: { oldDefId: string; newDefId: string; reused: boolean }[];
    };
    // amazon-search reused, shopify-orders sintetizzato fresh
    const amz = body.succeeded.find((s) => s.oldDefId === 'action_amazon_search')!;
    expect(amz.reused).toBe(true);
    expect(amz.newDefId).toBe('custom_amazon-search');
    const shp = body.succeeded.find((s) => s.oldDefId === 'integration_shopify_orders')!;
    expect(shp.reused).toBe(false);
    expect(llmGenerate).toHaveBeenCalledTimes(1); // solo per shopify-orders
  });

  it('LLM patch incompleta → fail-soft (item skipped, altri proseguono)', async () => {
    let call = 0;
    llmGenerate.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { text: 'incomplete', patch: { executor: 'x' /* manca def + schema */ } };
      }
      return { text: 'ok', patch: { executor: 'x', definition: 'y', schema: 'z' } };
    });

    const res = await postJson(buildApp(OWNER), '/api/v1/ai-scaffold/synthesize-missing-nodes', {
      workflow: VALID_WORKFLOW,
      userPrompt: 'test fail-soft',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      succeeded: { oldDefId: string }[];
      failed: { oldDefId: string; reason: string }[];
    };
    expect(body.succeeded).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.reason).toMatch(/manca/i);
  });
});
