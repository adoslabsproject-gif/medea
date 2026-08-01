/**
 * Tests per `routes/janitor.ts` — N19 audit (anti SQL injection via DSL).
 *
 * Pre-fix bug:
 *   POST /dsl-rules → NESSUN role gate → any authenticated user (viewer +)
 *   could create a DSL rule whose detectSql bypasses classifyStatement
 *   via multi-statement or modifying CTE → adapter executeRaw runs DROP.
 *
 * Fix:
 *   requireRole('owner') gate on POST, PATCH, DELETE /dsl-rules.
 *   List + run remain open to lower roles (operator/editor) — only
 *   write paths gated.
 *
 * Strategy: source inspection. Spinning up a real Hono app with auth
 * middleware + zod validator + janitor runtime is heavy here; the
 * regex assertion is enough to lock the gate in place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(join(__dirname, 'janitor.ts'), 'utf-8');

describe('N19 — routes/janitor.ts: dsl-rules mutation routes gated by requireRole owner', () => {
  it('imports requireRole from middleware/rbac', () => {
    expect(routeSource).toMatch(/import\s*\{\s*requireRole\s*\}\s*from\s*['"]@\/middleware\/rbac/);
  });

  it('POST /dsl-rules has requireRole("owner") BEFORE the validator', () => {
    expect(routeSource).toMatch(
      /app\.post\(\s*['"]\/dsl-rules['"]\s*,\s*requireRole\(['"]owner['"]\)\s*,\s*zValidator/,
    );
  });

  it('PATCH /dsl-rules/:id has requireRole("owner") BEFORE the validator', () => {
    expect(routeSource).toMatch(
      /app\.patch\(\s*['"]\/dsl-rules\/:id['"]\s*,\s*requireRole\(['"]owner['"]\)\s*,\s*zValidator/,
    );
  });

  it('DELETE /dsl-rules/:id has requireRole("owner")', () => {
    expect(routeSource).toMatch(
      /app\.delete\(\s*['"]\/dsl-rules\/:id['"]\s*,\s*requireRole\(['"]owner['"]\)/,
    );
  });

  it('REGRESSION: GET /dsl-rules NOT gated (lower roles can still list)', () => {
    // List remains open to viewer+ — only mutations require owner.
    expect(routeSource).toMatch(
      /app\.get\(\s*['"]\/dsl-rules['"]\s*,\s*async/,
    );
  });

  it('REGRESSION: rule run + cycle still ungated (operator/editor can trigger ad-hoc runs)', () => {
    // POST /rules/:ruleId/run e POST /cycle/run sono parte del workflow editor;
    // restano accessibili ai role inferiori per design.
    expect(routeSource).toMatch(/app\.post\(\s*['"]\/cycle\/run['"]\s*,/);
    expect(routeSource).not.toMatch(/app\.post\(\s*['"]\/cycle\/run['"]\s*,\s*requireRole/);
  });

  it('Tre invocazioni di requireRole("owner") in totale (POST + PATCH + DELETE)', () => {
    // Conteggio diretto su tutto il file — il pattern resta semplice e robusto.
    const matches = routeSource.match(/requireRole\(['"]owner['"]\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe('N19 — runDslDetect passes readOnly:true to executeRaw', () => {
  const usecaseSource = readFileSync(
    join(__dirname, '..', 'services', 'janitor', 'application', 'execute-rule.usecase.ts'),
    'utf-8',
  );

  it('runDslDetect chiama executeRaw con readOnly: true', () => {
    expect(usecaseSource).toMatch(/executeRaw\(\s*sql\s*,\s*\{[^}]*readOnly:\s*true/);
  });

  it('rowLimit ancora presente (no regressione SELECT cap)', () => {
    expect(usecaseSource).toMatch(/rowLimit:\s*ctx\.maxRows[^}]*readOnly:\s*true|readOnly:\s*true[^}]*rowLimit:\s*ctx\.maxRows/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Bug-bounty FULL-REQUEST-PATH (audit coverage 2026-06-12: la route era a
// ZERO righe eseguite — i guard N19 sopra sono source-inspection).
//
// NIENTE mock del runtime: VERO createJanitorRuntime (factory + adapter
// SQLite + use case + registry builtin) sul DB per-worker migrato con lo
// schema di produzione — la regola anti-greensmoke nata dalle 2 regressioni
// della dashboard ("riga coperta ≠ scope giusto"). L'unica cosa simulata è
// l'authMiddleware a monte (set di c.var.auth), che è il suo contratto.
// ════════════════════════════════════════════════════════════════════
import { describe as describeE2E, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { DbStudioService } from '@/services/db-studio.service.js';
import { createJanitorRuntime, type JanitorRuntime } from '@/services/janitor/index.js';
import { createJanitorRoutes } from './janitor.js';
import type { AuthContext } from '@/middleware/auth.js';

const T_A = `test-jan-${Date.now().toString(36)}-a`;
const T_B = `test-jan-${Date.now().toString(36)}-b`;

/** Auth corrente, mutabile per-test (il middleware la legge a ogni richiesta). */
let authCtx: AuthContext | null = null;
const asUser = (tenantId: string, role: AuthContext['role']): void => {
  authCtx = { userId: `u-${role}`, tenantId, email: `${role}@test.it`, role };
};

