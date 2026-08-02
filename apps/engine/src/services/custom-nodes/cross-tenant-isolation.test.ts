/**
 * Cross-tenant isolation test (security audit — gap audit Cappella Sistina).
 *
 * 🔒 Garantisce che ogni operazione public del custom-nodes service filtri
 * SEMPRE per `workspace_id` corrente. Anti-regression contro la classe di bug
 * "leak cross-tenant" — nodo di workspace A visibile/modificabile da utente
 * autenticato in workspace B.
 *
 * Pattern enterprise: TWO tenant fixture (WS-A + WS-B) con nodi distinti +
 * stesso `slug` (cross-tenant). Ogni public method invocato con `workspace=B`
 * NON deve mai ritornare/agire su row di `workspace=A`.
 *
 * Coverage: 9 endpoint API → 1 test cross-tenant per ognuno.
 *  - getCustomNode (by id)
 *  - getCustomNodeBySlug (by slug)
 *  - listCustomNodes (catalog filter)
 *  - updateCustomNode (cannot UPDATE other tenant)
 *  - archiveCustomNode (cannot ARCHIVE other tenant)
 *  - listVersions (cannot LIST versions other tenant)
 *  - rollbackToVersion (cannot ROLLBACK other tenant)
 *  - publishCustomNodePrivate (cannot PUBLISH other tenant)
 *  - persistCompileResult (cannot SET compile other tenant)
 *
 * @module services/custom-nodes/cross-tenant-isolation.test
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
        exec: (sql: string) => {
          conn.exec(sql);
        },
        transaction: <T extends unknown[], R>(fn: (...args: T) => R) =>
          conn.transaction(fn) as unknown as (...args: T) => R,
      },
    };
  },
}));

// Mock plan-gating per evitare check quota (lasciamo tutte le quota check pass)
vi.mock('./plan-gating.js', () => ({
  assertCanCreateMoreCustomNodes: vi.fn().mockResolvedValue(undefined),
  assertCanPublishMarketplace: vi.fn(),
  countActiveCustomNodes: vi.fn().mockResolvedValue(0),
  resolveTenantPlan: vi.fn(() => 'pro'),
  PLAN_CAPABILITIES: {
    pro: { maxCustomNodes: 100, canPublishMarketplace: true },
  },
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: { append: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/lib/logger.js');

vi.mock('./compile.service.js', () => ({
  compileCustomNodeSources: vi.fn().mockResolvedValue({
    ok: true,
    compiledExecutor: 'CMP',
    warnings: [],
    compiledAt: new Date(),
  }),
}));

vi.mock('./cache.js', () => ({
  invalidateCustomNode: vi.fn(),
  emitCustomNodeUpdate: vi.fn(),
  setCustomNodeCache: vi.fn(),
  getCustomNodeFromCache: vi.fn(() => null),
}));

import {
  createCustomNode,
  getCustomNode,
  getCustomNodeBySlug,
  listCustomNodes,
  updateCustomNode,
  archiveCustomNode,
  listVersions,
  rollbackToVersion,
  publishCustomNodePrivate,
  persistCompileResult,
} from './service.js';

const WORKSPACE_A = 'ws-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'ws-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A = 'usr-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'usr-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let nodeA_id: string;
let nodeB_id: string;
const SHARED_SLUG = 'my-private-node';

beforeEach(async () => {
  const conn = new SqliteDatabase(':memory:');
  conn.exec(SCHEMA_SQL);
  dbConnections.push(conn);

  // Crea 1 nodo per ogni workspace, stesso slug (cross-tenant unique)
  const nodeA = await createCustomNode({
    workspaceId: WORKSPACE_A,
    ownerUserId: USER_A,
    input: {
      slug: SHARED_SLUG,
      displayName: 'Node A (workspace A)',
      description: 'segreto di A',
      sourceExecutor: 'export default async function() { return {} }',
      sourceDefinition: 'export const definition = {}',
      sourceSchema: 'export const schema = {}',
    },
  });
  nodeA_id = nodeA.id;
  const nodeB = await createCustomNode({
    workspaceId: WORKSPACE_B,
    ownerUserId: USER_B,
    input: {
      slug: SHARED_SLUG,
      displayName: 'Node B (workspace B)',
      description: 'segreto di B',
      sourceExecutor: 'export default async function() { return {} }',
      sourceDefinition: 'export const definition = {}',
      sourceSchema: 'export const schema = {}',
    },
  });
  nodeB_id = nodeB.id;
});

afterEach(() => {
  const conn = dbConnections.pop();
  if (conn) conn.close();
});

// ═══════════════════════════════════════════════════════════════════════
// READ isolation
// ═══════════════════════════════════════════════════════════════════════
describe('🔒 cross-tenant isolation — READ', () => {
  it('🔒 getCustomNode(id) di A da workspace B → null (NO leak)', async () => {
    const fromBNodeA = await getCustomNode({ workspaceId: WORKSPACE_B, id: nodeA_id });
    expect(fromBNodeA).toBeNull();
    const fromBNodeB = await getCustomNode({ workspaceId: WORKSPACE_B, id: nodeB_id });
    expect(fromBNodeB).not.toBeNull();
    expect(fromBNodeB?.displayName).toBe('Node B (workspace B)');
  });

  it('🔒 getCustomNodeBySlug stesso slug → due nodi separati per workspace', async () => {
    const fromA = await getCustomNodeBySlug({ workspaceId: WORKSPACE_A, slug: SHARED_SLUG });
    const fromB = await getCustomNodeBySlug({ workspaceId: WORKSPACE_B, slug: SHARED_SLUG });
    expect(fromA?.id).toBe(nodeA_id);
    expect(fromB?.id).toBe(nodeB_id);
    expect(fromA?.displayName).toBe('Node A (workspace A)');
    expect(fromB?.displayName).toBe('Node B (workspace B)');
  });

  it('🔒 listCustomNodes(workspace B) NON ritorna nodi di A', async () => {
    const listA = await listCustomNodes({ workspaceId: WORKSPACE_A });
    const listB = await listCustomNodes({ workspaceId: WORKSPACE_B });
    expect(listA.items.length).toBe(1);
    expect(listB.items.length).toBe(1);
    expect(listA.items[0]!.id).toBe(nodeA_id);
    expect(listB.items[0]!.id).toBe(nodeB_id);
    // Doppio check: nessun id-A mai presente in listB
    for (const item of listB.items) {
      expect(item.id).not.toBe(nodeA_id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WRITE isolation — operazioni di mutate da workspace WRONG devono fallire
// ═══════════════════════════════════════════════════════════════════════
describe('🔒 cross-tenant isolation — WRITE', () => {
  it('🔒 updateCustomNode di A da workspace B → NotFound throw', async () => {
    await expect(
      updateCustomNode({
        workspaceId: WORKSPACE_B, // wrong workspace!
        id: nodeA_id, // ma id di A
        actorUserId: USER_B,
        input: { displayName: 'pwned' },
      }),
    ).rejects.toThrow();
  });

  it('🔒 updateCustomNode dal workspace CORRETTO funziona', async () => {
    const upd = await updateCustomNode({
      workspaceId: WORKSPACE_A,
      id: nodeA_id,
      actorUserId: USER_A,
      input: { displayName: 'A renamed' },
    });
    expect(upd.displayName).toBe('A renamed');
  });

  it('🔒 archiveCustomNode di A da workspace B → throw (nodo intatto)', async () => {
    await expect(
      archiveCustomNode({ workspaceId: WORKSPACE_B, id: nodeA_id, actorUserId: USER_B }),
    ).rejects.toThrow();
    // A resta NON archiviato
    const stillThere = await getCustomNode({ workspaceId: WORKSPACE_A, id: nodeA_id });
    expect(stillThere?.status).not.toBe('archived');
  });

  it('🔒 listVersions di A da workspace B → throw (no leak version history)', async () => {
    await expect(
      listVersions({ workspaceId: WORKSPACE_B, customNodeId: nodeA_id }),
    ).rejects.toThrow();
  });

  it('🔒 rollbackToVersion di A da workspace B → throw (no privilege escalation)', async () => {
    // Prima crea una v2 di A (per avere snapshot rollbackable)
    await updateCustomNode({
      workspaceId: WORKSPACE_A,
      id: nodeA_id,
      actorUserId: USER_A,
      input: { sourceExecutor: 'export default async function() { return { v2: true } }' },
    });
    await expect(
      rollbackToVersion({
        workspaceId: WORKSPACE_B, // wrong
        customNodeId: nodeA_id,
        actorUserId: USER_B,
        semverTarget: '0.1.0',
      }),
    ).rejects.toThrow();
  });

  it('🔒 publishCustomNodePrivate di A da workspace B → throw', async () => {
    // Prima compila A (per avere candidate status)
    await persistCompileResult({
      workspaceId: WORKSPACE_A,
      id: nodeA_id,
      compiledExecutor: 'CMP',
      warnings: [],
    });
    await expect(
      publishCustomNodePrivate({ workspaceId: WORKSPACE_B, id: nodeA_id, actorUserId: USER_B }),
    ).rejects.toThrow();
  });

  it('🔒 persistCompileResult di A da workspace B → throw (no compile injection)', async () => {
    await expect(
      persistCompileResult({
        workspaceId: WORKSPACE_B,
        id: nodeA_id,
        compiledExecutor: 'INJECTED',
        warnings: [],
      }),
    ).rejects.toThrow();
    // Verifica che A non sia stato toccato
    const a = await getCustomNode({ workspaceId: WORKSPACE_A, id: nodeA_id });
    expect(a?.compiledExecutor).not.toBe('INJECTED');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Filter bypass attempts — ownerUserId, status, category
// ═══════════════════════════════════════════════════════════════════════
describe('🔒 cross-tenant isolation — FILTER BYPASS', () => {
  it('🔒 listCustomNodes con ownerUserId=USER_A da workspace B → 0 risultati', async () => {
    // Anche se filtro per owner di A, il workspace filter prevale
    const list = await listCustomNodes({
      workspaceId: WORKSPACE_B,
      filter: { ownerUserId: USER_A },
    });
    expect(list.items.length).toBe(0);
    expect(list.total).toBe(0);
  });

  it('🔒 listCustomNodes status=draft cross-tenant → 0 risultati', async () => {
    // Filtri custom non bypassano workspace_id
    const list = await listCustomNodes({
      workspaceId: WORKSPACE_B,
      filter: { status: 'draft' as never },
    });
    // Nodo B esiste in draft, A NON deve esserci
    expect(list.items.every((n) => n.id !== nodeA_id)).toBe(true);
  });
});
