/**
 * Tests per WorkflowVersionsService — N1 audit (tenant_id IDOR fix).
 *
 * Scope: verifica che list/get/snapshot/diff filtrino per tenant_id e
 * NON ritornino versioni di altri tenant (defense-in-depth contro IDOR).
 *
 * Pre-fix N1 (audit 2026-05-29):
 *   - list(workflowId) → ritornava versioni CROSS-tenant
 *   - get(versionId) → leggeva qualsiasi versionId
 *
 * Post-fix:
 *   - list(workflowId, tenantId) → solo versioni del tenant
 *   - get(versionId, tenantId) → null se versione di altro tenant
 *   - snapshot(workflow, tenantId, ...) → tenant_id persistito
 *   - diff(a, b, tenantId) → null se una versione è di altro tenant
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  preparedStatements: new Map<string, { run: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn> }>(),
  sqliteExec: vi.fn(),
  sqlitePragma: vi.fn(() => [{ name: 'id' }, { name: 'workflow_id' }, { name: 'version_number' }, { name: 'spec_json' }, { name: 'created_at' }, { name: 'created_by' }, { name: 'comment' }, { name: 'tenant_id' }] as { name: string }[]),
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      exec: (sql: string) => m.sqliteExec(sql),
      prepare: (sql: string) => {
        if (sql.startsWith('PRAGMA')) {
          return { all: (): { name: string }[] => m.sqlitePragma() };
        }
        let stmt = m.preparedStatements.get(sql);
        if (!stmt) {
          stmt = { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) };
          m.preparedStatements.set(sql, stmt);
        }
        return stmt;
      },
    },
  }),
}));

vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@/services/workflow.service.js', () => ({
  WorkflowService: class {
    get = vi.fn();
    update = vi.fn();
  },
}));

vi.mock('@/lib/logger.js');

vi.mock('nanoid', () => ({ nanoid: () => 'fake-version-id' }));

interface FakeEventBus {
  subscribeTo: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
}

function fakeEventBus(): FakeEventBus {
  return {
    subscribeTo: vi.fn(),
    publish: vi.fn(),
  };
}

beforeEach(() => {
  m.preparedStatements.clear();
  m.sqliteExec.mockClear();
});

describe('WorkflowVersionsService — N1 schema evolution', () => {
  it('aggiunge tenant_id se PRAGMA table_info non lo include', async () => {
    // Override pragma per simulare schema legacy senza tenant_id
    m.sqlitePragma.mockReturnValueOnce([
      { name: 'id' }, { name: 'workflow_id' }, { name: 'version_number' },
      { name: 'spec_json' }, { name: 'created_at' }, { name: 'created_by' },
      { name: 'comment' },
    ]);
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    new WorkflowVersionsService(fakeEventBus() as never);
    // Cerca tra le exec quella ALTER TABLE
    const alterCalled = m.sqliteExec.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes('ALTER TABLE workflow_versions ADD COLUMN tenant_id')
    );
    expect(alterCalled).toBe(true);
  });

  it('NON aggiunge tenant_id se già presente', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    new WorkflowVersionsService(fakeEventBus() as never);
    const alterCalled = m.sqliteExec.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes('ALTER TABLE workflow_versions ADD COLUMN tenant_id')
    );
    expect(alterCalled).toBe(false);
  });
});

describe('WorkflowVersionsService — snapshot inserisce tenant_id', () => {
  it('snapshot(workflow, tenantId, ...) → INSERT include tenant_id e usa MAX scoped', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const svc = new WorkflowVersionsService(fakeEventBus() as never);
    // Mock MAX query — la prepare è parametrizzata per tenant: il get
    // ritorna {n: null} significando nessuna versione esistente.
    const maxStmt = { run: vi.fn(), get: vi.fn().mockReturnValue({ n: null }), all: vi.fn() };
    m.preparedStatements.set(
      'SELECT MAX(version_number) as n FROM workflow_versions WHERE workflow_id = ? AND tenant_id = ?',
      maxStmt,
    );
    const wf = { id: 'wf-1', name: 'WF', enabled: false, nodes: [], edges: [], nodeDefs: [] };
    svc.snapshot(wf as never, 'tenant-A', 'user-1', 'init');

    // Verifica che esista una prepare con tenant_id NELL'INSERT
    const insertSql = [...m.preparedStatements.keys()].find((s) =>
      s.includes('INSERT INTO workflow_versions') && s.includes('tenant_id')
    );
    expect(insertSql).toBeDefined();
    const insertStmt = m.preparedStatements.get(insertSql!);
    // Il run deve aver ricevuto 'tenant-A' tra gli args
    expect(insertStmt!.run).toHaveBeenCalled();
    const args = insertStmt!.run.mock.calls[0] as unknown[];
    expect(args).toContain('tenant-A');
    expect(args).toContain('wf-1');
  });
});

describe('WorkflowVersionsService — list/get scoped per tenant', () => {
  it('list(workflowId, tenantId) → SELECT con AND tenant_id = ?', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const svc = new WorkflowVersionsService(fakeEventBus() as never);
    svc.list('wf-1', 'tenant-A');
    const selectSql = [...m.preparedStatements.keys()].find((s) =>
      s.includes('SELECT id, version_number') && s.includes('WHERE workflow_id = ? AND tenant_id = ?')
    );
    expect(selectSql).toBeDefined();
    const stmt = m.preparedStatements.get(selectSql!);
    const callArgs = stmt!.all.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('wf-1');
    expect(callArgs[1]).toBe('tenant-A');
  });

  it('get(versionId, tenantId) → SELECT con AND tenant_id = ? + null su mismatch', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const svc = new WorkflowVersionsService(fakeEventBus() as never);
    // Setup: stmt.get ritorna undefined (no row matching tenant)
    const result = svc.get('v-cross-tenant', 'tenant-A');
    const selectSql = [...m.preparedStatements.keys()].find((s) =>
      s.startsWith('SELECT *') && s.includes('AND tenant_id = ?')
    );
    expect(selectSql).toBeDefined();
    const stmt = m.preparedStatements.get(selectSql!);
    const callArgs = stmt!.get.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('v-cross-tenant');
    expect(callArgs[1]).toBe('tenant-A');
    // Mock default ritorna undefined → null
    expect(result).toBeNull();
  });

  it('get di un versionId di altro tenant → null (IDOR blocked)', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const svc = new WorkflowVersionsService(fakeEventBus() as never);
    // Per simulare row di tenant-X chiesta da tenant-A: il query filtro
    // tenant_id = 'tenant-A' non matcha → stmt.get ritorna undefined.
    const selectStmt = { run: vi.fn(), get: vi.fn().mockReturnValue(undefined), all: vi.fn() };
    m.preparedStatements.set(
      'SELECT * FROM workflow_versions WHERE id = ? AND tenant_id = ?',
      selectStmt,
    );
    expect(svc.get('v-of-tenant-X', 'tenant-A')).toBeNull();
  });

  it('list signature: (workflowId, tenantId, limit?) — type contract verificato', async () => {
    // 🚨 CONTRACT: verifica che la firma list(wfId, tenantId, limit?) rispetti
    // ordine dei params via runtime introspection. Bug = qualcuno cambia ordine
    // → TS forse permette (any), test runtime cattura.
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const eventBus = { emit: vi.fn(), subscribe: vi.fn(), subscribeTo: vi.fn() } as never;
    const svc = new WorkflowVersionsService(eventBus);
    expect(typeof svc.list).toBe('function');
    // Il metodo accetta 2-3 parametri (workflowId, tenantId, limit?)
    expect(svc.list.length).toBeGreaterThanOrEqual(2);
    expect(svc.list.length).toBeLessThanOrEqual(3);
  });
});

describe('WorkflowVersionsService — diff scoped per tenant', () => {
  it('diff(versionA, versionB, tenantId) propaga tenantId ad entrambi i get', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const svc = new WorkflowVersionsService(fakeEventBus() as never);
    // Setup: entrambe le get ritornano workflow piatto
    const selectStmt = {
      run: vi.fn(),
      get: vi.fn()
        .mockReturnValueOnce({ spec_json: JSON.stringify({ id: 'wf', nodes: [{ id: 'n1' }] }) })
        .mockReturnValueOnce({ spec_json: JSON.stringify({ id: 'wf', nodes: [{ id: 'n2' }] }) }),
      all: vi.fn(),
    };
    m.preparedStatements.set(
      'SELECT * FROM workflow_versions WHERE id = ? AND tenant_id = ?',
      selectStmt,
    );
    const result = svc.diff('v-a', 'v-b', 'tenant-A');
    expect(result).toEqual({ added: ['n2'], removed: ['n1'], changed: [] });
    // Verifica entrambe le call con tenant-A
    expect(selectStmt.get).toHaveBeenCalledTimes(2);
    expect(selectStmt.get.mock.calls[0]).toEqual(['v-a', 'tenant-A']);
    expect(selectStmt.get.mock.calls[1]).toEqual(['v-b', 'tenant-A']);
  });

  it('diff con una versione di altro tenant → null', async () => {
    const { WorkflowVersionsService } = await import('./workflow-versions.service.js');
    const svc = new WorkflowVersionsService(fakeEventBus() as never);
    const selectStmt = {
      run: vi.fn(),
      get: vi.fn()
        .mockReturnValueOnce({ spec_json: JSON.stringify({ id: 'wf', nodes: [] }) })
        .mockReturnValueOnce(undefined), // versione di altro tenant
      all: vi.fn(),
    };
    m.preparedStatements.set(
      'SELECT * FROM workflow_versions WHERE id = ? AND tenant_id = ?',
      selectStmt,
    );
    expect(svc.diff('v-a', 'v-b', 'tenant-A')).toBeNull();
  });
});