let app: Hono;
let runtime: JanitorRuntime;
/** id dei database DbStudio REALI creati per i tenant di test (il ref li referenzia). */
const dbIds = new Map<string, string>();

beforeAll(() => {
  runMigrations(); // schema REALE di produzione sul DB per-worker
  const dbStudio = new DbStudioService();
  // Il create DSL valida che il dataSourceRef risolva a un DB ESISTENTE
  // (comportamento pinnato sotto): creiamo un DB DbStudio vero per tenant.
  for (const t of [T_A, T_B]) {
    const db = dbStudio.create({
      tenantId: t, name: 'main',
      connection: { engine: 'sqlite', embedded: true },
      tables: [], relations: [],
    } as never);
    dbIds.set(t, db.id);
  }
  runtime = createJanitorRuntime({
    dbStudio,
  });
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', authCtx); await next(); });
  app.route('/api/v1/janitor', createJanitorRoutes(runtime));
});

afterAll(() => {
  const sqlite = getDatabase().sqlite as unknown as { prepare: (s: string) => { run: (...p: unknown[]) => unknown } };
  for (const table of ['janitor_dsl_rules', 'janitor_rule_configs', 'janitor_run_log', 'db_studio_databases']) {
    sqlite.prepare(`DELETE FROM ${table} WHERE tenant_id LIKE 'test-jan-%'`).run();
  }
});

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(app.request(`/api/v1/janitor${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

/** Ref canonico per-tenant (forma `tenant:<tenantId>:<dbId>` del dominio). */
const refFor = (tenantId: string): string => `tenant:${tenantId}:${dbIds.get(tenantId) ?? 'main'}`;
const dslFor = (tenantId: string): Record<string, unknown> => ({
  title: 'Orders senza lead',
  dataSourceRef: refFor(tenantId),
  targetTable: 'b2b_orders',
  targetPkColumn: 'id',
  detectSql: 'SELECT id FROM b2b_orders WHERE lead_id IS NULL',
});

describeE2E('sicurezza — auth e RBAC (full request path)', () => {
  it('senza auth → MAI 200 (getTenantId fail-loud, niente fallback silenzioso a default)', async () => {
    authCtx = null;
    for (const [method, path] of [['GET', '/rules'], ['GET', '/dsl-rules'], ['GET', '/locks']] as const) {
      const res = await req(method, path);
      expect(res.status, `${method} ${path} senza auth`).not.toBe(200);
    }
  });

  it('mutate DSL owner-only: editor→403, operator→403, owner→201 (la rule incapsula SQL arbitrario)', async () => {
    asUser(T_A, 'editor');
    expect((await req('POST', '/dsl-rules', dslFor(T_A))).status).toBe(403);
    asUser(T_A, 'operator');
    expect((await req('POST', '/dsl-rules', dslFor(T_A))).status).toBe(403);
    asUser(T_A, 'owner');
    expect((await req('POST', '/dsl-rules', { ...dslFor(T_A), title: 'rbac-owner-ok' })).status).toBe(201);
  });

  it("ANTI-REGRESSIONE fail-closed 28096ac6: ruolo IGNOTO ('admin' legacy) → 403, NON pass-through", async () => {
    authCtx = { userId: 'u-x', tenantId: T_A, email: 'x@test.it', role: 'admin' as AuthContext['role'] };
    expect((await req('POST', '/dsl-rules', dslFor(T_A))).status).toBe(403);
    expect((await req('DELETE', '/dsl-rules/qualunque')).status).toBe(403);
  });

  it('x-tenant-id da ruolo NON superadmin → IGNORATO (spoof-proof): vede solo il SUO tenant', async () => {
    asUser(T_A, 'owner');
    await req('POST', '/dsl-rules', { ...dslFor(T_A), title: 'spoof-target-A' });
    asUser(T_B, 'owner');
    const res = await req('GET', '/dsl-rules', undefined, { 'x-tenant-id': T_A });
    const data = await res.json() as { rules: { title: string }[] };
    expect(data.rules.some((r) => r.title === 'spoof-target-A')).toBe(false);
  });

  it('superadmin + x-tenant-id → override LEGITTIMO (admin dashboard cross-tenant)', async () => {
    asUser('tenant-admin', 'superadmin');
    const res = await req('GET', '/dsl-rules', undefined, { 'x-tenant-id': T_A });
    const data = await res.json() as { rules: { title: string }[] };
    expect(data.rules.some((r) => r.title === 'spoof-target-A')).toBe(true);
  });
});

describeE2E('isolamento tenant sulle DSL rules (SQLite reale)', () => {
  it('la rule di A non è visibile, modificabile né cancellabile da B — e resta INTATTA', async () => {
    asUser(T_A, 'owner');
    const created = await (await req('POST', '/dsl-rules', { ...dslFor(T_A), title: 'isolata-di-A' })).json() as { rule: { id: string } };
    const ruleId = created.rule.id;

    asUser(T_B, 'owner');
    const list = await (await req('GET', '/dsl-rules')).json() as { rules: { id: string }[] };
    expect(list.rules.some((r) => r.id === ruleId)).toBe(false);
    expect((await req('PATCH', `/dsl-rules/${ruleId}`, { title: 'hijack' })).status).toBe(400);
    expect((await req('DELETE', `/dsl-rules/${ruleId}`)).status).toBe(400);

    asUser(T_A, 'owner');
    const listA = await (await req('GET', '/dsl-rules')).json() as { rules: { id: string; title: string }[] };
    expect(listA.rules.find((r) => r.id === ruleId)?.title).toBe('isolata-di-A');
  });
});

describeE2E('contratto ingest↔retrieval su DB reale', () => {
  it('POST /dsl-rules scrive janitor_dsl_rules e GET la rilegge con TUTTI i campi round-trip', async () => {
    asUser(T_A, 'owner');
    const payload: Record<string, unknown> & { detectSql?: unknown; repairSql?: unknown } = {
      ...dslFor(T_A),
      title: 'roundtrip-completo',
      description: 'desc',
      repairSql: 'UPDATE b2b_orders SET status = :nuovo WHERE id = :pk',
      placeholders: { soglia: 5, attivo: true, nome: 'x' },
      tags: ['orders', 'critical'],
      defaultSeverity: 'critical' as const,
    };
    const created = await (await req('POST', '/dsl-rules', payload)).json() as { rule: Record<string, unknown> };
    asUser(T_A, 'viewer'); // la LIST è aperta ai ruoli bassi (debugging quotidiano)
    const list = await (await req('GET', '/dsl-rules')).json() as { rules: Record<string, unknown>[] };
    const found = list.rules.find((r) => r.id === created.rule.id);
    expect(found).toMatchObject({
      title: 'roundtrip-completo',
      detectSql: payload.detectSql,
      repairSql: payload.repairSql,
      placeholders: payload.placeholders,
      tags: payload.tags,
      defaultSeverity: 'critical',
    });
  });

  it('PATCH /rules/:builtin persiste la config e GET riflette isPersistedConfig; reset torna ai default', async () => {
    asUser(T_A, 'owner');
    const all = await (await req('GET', '/rules')).json() as { rules: { rule: { id: string }; isPersistedConfig: boolean }[] };
    expect(all.rules.length).toBeGreaterThan(0); // registry builtin caricato dal factory
    const ruleId = all.rules[0]!.rule.id;
    expect(all.rules[0]!.isPersistedConfig).toBe(false); // tenant vergine: default

    expect((await req('PATCH', `/rules/${ruleId}`, { enabled: false, maxRowsPerRun: 7 })).status).toBe(200);
    const detail = await (await req('GET', `/rules/${ruleId}`)).json() as { config: { enabled: boolean; maxRowsPerRun: number }; isPersistedConfig: boolean };
    expect(detail.isPersistedConfig).toBe(true);
    expect(detail.config.enabled).toBe(false);
    expect(detail.config.maxRowsPerRun).toBe(7);

    expect((await req('POST', `/rules/${ruleId}/reset`)).status).toBe(200);
    const after = await (await req('GET', `/rules/${ruleId}`)).json() as { isPersistedConfig: boolean };
    expect(after.isPersistedConfig).toBe(false);
  });

  it('GET /rules/:id inesistente → 404; POST /rules/:id/run inesistente → 404', async () => {
    asUser(T_A, 'owner');
    expect((await req('GET', '/rules/non-esiste')).status).toBe(404);
    expect((await req('POST', '/rules/non-esiste/run', { dryRun: true })).status).toBe(404);
  });

  it('GET /history e /history/trend su tenant vergine → shape contrattuale vuota (no 500)', async () => {
    asUser(T_B, 'viewer');
    const h = await (await req('GET', '/history')).json() as { reports: unknown[] };
    expect(Array.isArray(h.reports)).toBe(true);
    const t = await (await req('GET', '/history/trend?days=7')).json() as { buckets: unknown[] };
    expect(Array.isArray(t.buckets)).toBe(true);
  });
});

describeE2E('guardrail distruttivi e validazioni', () => {
  it("purge quarantena: confirmationToken DEVE essere il literal 'DELETE-PERMANENT' (typo/assente → 400)", async () => {
    asUser(T_A, 'owner');
    expect((await req('DELETE', '/quarantine/1', { dataSourceRef: refFor(T_A) })).status).toBe(400);
    expect((await req('DELETE', '/quarantine/1', { confirmationToken: 'delete-permanent', dataSourceRef: refFor(T_A) })).status).toBe(400);
    expect((await req('DELETE', '/quarantine/1', { confirmationToken: 'DELETE', dataSourceRef: refFor(T_A) })).status).toBe(400);
  });

  it('quarantine id NON numerico → 400 sia su restore che su purge (mai NaN nel gateway)', async () => {
    asUser(T_A, 'owner');
    expect((await req('DELETE', '/quarantine/abc', { confirmationToken: 'DELETE-PERMANENT', dataSourceRef: refFor(T_A) })).status).toBe(400);
    expect((await req('POST', '/quarantine/abc/restore', { dataSourceRef: refFor(T_A) })).status).toBe(400);
  });

  it('restore: body non-JSON → 400; dataSourceRef mancante/invalido → 400', async () => {
    asUser(T_A, 'owner');
    const noBody = await app.request('/api/v1/janitor/quarantine/1/restore', { method: 'POST' });
    expect(noBody.status).toBe(400);
    expect((await req('POST', '/quarantine/1/restore', {})).status).toBe(400);
    expect((await req('POST', '/quarantine/1/restore', { dataSourceRef: 'garbage///' })).status).toBe(400);
  });

  it("SICUREZZA N19 behaviorale: repairSql DELETE/INSERT/DDL → 400 (solo UPDATE ammesso — il repair non può distruggere)", async () => {
    asUser(T_A, 'owner');
    for (const sql of ['DELETE FROM b2b_orders WHERE id = :pk', 'INSERT INTO b2b_orders (id) VALUES (:pk)', 'DROP TABLE b2b_orders']) {
      const res = await req('POST', '/dsl-rules', { ...dslFor(T_A), title: `repair-${sql.slice(0, 6)}`, repairSql: sql });
      expect(res.status, `repairSql "${sql.slice(0, 20)}…" deve essere rigettato`).toBe(400);
    }
  });

  it('create DSL: detectSql mancante → 400 (zValidator); dataSourceRef non valido → 400 (isDataSourceRef)', async () => {
    asUser(T_A, 'owner');
    const { detectSql: _omit, ...senzaDetect } = dslFor(T_A);
    expect((await req('POST', '/dsl-rules', senzaDetect)).status).toBe(400);
    expect((await req('POST', '/dsl-rules', { ...dslFor(T_A), dataSourceRef: 'non-un-ref' })).status).toBe(400);
  });

  it('PATCH rule config: dataSourceRef invalido → 400, schedule oltre 80 char → 400', async () => {
    asUser(T_A, 'owner');
    const all = await (await req('GET', '/rules')).json() as { rules: { rule: { id: string } }[] };
    const ruleId = all.rules[0]!.rule.id;
    expect((await req('PATCH', `/rules/${ruleId}`, { dataSourceRef: 'garbage///' })).status).toBe(400);
    expect((await req('PATCH', `/rules/${ruleId}`, { schedule: 'x'.repeat(81) })).status).toBe(400);
  });

  it('GET /quarantine: limit oltre 500 → 400 (cap anti-dump); filtri validi → shape {records:[]}', async () => {
    asUser(T_A, 'owner');
    expect((await req('GET', '/quarantine?limit=9999')).status).toBe(400);
    const ok = await (await req('GET', '/quarantine?limit=10&severity=critical')).json() as { records: unknown[] };
    expect(Array.isArray(ok.records)).toBe(true);
  });

  it('GET /datasources → 200 con lista (il selector UI ci si appoggia)', async () => {
    asUser(T_A, 'owner');
    const res = await req('GET', '/datasources');
    expect(res.status).toBe(200);
    const data = await res.json() as { datasources: unknown[] };
    expect(Array.isArray(data.datasources)).toBe(true);
  });
});
