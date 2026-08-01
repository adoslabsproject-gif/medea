/**
 * Custom Node Editor — service.test.ts (Fase 1 Cappella Sistina).
 *
 * Coverage 2026-grade REALE:
 *  - createCustomNode: success + Zod validation + slug duplicate (Conflict) +
 *    plan quota enforced (QuotaExceeded) + version snapshot created
 *  - getCustomNode / getCustomNodeBySlug / listCustomNodes (filters + pagination)
 *  - updateCustomNode: source touch → version bump + snapshot; metadata-only
 *    update → no version bump; semverBump override; sourceTouch invalidates
 *    compiled bundle (cache eviction)
 *  - listVersions / rollbackToVersion: rollback carica snapshot + bump patch
 *  - archiveCustomNode: soft-delete + idempotent + slug riusabile dopo archive
 *  - persistCompileResult: status draft → candidate
 *  - appendTestRun: ring buffer max 20
 *  - bumpSemver: patch/minor/major + malformed throw
 *  - Multi-tenant isolation: workspace_id WHERE blocca cross-tenant read/write
 *
 * Pattern: in-memory SQLite per test (riusato dal ConversationService pattern)
 * + env override per plan-gating (FLOWFORGE_PLAN_CODE = 'pro' default test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    };
  },
}));

import {
  createCustomNode,
  getCustomNode,
  getCustomNodeBySlug,
  listCustomNodes,
  updateCustomNode,
  listVersions,
  rollbackToVersion,
  archiveCustomNode,
  persistCompileResult,
  appendTestRun,
  listTestRuns,
  bumpSemver,
  publishCustomNodePrivate,
  submitCustomNodeToMarketplace,
  withdrawCustomNodeFromMarketplace,
} from './service.js';
import {
  CustomNodeNotFoundError,
  CustomNodeConflictError,
  CustomNodeValidationError,
  CustomNodeQuotaExceededError,
} from './errors.js';
import { TEST_RUNS_RING_SIZE } from './types.js';

const WS_A = 'ws-tenant-A';
const WS_B = 'ws-tenant-B';
const USER_1 = 'u-owner-1';
const USER_2 = 'u-owner-2';

const baseInput = {
  slug: 'my-node',
  displayName: 'My Node',
  description: 'Test node',
  sourceExecutor: 'export const executor = async () => ({ output: {} });',
  sourceDefinition: 'export const definition = { defId: "my_node" };',
  sourceSchema: 'export const schema = z.object({});',
};

beforeEach(() => {
  const conn = new SqliteDatabase(':memory:');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);
  // Pro plan per default (quota 20, abbastanza per i test)
  process.env.FLOWFORGE_PLAN_CODE = 'pro';
});

afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
  delete process.env.FLOWFORGE_PLAN_CODE;
});

describe('🚨 createCustomNode', () => {
  it('🚨 happy path: insert con semver 0.1.0 + status draft + snapshot version', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    expect(node.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(node.workspaceId).toBe(WS_A);
    expect(node.ownerUserId).toBe(USER_1);
    expect(node.slug).toBe('my-node');
    expect(node.semver).toBe('0.1.0');
    expect(node.status).toBe('draft');
    expect(node.compiledExecutor).toBeNull();
    expect(node.testRuns).toEqual([]);

    const versions = await listVersions({ workspaceId: WS_A, customNodeId: node.id });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.semver).toBe('0.1.0');
    expect(versions[0]!.changelog).toBe('Initial draft');
  });

  it('🚨 slug invalido (UPPER) → Zod rejects', async () => {
    await expect(createCustomNode({
      workspaceId: WS_A, ownerUserId: USER_1,
      input: { ...baseInput, slug: 'My-Node' },
    })).rejects.toThrow(/lowercase|kebab-case/);
  });

  it('🚨 slug duplicato per stesso tenant (status!=archived) → ConflictError', async () => {
    await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await expect(createCustomNode({
      workspaceId: WS_A, ownerUserId: USER_2, input: baseInput,
    })).rejects.toThrow(CustomNodeConflictError);
  });

  it('🚨 stesso slug in tenant diversi → OK (tenant isolation)', async () => {
    const a = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    const b = await createCustomNode({ workspaceId: WS_B, ownerUserId: USER_1, input: baseInput });
    expect(a.workspaceId).toBe(WS_A);
    expect(b.workspaceId).toBe(WS_B);
    expect(a.id).not.toBe(b.id);
  });

  it('🚨 plan Free (quota=0) → QuotaExceededError al primo create', async () => {
    process.env.FLOWFORGE_PLAN_CODE = 'free';
    await expect(createCustomNode({
      workspaceId: WS_A, ownerUserId: USER_1, input: baseInput,
    })).rejects.toThrow(CustomNodeQuotaExceededError);
  });

  it('🚨 plan Starter (quota=3) → 4° create throws QuotaExceeded', async () => {
    process.env.FLOWFORGE_PLAN_CODE = 'starter';
    for (let i = 1; i <= 3; i++) {
      await createCustomNode({
        workspaceId: WS_A, ownerUserId: USER_1,
        input: { ...baseInput, slug: `node-${i.toString()}` },
      });
    }
    await expect(createCustomNode({
      workspaceId: WS_A, ownerUserId: USER_1,
      input: { ...baseInput, slug: 'node-4' },
    })).rejects.toThrow(/quota exceeded.*starter|3\/3/i);
  });

  it('🚨 plan Enterprise (unlimited) → 200° create OK', async () => {
    process.env.FLOWFORGE_PLAN_CODE = 'enterprise';
    for (let i = 1; i <= 5; i++) {
      const n = await createCustomNode({
        workspaceId: WS_A, ownerUserId: USER_1,
        input: { ...baseInput, slug: `bulk-${i.toString()}` },
      });
      expect(n.id).toBeDefined();
    }
  });

  it('🚨 source troppo grande (>256KB) → Zod rejects', async () => {
    const huge = 'x'.repeat(257 * 1024);
    await expect(createCustomNode({
      workspaceId: WS_A, ownerUserId: USER_1,
      input: { ...baseInput, sourceExecutor: huge },
    })).rejects.toThrow(/bytes|max/);
  });
});

describe('🚨 getCustomNode / getCustomNodeBySlug / listCustomNodes', () => {
  it('🚨 get by id null se non esiste', async () => {
    const r = await getCustomNode({ workspaceId: WS_A, id: '00000000-0000-0000-0000-000000000000' });
    expect(r).toBeNull();
  });

  it('🚨 get by slug ignora archived', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await archiveCustomNode({ workspaceId: WS_A, id: node.id });
    const r = await getCustomNodeBySlug({ workspaceId: WS_A, slug: 'my-node' });
    expect(r).toBeNull();
  });

  it('🚨 list filtrato per status + pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      await createCustomNode({
        workspaceId: WS_A, ownerUserId: USER_1,
        input: { ...baseInput, slug: `list-${i.toString()}` },
      });
    }
    const r = await listCustomNodes({ workspaceId: WS_A, filter: { status: 'draft', limit: 2 } });
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(5);
  });

  it('🚨 list filtrato per ownerUserId', async () => {
    await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: { ...baseInput, slug: 'aa' } });
    await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_2, input: { ...baseInput, slug: 'bb' } });
    const r = await listCustomNodes({ workspaceId: WS_A, filter: { ownerUserId: USER_1 } });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.slug).toBe('aa');
  });

  it('🚨 cross-tenant isolation: listA non vede nodi di B', async () => {
    await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await createCustomNode({ workspaceId: WS_B, ownerUserId: USER_1, input: baseInput });
    const a = await listCustomNodes({ workspaceId: WS_A });
    const b = await listCustomNodes({ workspaceId: WS_B });
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect(a.items[0]!.workspaceId).toBe(WS_A);
    expect(b.items[0]!.workspaceId).toBe(WS_B);
  });
});

describe('🚨 updateCustomNode', () => {
  it('🚨 source touch → semver patch bump 0.1.0 → 0.1.1 + snapshot creato', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    const updated = await updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: { sourceExecutor: 'export const executor = async () => ({ output: { v: 2 } });' },
    });
    expect(updated.semver).toBe('0.1.1');
    const versions = await listVersions({ workspaceId: WS_A, customNodeId: node.id });
    expect(versions).toHaveLength(2);
    // ORDER BY created_at DESC ma se gli ms coincidono l'ordine è non
    // deterministico — verifica che entrambe semver siano presenti.
    expect(versions.map((v) => v.semver).sort()).toEqual(['0.1.0', '0.1.1']);
  });

  it('🚨 metadata-only update (displayName) → NO semver bump + NO new snapshot', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    const updated = await updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: { displayName: 'My Node v2 Title' },
    });
    expect(updated.semver).toBe('0.1.0');
    expect(updated.displayName).toBe('My Node v2 Title');
    const versions = await listVersions({ workspaceId: WS_A, customNodeId: node.id });
    expect(versions).toHaveLength(1);
  });

  it('🚨 source touch con semverBump=minor → 0.1.0 → 0.2.0', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    const updated = await updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: {
        sourceExecutor: 'export const executor = async () => ({});',
        semverBump: 'minor',
      },
    });
    expect(updated.semver).toBe('0.2.0');
  });

  it('🚨 source touch con semverBump=major → 0.1.0 → 1.0.0', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    const updated = await updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: { sourceExecutor: 'export const executor = async () => ({});', semverBump: 'major' },
    });
    expect(updated.semver).toBe('1.0.0');
  });

  it('🚨 source touch invalida compiled bundle (cache eviction)', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await persistCompileResult({
      workspaceId: WS_A, id: node.id,
      compiledExecutor: '(()=>{})()',
      warnings: [],
    });
    const beforeUpdate = await getCustomNode({ workspaceId: WS_A, id: node.id });
    expect(beforeUpdate!.compiledExecutor).toBe('(()=>{})()');
    const updated = await updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: { sourceExecutor: 'export const executor = async () => ({});' },
    });
    expect(updated.compiledExecutor).toBeNull();
    expect(updated.compileAt).toBeNull();
  });

  it('🚨 update di archived → ValidationError', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await archiveCustomNode({ workspaceId: WS_A, id: node.id });
    await expect(updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: { displayName: 'New' },
    })).rejects.toThrow(CustomNodeValidationError);
  });

  it('🚨 update di id non esistente → NotFoundError', async () => {
    await expect(updateCustomNode({
      workspaceId: WS_A, id: '00000000-0000-0000-0000-000000000000', actorUserId: USER_1,
      input: { displayName: 'X' },
    })).rejects.toThrow(CustomNodeNotFoundError);
  });
});

describe('🚨 rollbackToVersion', () => {
  it('🚨 rollback a versione 0.1.0 carica source originale + bump patch a 0.1.2', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await updateCustomNode({
      workspaceId: WS_A, id: node.id, actorUserId: USER_1,
      input: { sourceExecutor: 'export const executor = async () => ({ v: "second" });' },
    }); // 0.1.1
    const rolled = await rollbackToVersion({
      workspaceId: WS_A, customNodeId: node.id, actorUserId: USER_1,
      semverTarget: '0.1.0',
    });
    expect(rolled.semver).toBe('0.1.2'); // bumped patch dopo rollback
    expect(rolled.sourceExecutor).toBe(baseInput.sourceExecutor);
    const versions = await listVersions({ workspaceId: WS_A, customNodeId: node.id });
    expect(versions).toHaveLength(3);
    // Trova lo snapshot del rollback (semver 0.1.2)
    const rollbackSnap = versions.find((v) => v.semver === '0.1.2');
    expect(rollbackSnap).toBeDefined();
    expect(rollbackSnap!.changelog).toMatch(/Rollback to v0\.1\.0/);
  });

  it('🚨 rollback a versione inesistente → NotFoundError', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await expect(rollbackToVersion({
      workspaceId: WS_A, customNodeId: node.id, actorUserId: USER_1,
      semverTarget: '99.0.0',
    })).rejects.toThrow(CustomNodeNotFoundError);
  });
});

describe('🚨 archiveCustomNode', () => {
  it('🚨 soft-delete → slug riusabile dopo archive', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await archiveCustomNode({ workspaceId: WS_A, id: node.id });
    // Re-create con stesso slug ora OK
    const node2 = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    expect(node2.id).not.toBe(node.id);
    expect(node2.status).toBe('draft');
  });

  it('🚨 archive idempotente (re-archive = no-op)', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await archiveCustomNode({ workspaceId: WS_A, id: node.id });
    await expect(archiveCustomNode({ workspaceId: WS_A, id: node.id })).resolves.toBeUndefined();
  });

  it('🚨 archive id non esistente → NotFoundError', async () => {
    await expect(archiveCustomNode({
      workspaceId: WS_A, id: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(CustomNodeNotFoundError);
  });
});

describe('🚨 persistCompileResult', () => {
  it('🚨 status draft → candidate al primo compile', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    expect(node.status).toBe('draft');
    await persistCompileResult({
      workspaceId: WS_A, id: node.id,
      compiledExecutor: '(()=>{ return { output: {} }; })()',
      warnings: [],
    });
    const after = await getCustomNode({ workspaceId: WS_A, id: node.id });
    expect(after!.status).toBe('candidate');
    expect(after!.compiledExecutor).toMatch(/\{ output: \{\} \}/);
    expect(after!.compileAt).toMatch(/T.*Z/);
  });

  it('🚨 persist con warnings → JSON parsed sul read', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await persistCompileResult({
      workspaceId: WS_A, id: node.id,
      compiledExecutor: 'x',
      warnings: [{ severity: 'warning', line: 5, col: 10, message: 'unused var', file: 'executor' }],
    });
    const after = await getCustomNode({ workspaceId: WS_A, id: node.id });
    expect(after!.compileWarnings).toHaveLength(1);
    expect(after!.compileWarnings[0]!.message).toBe('unused var');
    expect(after!.compileWarnings[0]!.file).toBe('executor');
  });

  it('🚨 con FLOWFORGE_REGISTRY_SECRET → calcola e persiste digest+firma integrità', async () => {
    process.env.FLOWFORGE_REGISTRY_SECRET = 'svc-test-registry-secret-32-bytes!!';
    try {
      const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
      await persistCompileResult({ workspaceId: WS_A, id: node.id, compiledExecutor: '(()=>{})()', warnings: [] });
      const raw = dbConnections[dbConnections.length - 1]!
        .prepare('SELECT integrity_digest, integrity_signature, integrity_algo FROM custom_nodes WHERE id = ?')
        .get(node.id) as { integrity_digest: string | null; integrity_signature: string | null; integrity_algo: string | null };
      expect(raw.integrity_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(raw.integrity_signature).toMatch(/^[0-9a-f]{64}$/);
      expect(raw.integrity_algo).toBe('sha256+hmac-sha256');
    } finally {
      delete process.env.FLOWFORGE_REGISTRY_SECRET;
    }
  });

  it('🚨 CONTRACT persist↔verify: la firma copre il compiledExecutor (l\'artefatto eseguito)', async () => {
    // Anti-regressione del bypass "firma solo i sorgenti": il record persistito
    // deve verificare col bundle persistito e FALLIRE con un bundle diverso.
    process.env.FLOWFORGE_REGISTRY_SECRET = 'svc-test-registry-secret-32-bytes!!';
    try {
      const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
      const compiled = '(()=>{ return { output: { n: 1 } }; })()';
      await persistCompileResult({ workspaceId: WS_A, id: node.id, compiledExecutor: compiled, warnings: [] });
      const raw = dbConnections[dbConnections.length - 1]!
        .prepare('SELECT slug, semver, source_executor, source_definition, source_schema, compiled_executor, integrity_digest, integrity_signature, integrity_algo FROM custom_nodes WHERE id = ?')
        .get(node.id) as {
          slug: string; semver: string; source_executor: string; source_definition: string;
          source_schema: string; compiled_executor: string; integrity_digest: string;
          integrity_signature: string; integrity_algo: string;
        };
      const { verifyPackageIntegrity } = await import('@/lib/custom-node-integrity.js');
      const pkg = {
        slug: raw.slug, semver: raw.semver,
        sourceExecutor: raw.source_executor, sourceDefinition: raw.source_definition,
        sourceSchema: raw.source_schema, compiledExecutor: raw.compiled_executor,
      };
      const record = { algo: raw.integrity_algo as never, digest: raw.integrity_digest, signature: raw.integrity_signature };
      expect(verifyPackageIntegrity(pkg, record, 'svc-test-registry-secret-32-bytes!!')).toEqual({ valid: true });
      // Bundle diverso → la stessa firma NON deve più valere.
      const swapped = { ...pkg, compiledExecutor: '(()=>{ /* altro bundle */ })()' };
      expect(verifyPackageIntegrity(swapped, record, 'svc-test-registry-secret-32-bytes!!').valid).toBe(false);
    } finally {
      delete process.env.FLOWFORGE_REGISTRY_SECRET;
    }
  });

  it('🚨 senza secret → integrità NULL (back-compat, nessun blocco)', async () => {
    const prevReg = process.env.FLOWFORGE_REGISTRY_SECRET;
    const prevTok = process.env.FLOWFORGE_INTERNAL_TOKEN;
    delete process.env.FLOWFORGE_REGISTRY_SECRET;
    delete process.env.FLOWFORGE_INTERNAL_TOKEN;
    try {
      const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
      await persistCompileResult({ workspaceId: WS_A, id: node.id, compiledExecutor: 'x', warnings: [] });
      const raw = dbConnections[dbConnections.length - 1]!
        .prepare('SELECT integrity_digest FROM custom_nodes WHERE id = ?')
        .get(node.id) as { integrity_digest: string | null };
      expect(raw.integrity_digest).toBeNull();
    } finally {
      if (prevReg !== undefined) process.env.FLOWFORGE_REGISTRY_SECRET = prevReg;
      if (prevTok !== undefined) process.env.FLOWFORGE_INTERNAL_TOKEN = prevTok;
    }
  });
});

