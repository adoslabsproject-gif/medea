/**
 * E2E CATENA COMPLETA custom node — il test che mancava (incidente owner
 * 2026-06-12: la create era rotta dalla nascita e nessun test percorreva il
 * filo intero; i pezzi erano verdi, la catena no).
 *
 *   create (route REALE, sorgenti kit VERI dell'editor)
 *     → compile (esbuild + security scan reali)
 *     → test-run (sandbox isolated-vm reale)
 *     → publish-private
 *     → runnable per l'engine (loadCustomNodeForRun = palette/run path)
 *
 * + MATRIX: TUTTI i kit dell'editor (BLANK incluso) passano il compile
 *   service vero — uno scheletro che diamo agli utenti e non compila è un
 *   bug di prodotto, non un dettaglio.
 *
 * I sorgenti kit sono importati CROSS-APP dal file dell'editor (import
 * dinamico a path variabile: vitest lo transforma, tsc non lo risolve →
 * niente accoppiamento di build). Se un kit diverge dal compile service,
 * questo test diventa rosso.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import SqliteDatabase from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    };
  },
}));
vi.mock('@/lib/logger.js');

const { createCustomNodesRoutes } = await import('./custom-nodes.js');
const { loadCustomNodeForRun } = await import('@/services/custom-nodes/runtime-loader.js');
const { compileCustomNodeSources } = await import('@/services/custom-nodes/compile.service.js');

// ─── Kit VERI dall'editor (cross-app, path variabile per non legare tsc) ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const kitsPath = join(__dirname, '../../../flowforge-editor/src/views/custom-nodes/starter-kits.ts');
interface KitShape { id: string; serverCategory: string; sources: { executor: string; definition: string; schema: string } }
const kitsModule = (await import(/* @vite-ignore */ kitsPath)) as { STARTER_KITS: readonly KitShape[]; BLANK_KIT: KitShape };
const { STARTER_KITS, BLANK_KIT } = kitsModule;

const OWNER = { userId: 'owner-1', role: 'owner', email: 'o@x.it', tenantId: 'ws-chain' } as const;

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', OWNER as never); return next(); });
  app.route('/api/v1/custom-nodes', createCustomNodesRoutes());
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
  process.env.FLOWFORGE_TENANT_ID = 'ws-chain';
});
afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
  delete process.env.FLOWFORGE_PLAN_CODE;
  delete process.env.FLOWFORGE_TENANT_ID;
});

describe('🚨🚨 E2E catena completa — BLANK_KIT (il percorso "da zero" dell\'incidente)', () => {
  it('create → compile → test-run → publish → runnable per l\'engine', async () => {
    const app = buildApp();

    // 1. CREATE con ESATTAMENTE ciò che la UI invia per il percorso blank.
    const createRes = await postJson(app, '/api/v1/custom-nodes', {
      slug: 'nodo_della_demo',
      displayName: 'Nodo della demo',
      category: BLANK_KIT.serverCategory,
      sourceExecutor: BLANK_KIT.sources.executor,
      sourceDefinition: BLANK_KIT.sources.definition,
      sourceSchema: BLANK_KIT.sources.schema,
    });
    expect(createRes.status, await createRes.clone().text()).toBe(201);
    const node = await createRes.json() as { id: string; status: string };
    expect(node.status).toBe('draft');

    // 2. COMPILE dei sorgenti salvati (esbuild + security scan REALI).
    const compileRes = await postJson(app, `/api/v1/custom-nodes/${node.id}/compile`, {});
    expect(compileRes.status, await compileRes.clone().text()).toBe(200);

    // 3. TEST-RUN nel sandbox isolated-vm REALE: l'executor blank è un
    //    passthrough che echo-a input + config.nota.
    const runRes = await postJson(app, `/api/v1/custom-nodes/${node.id}/test-run`, {
      input: { ordine: 42 },
      config: { nota: 'demo' },
    });
    expect(runRes.status, await runRes.clone().text()).toBe(200);
    const run = await runRes.json() as { success: boolean; output: { ok: boolean; ricevuto: unknown; nota: string } | null; error: string | null };
    expect(run.success, `test-run fallito: ${run.error ?? '?'}`).toBe(true);
    expect(run.output?.ok).toBe(true);
    expect(run.output?.ricevuto).toEqual({ ordine: 42 });
    expect(run.output?.nota).toBe('demo');

    // 4. PUBLISH privato → palette del workspace.
    const pubRes = await postJson(app, `/api/v1/custom-nodes/${node.id}/publish-private`, {});
    expect(pubRes.status, await pubRes.clone().text()).toBe(200);

    // 5. RUNNABLE per l'engine: lo stesso path che palette/workflow usano.
    const entry = loadCustomNodeForRun('custom_nodo_della_demo', 'ws-chain');
    expect(entry, 'nodo pubblicato NON caricabile dall\'engine').not.toBeNull();
    expect(entry!.compiledExecutor.length).toBeGreaterThan(100);
  });

  it('il nodo NON pubblicato non è runnable (draft ≠ palette)', async () => {
    const app = buildApp();
    const createRes = await postJson(app, '/api/v1/custom-nodes', {
      slug: 'solo_draft',
      displayName: 'Solo draft',
      category: BLANK_KIT.serverCategory,
      sourceExecutor: BLANK_KIT.sources.executor,
      sourceDefinition: BLANK_KIT.sources.definition,
      sourceSchema: BLANK_KIT.sources.schema,
    });
    expect(createRes.status).toBe(201);
    expect(loadCustomNodeForRun('custom_solo_draft', 'ws-chain')).toBeNull();
  });
});

describe('🚨 MATRIX — TUTTI i kit dell\'editor compilano nel compile service VERO', () => {
  const allKits = [BLANK_KIT, ...STARTER_KITS];
  it.each(allKits.map((k) => [k.id, k] as const))('kit "%s" → compile ok', async (_id, kit) => {
    const result = await compileCustomNodeSources(kit.sources);
    expect(result.compiledExecutor.length).toBeGreaterThan(100);
    const errors = result.warnings.filter((w) => w.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 1)).toEqual([]);
  });
});
