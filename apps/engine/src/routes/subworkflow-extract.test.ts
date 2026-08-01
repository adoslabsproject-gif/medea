/**
 * Test 2026-grade — subworkflow-extract route (atomic transaction).
 *
 * 🚨 BUSINESS-LOGIC critical: estrae N nodi da workflow parent → nuovo
 *    subworkflow. Bug = workflow rotto, edge orphan, dati persi.
 *
 * 🚨 EDGE CLASSIFICATION:
 *  - inner: both endpoints in selection → go to new workflow
 *  - in-cross: source out, target in → rewrite target → subNode
 *  - out-cross: source in, target out → rewrite source → subNode
 *  - external: both out → kept as-is
 *
 * 🚨 ATOMICITY: SQLite transaction (sqlite.transaction wrapper).
 *
 * 🚨 INPUT VALIDATION Zod:
 *  - nodeIds min 2 (estrarre 1 nodo non ha senso)
 *  - newWorkflowName 1..200 char
 *
 * 🚨 SECURITY: auth required + tenant isolation + audit log append.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const workflowGetMock = vi.fn();
class WorkflowServiceMock {
  get = workflowGetMock;
}
vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: WorkflowServiceMock,
}));

const auditAppendMock = vi.fn();
class AuditLogServiceMock {
  append = auditAppendMock;
}
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: AuditLogServiceMock,
}));

const mockDb = { sqlite: null as DB | null };
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: mockDb.sqlite }),
}));

vi.mock('@/lib/tenant.js', () => ({
  getTenantId: () => 'tenant-A',
}));

const { createSubworkflowExtractRoutes } = await import('./subworkflow-extract.js');

function setupSchema(db: DB): void {
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1,
      nodes_json TEXT NOT NULL DEFAULT '[]',
      edges_json TEXT NOT NULL DEFAULT '[]',
      node_defs_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      owner_id TEXT
    );
  `);
}

function makeApp(authenticated = true): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authenticated) c.set('auth' as never, { userId: 'user-1' } as never);
    return next();
  });
  app.route('/api/v1', createSubworkflowExtractRoutes({} as never));
  return app;
}

async function extractCall(parentId: string, body: unknown): Promise<Response> {
  return makeApp().request(`/api/v1/workflows/${parentId}/extract-subworkflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.sqlite = new Database(':memory:');
  setupSchema(mockDb.sqlite);
  auditAppendMock.mockResolvedValue(undefined);
});

describe('🚨 auth gate', () => {
  it('🚨 no auth → 401', async () => {
    workflowGetMock.mockResolvedValue({ id: 'p', nodes: [], edges: [] });
    const app = makeApp(false);
    const res = await app.request('/api/v1/workflows/p/extract-subworkflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeIds: ['a', 'b'], newWorkflowName: 'X' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('🚨 input validation Zod', () => {
  it('🚨 nodeIds < 2 → 400 ("Selezionare almeno 2")', async () => {
    const res = await extractCall('p', { nodeIds: ['only-one'], newWorkflowName: 'X' });
    expect(res.status).toBe(400);
  });

  it('🚨 nodeIds vuoto → 400', async () => {
    const res = await extractCall('p', { nodeIds: [], newWorkflowName: 'X' });
    expect(res.status).toBe(400);
  });

  it('🚨 nodeIds con string vuoto → 400 (z.string().min(1))', async () => {
    const res = await extractCall('p', { nodeIds: ['a', ''], newWorkflowName: 'X' });
    expect(res.status).toBe(400);
  });

  it('🚨 newWorkflowName vuoto → 400', async () => {
    const res = await extractCall('p', { nodeIds: ['a', 'b'], newWorkflowName: '' });
    expect(res.status).toBe(400);
  });

  it('🚨 newWorkflowName > 200 char → 400', async () => {
    const res = await extractCall('p', {
      nodeIds: ['a', 'b'],
      newWorkflowName: 'x'.repeat(201),
    });
    expect(res.status).toBe(400);
  });
});

describe('🚨 workflow not found / unknown node', () => {
  it('🚨 parent workflow inesistente → 404', async () => {
    workflowGetMock.mockResolvedValue(null);
    const res = await extractCall('missing', { nodeIds: ['a', 'b'], newWorkflowName: 'X' });
    expect(res.status).toBe(404);
  });

  it('🚨 nodeId NOT in workflow → 400 con nome nodo specifico', async () => {
    workflowGetMock.mockResolvedValue({
      id: 'p', schemaVersion: 1, name: 'P', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [{ id: 'real-1', defId: 'a', x: 0, y: 0, config: {} }],
      edges: [], nodeDefs: [],
    });
    const res = await extractCall('p', { nodeIds: ['real-1', 'GHOST'], newWorkflowName: 'X' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('GHOST');
  });
});

describe('🚨 edge classification — inner/in-cross/out-cross/external', () => {
  beforeEach(() => {
    // Pre-insert parent workflow row (UPDATE handler richiede esistenza)
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'Parent', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());
  });

  it('🚨 INNER edge: both in selection → trasferito a subworkflow', async () => {
    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'Parent', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'a', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'b', defId: 'x', x: 100, y: 0, config: {} },
        { id: 'outside', defId: 'x', x: 300, y: 0, config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }], // inner
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] }); // for the final get

    const res = await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });
    expect(res.status).toBe(200);

    // Verify new workflow row has inner edge + trigger edge
    const subRow = mockDb.sqlite!.prepare(
      `SELECT edges_json FROM workflows WHERE name='Sub'`,
    ).get() as { edges_json: string } | undefined;
    expect(subRow).toBeDefined();
    const subEdges = JSON.parse(subRow!.edges_json) as { from: string; to: string }[];
    // trigger → a, a → b
    expect(subEdges.some((e) => e.from === 'a' && e.to === 'b')).toBe(true);
    expect(subEdges.some((e) => e.to === 'a')).toBe(true); // trigger edge
  });

  it('🚨 IN-CROSS edge: src out, dst in → rewrite target → subNode', async () => {
    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'Parent', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'src-out', defId: 'x', x: -200, y: 0, config: {} },
        { id: 'tgt-in', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'other', defId: 'x', x: 100, y: 0, config: {} },
      ],
      edges: [{ from: 'src-out', to: 'tgt-in' }],
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['tgt-in', 'other'], newWorkflowName: 'Sub' });

    const parentRow = mockDb.sqlite!.prepare(
      `SELECT edges_json FROM workflows WHERE id='p-1'`,
    ).get() as { edges_json: string };
    const parentEdges = JSON.parse(parentRow.edges_json) as { from: string; to: string }[];
    // L'edge dovrebbe essere src-out → sub-XXX (subNode)
    expect(parentEdges).toHaveLength(1);
    expect(parentEdges[0]!.from).toBe('src-out');
    expect(parentEdges[0]!.to).toMatch(/^sub-/u);
  });

  it('🚨 OUT-CROSS edge: src in, dst out → rewrite source → subNode', async () => {
    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'Parent', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'src-in', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'other', defId: 'x', x: 100, y: 0, config: {} },
        { id: 'dst-out', defId: 'x', x: 300, y: 0, config: {} },
      ],
      edges: [{ from: 'src-in', to: 'dst-out' }],
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['src-in', 'other'], newWorkflowName: 'Sub' });

    const parentRow = mockDb.sqlite!.prepare(
      `SELECT edges_json FROM workflows WHERE id='p-1'`,
    ).get() as { edges_json: string };
    const parentEdges = JSON.parse(parentRow.edges_json) as { from: string; to: string }[];
    expect(parentEdges).toHaveLength(1);
    expect(parentEdges[0]!.from).toMatch(/^sub-/u);
    expect(parentEdges[0]!.to).toBe('dst-out');
  });

  it('🚨 EXTERNAL edge (both out) → kept as-is', async () => {
    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'Parent', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'a', defId: 'x', x: 0, y: 0, config: {} }, // selected
        { id: 'b', defId: 'x', x: 100, y: 0, config: {} }, // selected
        { id: 'ext1', defId: 'x', x: 300, y: 0, config: {} },
        { id: 'ext2', defId: 'x', x: 400, y: 0, config: {} },
      ],
      edges: [{ from: 'ext1', to: 'ext2' }], // both out → kept
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });

    const parentRow = mockDb.sqlite!.prepare(
      `SELECT edges_json FROM workflows WHERE id='p-1'`,
    ).get() as { edges_json: string };
    const parentEdges = JSON.parse(parentRow.edges_json) as { from: string; to: string }[];
    expect(parentEdges.some((e) => e.from === 'ext1' && e.to === 'ext2')).toBe(true);
  });
});

describe('🚨 trigger_manual auto-added', () => {
  it('🚨 nodi senza inner-incoming → connessi al trigger (entry points)', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'P', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'a', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'b', defId: 'x', x: 100, y: 0, config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });

    const subRow = mockDb.sqlite!.prepare(
      `SELECT nodes_json, edges_json FROM workflows WHERE name='Sub'`,
    ).get() as { nodes_json: string; edges_json: string };
    const nodes = JSON.parse(subRow.nodes_json) as { id: string; defId: string }[];
    const edges = JSON.parse(subRow.edges_json) as { from: string; to: string }[];
    // trigger_manual presente
    const trigger = nodes.find((n) => n.defId === 'trigger_manual');
    expect(trigger).toBeDefined();
    expect(trigger!.id).toMatch(/^t-/u);
    // edge trigger → a (a non ha inner-incoming)
    expect(edges.some((e) => e.from === trigger!.id && e.to === 'a')).toBe(true);
    // a → b interno preservato
    expect(edges.some((e) => e.from === 'a' && e.to === 'b')).toBe(true);
  });

  it('🚨 multiple entry points → trigger collegato a TUTTI', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'P', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'h1', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'h2', defId: 'x', x: 0, y: 100, config: {} },
      ],
      edges: [], // h1 e h2 entrambi entry (no inner-incoming)
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['h1', 'h2'], newWorkflowName: 'Sub' });

    const subRow = mockDb.sqlite!.prepare(
      `SELECT edges_json FROM workflows WHERE name='Sub'`,
    ).get() as { edges_json: string };
    const edges = JSON.parse(subRow.edges_json) as { to: string }[];
    expect(edges.filter((e) => e.to === 'h1' || e.to === 'h2')).toHaveLength(2);
  });
});

describe('🚨 logic_subworkflow node creation', () => {
  it('🚨 subNode posizionato a (minX extracted, avgY extracted)', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'P', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'a', defId: 'x', x: 100, y: 0, config: {} },
        { id: 'b', defId: 'x', x: 300, y: 200, config: {} },
        { id: 'kept', defId: 'x', x: 500, y: 0, config: {} },
      ],
      edges: [],
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });

    const parentRow = mockDb.sqlite!.prepare(
      `SELECT nodes_json FROM workflows WHERE id='p-1'`,
    ).get() as { nodes_json: string };
    const parentNodes = JSON.parse(parentRow.nodes_json) as { defId: string; x: number; y: number; config: Record<string, string> }[];
    const subNode = parentNodes.find((n) => n.defId === 'logic_subworkflow')!;
    expect(subNode.x).toBe(100); // min(100, 300)
    expect(subNode.y).toBe(100); // avg(0, 200)
    expect(subNode.config.workflowId).toBeDefined();
  });

  it('🚨 keptNodes preserved in parent (no data loss)', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'P', enabled: false,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'extracted-1', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'extracted-2', defId: 'x', x: 100, y: 0, config: {} },
        { id: 'kept-1', defId: 'y', x: 300, y: 0, config: { secret: 'preserve-me' } },
        { id: 'kept-2', defId: 'z', x: 400, y: 0, config: {} },
      ],
      edges: [],
      nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['extracted-1', 'extracted-2'], newWorkflowName: 'Sub' });

    const parentRow = mockDb.sqlite!.prepare(
      `SELECT nodes_json FROM workflows WHERE id='p-1'`,
    ).get() as { nodes_json: string };
    const parentNodes = JSON.parse(parentRow.nodes_json) as { id: string; config?: Record<string, string> }[];
    const kept1 = parentNodes.find((n) => n.id === 'kept-1');
    expect(kept1).toBeDefined();
    expect(kept1!.config!.secret).toBe('preserve-me');
    expect(parentNodes.find((n) => n.id === 'kept-2')).toBeDefined();
    expect(parentNodes.find((n) => n.id === 'extracted-1')).toBeUndefined();
  });
});

describe('🚨 atomicity + audit', () => {
  it('🚨 nuovo workflow persiste con tenant + audit append chiamato', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'P', enabled: false,
      tenantId: 'tenant-A', description: '', tags: ['x', 'y'],
      nodes: [
        { id: 'a', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'b', defId: 'x', x: 100, y: 0, config: {} },
      ],
      edges: [],
      nodeDefs: [{ id: 'x', label: 'X', type: 'action' }],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    const res = await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });
    expect(res.status).toBe(200);

    // Audit chiamato con action workflow.subworkflow_extract
    expect(auditAppendMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-A',
      action: 'workflow.subworkflow_extract',
      resourceType: 'workflow',
      resourceId: 'p-1',
      actorId: 'user-1',
      metadata: expect.objectContaining({
        extractedNodeCount: 2,
      }),
    }));

    // Nuovo workflow ha tags ereditati + description "Estratto da"
    const subRow = mockDb.sqlite!.prepare(
      `SELECT description, tags_json FROM workflows WHERE name='Sub'`,
    ).get() as { description: string; tags_json: string };
    expect(subRow.description).toMatch(/Estratto da.*"P"/u);
    expect(JSON.parse(subRow.tags_json)).toEqual(['x', 'y']);
  });

  it('🚨 nuovo workflow enabled=false (sempre disabled, manual review)', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock.mockResolvedValueOnce({
      id: 'p-1', schemaVersion: 1, name: 'P', enabled: true,
      tenantId: 'tenant-A', description: '', tags: [],
      nodes: [
        { id: 'a', defId: 'x', x: 0, y: 0, config: {} },
        { id: 'b', defId: 'x', x: 100, y: 0, config: {} },
      ],
      edges: [], nodeDefs: [],
    }).mockResolvedValue({ id: 'p-1', nodes: [], edges: [] });

    await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });

    const subRow = mockDb.sqlite!.prepare(
      `SELECT enabled FROM workflows WHERE name='Sub'`,
    ).get() as { enabled: number };
    expect(subRow.enabled).toBe(0); // SQLite boolean
  });
});

describe('🚨 response shape', () => {
  it('🚨 ritorna { parent, subworkflow } con workflow refreshed', async () => {
    mockDb.sqlite!.prepare(`
      INSERT INTO workflows (id, tenant_id, name, created_at, updated_at, nodes_json, edges_json)
      VALUES ('p-1', 'tenant-A', 'P', ?, ?, '[]', '[]')
    `).run(new Date().toISOString(), new Date().toISOString());

    workflowGetMock
      .mockResolvedValueOnce({ // initial load
        id: 'p-1', schemaVersion: 1, name: 'P', enabled: false,
        tenantId: 'tenant-A', description: '', tags: [],
        nodes: [
          { id: 'a', defId: 'x', x: 0, y: 0, config: {} },
          { id: 'b', defId: 'x', x: 100, y: 0, config: {} },
        ],
        edges: [], nodeDefs: [],
      })
      .mockResolvedValueOnce({ id: 'p-1', name: 'P-UPDATED' }) // refreshed parent
      .mockResolvedValueOnce({ id: 'sub-NEW', name: 'Sub' });   // refreshed sub

    const res = await extractCall('p-1', { nodeIds: ['a', 'b'], newWorkflowName: 'Sub' });
    expect(res.status).toBe(200);
    const json = await res.json() as { parent: { id: string }; subworkflow: { name: string } };
    expect(json.parent.id).toBe('p-1');
    expect(json.subworkflow.name).toBe('Sub');
  });
});