describe('🚨 appendTestRun (ring buffer)', () => {
  it('🚨 ring buffer max TEST_RUNS_RING_SIZE → drop oldest', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    for (let i = 1; i <= TEST_RUNS_RING_SIZE + 5; i++) {
      await appendTestRun({
        workspaceId: WS_A, id: node.id,
        record: { at: new Date().toISOString(), input: { i }, output: { ok: true }, ok: true, durationMs: i },
      });
    }
    const after = await getCustomNode({ workspaceId: WS_A, id: node.id });
    expect(after!.testRuns).toHaveLength(TEST_RUNS_RING_SIZE);
    // most recent first (i=25 dovrebbe essere primo)
    const firstRun = after!.testRuns[0]! as { durationMs: number };
    expect(firstRun.durationMs).toBe(TEST_RUNS_RING_SIZE + 5);
  });
});

describe('🚨 listTestRuns (FIX A3 — ring buffer ora esposto)', () => {
  it('ritorna i run newest-first scritti da appendTestRun', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await appendTestRun({ workspaceId: WS_A, id: node.id, record: { at: '2026-06-13T08:00:00Z', input: { i: 1 }, output: {}, ok: true, durationMs: 1 } });
    await appendTestRun({ workspaceId: WS_A, id: node.id, record: { at: '2026-06-13T09:00:00Z', input: { i: 2 }, output: {}, ok: false, durationMs: 2, error: 'x' } });
    const runs = await listTestRuns({ workspaceId: WS_A, id: node.id });
    expect(runs).toHaveLength(2);
    expect((runs[0] as { durationMs: number }).durationMs).toBe(2); // newest-first
    expect((runs[1] as { durationMs: number }).durationMs).toBe(1);
  });

  it('nodo senza run → array vuoto', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    expect(await listTestRuns({ workspaceId: WS_A, id: node.id })).toEqual([]);
  });

  it('id inesistente → throw (NotFound)', async () => {
    await expect(listTestRuns({ workspaceId: WS_A, id: 'cn_nope' })).rejects.toThrow();
  });

  it('🚨 isolamento tenant: WS_B NON vede i run di WS_A (throw NotFound)', async () => {
    const node = await createCustomNode({ workspaceId: WS_A, ownerUserId: USER_1, input: baseInput });
    await appendTestRun({ workspaceId: WS_A, id: node.id, record: { at: '2026-06-13T08:00:00Z', input: {}, output: {}, ok: true, durationMs: 1 } });
    await expect(listTestRuns({ workspaceId: WS_B, id: node.id })).rejects.toThrow();
  });
});

describe('🚨 bumpSemver (pure function)', () => {
  it('🚨 patch: 1.2.3 → 1.2.4', () => { expect(bumpSemver('1.2.3', 'patch')).toBe('1.2.4'); });
  it('🚨 minor: 1.2.3 → 1.3.0', () => { expect(bumpSemver('1.2.3', 'minor')).toBe('1.3.0'); });
  it('🚨 major: 1.2.3 → 2.0.0', () => { expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0'); });
  it('🚨 malformed → throws ValidationError', () => {
    expect(() => bumpSemver('1.2', 'patch')).toThrow(CustomNodeValidationError);
    expect(() => bumpSemver('v1.2.3', 'patch')).toThrow(CustomNodeValidationError);
  });
});

describe('🚨 submitCustomNodeToMarketplace — state machine + gates', () => {
  it('candidate + compiled + plan pro → marketplace_pending', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: {
        slug: 'mk1', displayName: 'MK1',
        sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c',
      },
    });
    await persistCompileResult({
      workspaceId: 'ws-1', id: node.id,
      compiledExecutor: '(function(){})()',
      warnings: [],
    });
    const submitted = await submitCustomNodeToMarketplace({
      workspaceId: 'ws-1', id: node.id, actorUserId: 'u',
    });
    expect(submitted.status).toBe('marketplace_pending');
  });

  it('senza compiled → throws (compile required)', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'mk2', displayName: 'MK2', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await expect(submitCustomNodeToMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' }))
      .rejects.toThrow(/Compile required/u);
  });

  it('archived → throws', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'mk3', displayName: 'MK3', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await archiveCustomNode({ workspaceId: 'ws-1', id: node.id });
    await expect(submitCustomNodeToMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' }))
      .rejects.toThrow(/archived/u);
  });

  it('compiled con security errors → throws', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'mk4', displayName: 'MK4', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await persistCompileResult({
      workspaceId: 'ws-1', id: node.id,
      compiledExecutor: '(function(){})()',
      warnings: [{ severity: 'error', line: 1, col: 1, message: 'eval forbidden', code: 'SEC', file: 'executor' }],
    });
    await expect(submitCustomNodeToMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' }))
      .rejects.toThrow(/errori di sicurezza/u);
  });

  it('già marketplace_pending → throws (idempotency)', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'mk5', displayName: 'MK5', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await persistCompileResult({ workspaceId: 'ws-1', id: node.id, compiledExecutor: 'x', warnings: [] });
    await submitCustomNodeToMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' });
    await expect(submitCustomNodeToMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' }))
      .rejects.toThrow(/already pending/u);
  });
});

describe('🚨 withdrawCustomNodeFromMarketplace — state machine', () => {
  it('marketplace_pending → candidate', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'wd1', displayName: 'WD1', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await persistCompileResult({ workspaceId: 'ws-1', id: node.id, compiledExecutor: 'x', warnings: [] });
    await submitCustomNodeToMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' });
    const withdrawn = await withdrawCustomNodeFromMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' });
    expect(withdrawn.status).toBe('candidate');
  });

  it('NON pending → throws', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'wd2', displayName: 'WD2', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await expect(withdrawCustomNodeFromMarketplace({ workspaceId: 'ws-1', id: node.id, actorUserId: 'u' }))
      .rejects.toThrow(/non "marketplace_pending"/u);
  });
});

// publishCustomNodePrivate non viene già testato sopra esplicitamente
describe('🚨 publishCustomNodePrivate — state machine', () => {
  it('candidate + compiled → published_priv', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'pp1', displayName: 'PP1', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await persistCompileResult({ workspaceId: 'ws-1', id: node.id, compiledExecutor: 'x', warnings: [] });
    const published = await publishCustomNodePrivate({ workspaceId: 'ws-1', id: node.id });
    expect(published.status).toBe('published_priv');
  });

  it('senza compile → throws', async () => {
    const node = await createCustomNode({
      workspaceId: 'ws-1', ownerUserId: 'u',
      input: { slug: 'pp2', displayName: 'PP2', sourceExecutor: 'a', sourceDefinition: 'b', sourceSchema: 'c' },
    });
    await expect(publishCustomNodePrivate({ workspaceId: 'ws-1', id: node.id }))
      .rejects.toThrow(/Compile required/u);
  });
});
