/**
 * Test 2026-grade — DbStudioService (multi-tenant DB management + adapter CRUD).
 *
 * Coverage REALE (sqlite :memory: DB; adapters mockati per non requirsi binari):
 *  - CRUD: list / get / create / update / delete (tenant-scoped)
 *  - 🚨 tenant isolation: get(id, 'tA') returns null per row di tB
 *  - getAnyTenant: superadmin cross-tenant senza scope
 *  - listAllAcrossTenants: tutti i row ordinati tenant_id ASC
 *  - getAdapter cache: 2 chiamate stesso db → 1 connect; engine sconosciuto throw
 *  - applyMigration: chiama adapter + sync manifest spec_json (best-effort)
 *  - applyMigration: introspect throw → log warn ma migration ritorna ok
 *  - executeRaw: scrittura statement triggers manifest re-sync; SELECT only no sync
 *  - executeRaw: rolledBack=true → no sync
 *  - executeRaw: adapter.executeRaw assente → throw RAW_SQL_UNSUPPORTED
 *  - insert/updateRow/deleteRow: appendChangeLog per ogni op
 *  - getChangesSince: filtra per id > sinceId, limit 100
 *  - transaction batch: ogni step → change-log entry; engine no-batch → throw
 *  - introspect: forward all'adapter
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { MEDEA_DATA_DIR: '/tmp/ff-test' },
    connect: vi.fn(),
    applyMigration: vi.fn(),
    previewMigration: vi.fn(),
    query: vi.fn(),
    executeRaw: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    deleteOp: vi.fn(),
    transaction: vi.fn(),
    introspect: vi.fn(),
    introspectRelations: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(db: unknown) { return mockFns.connect(db); }
    async applyMigration(a: unknown) { return mockFns.applyMigration(a); }
    async previewMigration(a: unknown) { return mockFns.previewMigration(a); }
    async query(s: unknown) { return mockFns.query(s); }
    executeRaw = (sql: string, opts: unknown) => mockFns.executeRaw(sql, opts);
    async insert(t: string, r: unknown) { return mockFns.insert(t, r); }
    async update(t: string, w: unknown, p: unknown) { return mockFns.update(t, w, p); }
    async delete(t: string, w: unknown) { return mockFns.deleteOp(t, w); }
    async transaction(o: unknown) { return mockFns.transaction(o); }
    async introspect() { return mockFns.introspect(); }
    async introspectRelations() { return mockFns.introspectRelations(); }
  }
  class FakeAdapterNoBatch extends FakeAdapter {
    override engine = 'mongodb';
    override transaction = undefined as unknown as never;
  }
  class FakeAdapterNoRaw extends FakeAdapter {
    override engine = 'redis';
    override executeRaw = undefined as unknown as never;
  }
  return { ...mockFns, FakeAdapter, FakeAdapterNoBatch, FakeAdapterNoRaw };
});

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

vi.mock('@/lib/logger.js');

vi.mock('@/config.js', () => ({
  loadConfig: () => m.configValue,
}));

vi.mock('@medea/engine-db-studio-engine', () => ({
  SqliteAdapter: m.FakeAdapter,
}));
vi.mock('@medea/engine-db-studio-postgres', () => ({ PostgresAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mysql', () => ({ MysqlAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mongodb', () => ({ MongoDbAdapter: m.FakeAdapterNoBatch }));
vi.mock('@medea/engine-db-studio-redis', () => ({ RedisAdapter: m.FakeAdapterNoRaw }));
vi.mock('@medea/engine-db-studio-mssql', () => ({ MssqlAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-duckdb', () => ({ DuckDbAdapter: m.FakeAdapter }));
// La guardia SSRF è testata a parte (external-host-guard.test, con DI dnsResolve):
// qui no-op così i test di routing/caching usano host fittizi senza DNS reale.
vi.mock('@/services/db-studio/external-host-guard.js', () => ({ assertExternalHostAllowed: () => Promise.resolve() }));
const sshBridge = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('@/services/db-studio/ssh-tunnel-bridge.js', () => ({
  openDbStudioSshTunnel: (...a: unknown[]) => sshBridge.open(...a) as unknown,
}));

import { DbStudioService, quoteTableForEngine, redactConnectionSecrets, REDACTED_SECRET } from './db-studio.service.js';

function makeDbInput(tenantId = 't1', name = 'orders'): Parameters<DbStudioService['create']>[0] {
  return {
    tenantId,
    name,
    description: 'orders db',
    connection: { engine: 'sqlite', embedded: true },
    tables: [],
    relations: [],
  } as Parameters<DbStudioService['create']>[0];
}

beforeEach(() => {
  m.db = new Database(':memory:');
  Object.values(m).forEach((fn) => { if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset(); });
  m.connect.mockResolvedValue(undefined);
  m.introspect.mockResolvedValue([]);
  sshBridge.open.mockReset();
});

describe('CRUD — create / get / update / delete', () => {
  it('create: persistito + ritornato con id+timestamps', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    expect(d.id).toBeDefined();
    expect(d.createdAt).toBeDefined();
    expect(d.updatedAt).toBeDefined();
    expect(svc.list('t1')).toHaveLength(1);
  });

  it('get: ritorna il database creato', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const got = svc.get(d.id, 't1');
    expect(got).not.toBeNull();
    expect(got!.id).toBe(d.id);
    expect(got!.name).toBe('orders');
  });

  it('get id inesistente → null', () => {
    const svc = new DbStudioService();
    expect(svc.get('fake', 't1')).toBeNull();
  });

  it('🚨 tenant isolation: tenant B non vede DB di A', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput('tA'));
    expect(svc.get(d.id, 'tB')).toBeNull();
    expect(svc.get(d.id, 'tA')).not.toBeNull();
  });

  it('list tenant-scoped: ognuno vede solo il proprio', () => {
    const svc = new DbStudioService();
    svc.create(makeDbInput('tA'));
    svc.create(makeDbInput('tA', 'invoices'));
    svc.create(makeDbInput('tB'));
    expect(svc.list('tA')).toHaveLength(2);
    expect(svc.list('tB')).toHaveLength(1);
  });

  it('list default tenantId="default"', () => {
    const svc = new DbStudioService();
    svc.create(makeDbInput('default'));
    expect(svc.list()).toHaveLength(1);
  });

  it('update: aggiorna name + bump updatedAt', async () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await new Promise((r) => setTimeout(r, 10));
    const u = svc.update(d.id, { name: 'orders_v2' }, 't1');
    expect(u!.name).toBe('orders_v2');
    expect(new Date(u!.updatedAt).getTime()).toBeGreaterThan(new Date(d.updatedAt).getTime());
  });

  it('update id inesistente → null', () => {
    const svc = new DbStudioService();
    expect(svc.update('fake', { name: 'x' }, 't1')).toBeNull();
  });

  it('update cross-tenant: tenant B su id di A → null', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput('tA'));
    expect(svc.update(d.id, { name: 'evil' }, 'tB')).toBeNull();
  });

  it('delete happy path → true + sparito da list', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    expect(svc.delete(d.id, 't1')).toBe(true);
    expect(svc.list('t1')).toHaveLength(0);
  });

  it('delete id inesistente → false', () => {
    const svc = new DbStudioService();
    expect(svc.delete('fake', 't1')).toBe(false);
  });

  it('🚨 cross-tenant delete: tenant B non può eliminare di A', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput('tA'));
    expect(svc.delete(d.id, 'tB')).toBe(false);
    expect(svc.list('tA')).toHaveLength(1);
  });
});

describe('cross-tenant superadmin views', () => {
  it('getAnyTenant: ritorna DB qualunque tenant', () => {
    const svc = new DbStudioService();
    const dA = svc.create(makeDbInput('tA'));
    const got = svc.getAnyTenant(dA.id);
    expect(got).not.toBeNull();
    expect(got!.tenantId).toBe('tA');
  });

  it('getAnyTenant id inesistente → null', () => {
    const svc = new DbStudioService();
    expect(svc.getAnyTenant('fake')).toBeNull();
  });

  it('listAllAcrossTenants: ritorna tutti, ordinato per tenant_id ASC', () => {
    const svc = new DbStudioService();
    svc.create(makeDbInput('zebra'));
    svc.create(makeDbInput('alpha'));
    const all = svc.listAllAcrossTenants();
    expect(all).toHaveLength(2);
    expect(all[0]!.tenantId).toBe('alpha');
    expect(all[1]!.tenantId).toBe('zebra');
  });
});

describe('getAdapter caching + engine routing', () => {
  it('cache: 2 chiamate stesso db → 1 connect', async () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.getAdapter(d);
    await svc.getAdapter(d);
    expect(m.connect).toHaveBeenCalledTimes(1);
  });

  it('engine non bundled (qdrant) → throw', async () => {
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'qdrant', embedded: false, url: 'http://qdrant:6333' },
    } as Parameters<DbStudioService['create']>[0]);
    await expect(svc.getAdapter(d)).rejects.toThrow(/not bundled/u);
  });

  it('postgres engine → PostgresAdapter (no throw)', async () => {
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'postgres', embedded: false, url: 'postgresql://x' },
    } as Parameters<DbStudioService['create']>[0]);
    await expect(svc.getAdapter(d)).resolves.toBeDefined();
  });

  it('SSH TUNNEL: apre il tunnel e punta l\'adapter a 127.0.0.1:<localPort>', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    sshBridge.open.mockResolvedValue({ localPort: 59999, close });
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'postgres', embedded: false, hostname: '127.0.0.1', port: 5432, database: 'nha', username: 'ro', passwordSecretRef: 'pw', sshTunnel: { host: 'bastion', port: 22, user: 'root', privateKeySecretRef: 'K', hostKeyFingerprint: 'SHA256:x' } },
    } as Parameters<DbStudioService['create']>[0]);
    await svc.getAdapter(d);
    expect(sshBridge.open).toHaveBeenCalledTimes(1);
    const passed = m.connect.mock.calls[0]![0] as { connection: { hostname: string; port: number; sshTunnel?: unknown } };
    expect(passed.connection.hostname).toBe('127.0.0.1');
    expect(passed.connection.port).toBe(59999);
    expect(passed.connection.sshTunnel).toBeUndefined(); // l'adapter non ri-tunnella
    // delete chiude il tunnel
    svc.delete(d.id, d.tenantId);
    await new Promise((r) => setTimeout(r, 0)); // closeTunnel è async best-effort
    expect(close).toHaveBeenCalled();
  });

  it('SSH TUNNEL: se adapter.connect fallisce → tunnel chiuso (no leak)', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    sshBridge.open.mockResolvedValue({ localPort: 59999, close });
    m.connect.mockRejectedValueOnce(new Error('auth failed'));
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'postgres', embedded: false, hostname: '127.0.0.1', port: 5432, database: 'nha', sshTunnel: { host: 'bastion', port: 22, user: 'root', privateKeySecretRef: 'K', hostKeyFingerprint: 'SHA256:x' } },
    } as Parameters<DbStudioService['create']>[0]);
    await expect(svc.getAdapter(d)).rejects.toThrow('auth failed');
    expect(close).toHaveBeenCalled();
  });

  it('duckdb EMBEDDED: connect riceve un file .duckdb su /data (NON :memory: → persiste)', async () => {
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'duckdb', embedded: false },
    } as Parameters<DbStudioService['create']>[0]);
    await svc.getAdapter(d);
    const passed = m.connect.mock.calls[0]![0] as { connection: { database?: string } };
    expect(passed.connection.database).toMatch(/user-databases\/.*\.duckdb$/u);
    expect(passed.connection.database).not.toBe(':memory:');
  });
});

describe('applyMigration — manifest sync', () => {
  it('happy path: applyMigration ritornato + spec_json risincronizzato', async () => {
    m.applyMigration.mockResolvedValue({ sql: 'CREATE TABLE x', affectedTables: ['x'] });
    m.introspect.mockResolvedValue([{
      id: 'tbl-x', name: 'x',
      columns: [{ id: 'col-id', name: 'id', type: 'integer' }],
    }]);
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const res = await svc.applyMigration(d.id, [{ kind: 'create_table', table: { name: 'x', columns: [] } } as never], 't1');
    expect(res.affectedTables).toEqual(['x']);
    const refreshed = svc.get(d.id, 't1');
    expect(refreshed!.tables).toHaveLength(1);
  });

  it('introspect throw → log warn ma migration result OK', async () => {
    m.applyMigration.mockResolvedValue({ sql: 'CREATE', affectedTables: [] });
    m.introspect.mockRejectedValue(new Error('connection lost'));
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const res = await svc.applyMigration(d.id, [{ kind: 'create_table', table: { name: 'x', columns: [] } } as never], 't1');
    expect(res.sql).toBe('CREATE');
  });

  it('id inesistente → throw "not found"', async () => {
    const svc = new DbStudioService();
    await expect(svc.applyMigration('fake', [])).rejects.toThrow(/not found/u);
  });
});

describe('executeRaw — statement classification + manifest sync', () => {
  it('SELECT statement: no manifest sync', async () => {
    m.executeRaw.mockResolvedValue({ statementKind: 'select', rows: [] });
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.executeRaw(d.id, 'SELECT 1', {}, 't1');
    expect(m.introspect).not.toHaveBeenCalled();
  });

  it('CREATE statement: manifest sync triggered', async () => {
    m.executeRaw.mockResolvedValue({ statementKind: 'create', rows: [] });
    m.introspect.mockResolvedValue([{ name: 'new_table' }]);
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.executeRaw(d.id, 'CREATE TABLE new_table (id INT)', {}, 't1');
    expect(m.introspect).toHaveBeenCalled();
  });

  it('rolledBack=true: no sync (no changes committed)', async () => {
    m.executeRaw.mockResolvedValue({ statementKind: 'create', rolledBack: true, rows: [] });
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.executeRaw(d.id, 'CREATE TABLE x', { dryRun: true }, 't1');
    expect(m.introspect).not.toHaveBeenCalled();
  });

  it('batch statementResults: sync se almeno un non-select', async () => {
    m.executeRaw.mockResolvedValue({
      statementResults: [
        { kind: 'select' },
        { kind: 'insert' },
      ],
    });
    m.introspect.mockResolvedValue([]);
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.executeRaw(d.id, 'SELECT 1; INSERT INTO x VALUES (1);', {}, 't1');
    expect(m.introspect).toHaveBeenCalled();
  });

  it('adapter senza executeRaw → throw RAW_SQL_UNSUPPORTED', async () => {
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'redis', embedded: false, url: 'redis://x' },
    } as Parameters<DbStudioService['create']>[0]);
    await expect(svc.executeRaw(d.id, 'SCAN 0', {}, 't1')).rejects.toThrow(/not supported/u);
    try {
      await svc.executeRaw(d.id, 'X', {}, 't1');
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe('RAW_SQL_UNSUPPORTED');
    }
  });
});

describe('insert / updateRow / deleteRow + change log', () => {
  it('insert: appendChangeLog op=insert', async () => {
    m.insert.mockResolvedValue({ id: 1 });
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.insert(d.id, 'orders', { name: 'pizza' }, 't1');
    const log = svc.getChangesSince('t1', d.id, 'orders', 0);
    expect(log).toHaveLength(1);
    expect(log[0]!.op).toBe('insert');
  });

  it('updateRow: appendChangeLog op=update', async () => {
    m.update.mockResolvedValue({ changes: 1 });
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.updateRow(d.id, 'orders', { id: 1 }, { name: 'updated' }, 't1');
    const log = svc.getChangesSince('t1', d.id, 'orders', 0);
    expect(log[0]!.op).toBe('update');
  });

  it('deleteRow: appendChangeLog op=delete', async () => {
    m.deleteOp.mockResolvedValue({ changes: 1 });
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.deleteRow(d.id, 'orders', { id: 1 }, 't1');
    const log = svc.getChangesSince('t1', d.id, 'orders', 0);
    expect(log[0]!.op).toBe('delete');
  });

  it('getChangesSince: filtra per id > sinceId', async () => {
    m.insert.mockResolvedValue({});
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    await svc.insert(d.id, 'orders', { a: 1 }, 't1');
    await svc.insert(d.id, 'orders', { a: 2 }, 't1');
    await svc.insert(d.id, 'orders', { a: 3 }, 't1');
    const after1 = svc.getChangesSince('t1', d.id, 'orders', 1);
    expect(after1).toHaveLength(2);
    expect(after1[0]!.id).toBe(2);
  });

  it('getChangesSince: limit applicato', async () => {
    m.insert.mockResolvedValue({});
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    for (let i = 0; i < 5; i++) await svc.insert(d.id, 'orders', { i }, 't1');
    expect(svc.getChangesSince('t1', d.id, 'orders', 0, 3)).toHaveLength(3);
  });

  it('🚨 getChangesSince tenant-scoped: tA non vede log di tB', async () => {
    m.insert.mockResolvedValue({});
    const svc = new DbStudioService();
    const dA = svc.create(makeDbInput('tA'));
    await svc.insert(dA.id, 'orders', { x: 1 }, 'tA');
    expect(svc.getChangesSince('tB', dA.id, 'orders', 0)).toHaveLength(0);
  });
});

describe('transaction batch', () => {
  it('happy path: ogni step → 1 change-log entry', async () => {
    m.transaction.mockResolvedValue({
      steps: [
        { index: 0, affectedRows: 1 },
        { index: 1, affectedRows: 2 },
      ],
    });
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const ops = [
      { kind: 'insert', table: 'orders', row: { name: 'A' } },
      { kind: 'insert', table: 'lines', row: { qty: 2 } },
    ];
    await svc.transaction(d.id, ops as never, 't1');
    expect(svc.getChangesSince('t1', d.id, 'orders', 0)).toHaveLength(1);
    expect(svc.getChangesSince('t1', d.id, 'lines', 0)).toHaveLength(1);
  });

  it('engine senza transaction → throw BATCH_UNSUPPORTED', async () => {
    const svc = new DbStudioService();
    const d = svc.create({
      ...makeDbInput(),
      connection: { engine: 'mongodb', embedded: false, url: 'mongodb://x' },
    } as Parameters<DbStudioService['create']>[0]);
    try {
      await svc.transaction(d.id, [], 't1');
      expect.fail('should throw');
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe('BATCH_UNSUPPORTED');
    }
  });
});

describe('introspect / query / previewMigration delegation', () => {
  it('introspect: forward adapter result', async () => {
    m.introspect.mockResolvedValue([{ name: 'users' }]);
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const r = await svc.introspect(d.id, 't1');
    expect(r).toEqual([{ name: 'users' }]);
  });

  it('query: forward QuerySpec', async () => {
    m.query.mockResolvedValue([{ id: 1 }]);
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const r = await svc.query(d.id, { table: 'orders', filters: [], orderBy: [] }, 't1');
    expect(r).toEqual([{ id: 1 }]);
  });

  it('previewMigration: forward actions', async () => {
    m.previewMigration.mockResolvedValue('CREATE TABLE x ...');
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    const sql = await svc.previewMigration(d.id, [] as never, 't1');
    expect(sql).toBe('CREATE TABLE x ...');
  });

  it('introspect id inesistente → throw', async () => {
    const svc = new DbStudioService();
    await expect(svc.introspect('fake')).rejects.toThrow(/not found/u);
  });
});

describe('quoteTableForEngine — count COUNT(*) anti-injection', () => {
  it('postgres/sqlite/duckdb → doppi apici', () => {
    expect(quoteTableForEngine('postgres', 'users')).toBe('"users"');
    expect(quoteTableForEngine('sqlite', 'orders')).toBe('"orders"');
  });

  it('mysql → backtick · mssql → bracket', () => {
    expect(quoteTableForEngine('mysql', 'users')).toBe('`users`');
    expect(quoteTableForEngine('mssql', 'users')).toBe('[users]');
  });

  it('🚨 escape del carattere di quoting: niente injection dall\'identificatore', () => {
    // " → "" (postgres): un nome ostile non può chiudere l'identificatore.
    expect(quoteTableForEngine('postgres', 'a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
    // ` → `` (mysql)
    expect(quoteTableForEngine('mysql', 'a`b')).toBe('`a``b`');
    // ] → ]] (mssql)
    expect(quoteTableForEngine('mssql', 'a]b')).toBe('[a]]b]');
  });
});

describe('truncatePreview — FK-aware CROSS-DIALECT (fix 2026-06-15)', () => {
  it('mappa references (out) + referencedBy (in) da introspectRelations, rowCount da countRows', async () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    m.executeRaw.mockResolvedValue({ rows: [{ c: 42 }] }); // countRows(products)
    m.introspectRelations.mockResolvedValue([
      { id: 'r1', name: 'fk1', kind: 'many-to-one', fromTable: 'products', fromColumn: 'category_id', toTable: 'categories', toColumn: 'id', onDelete: 'restrict' },
      { id: 'r2', name: 'fk2', kind: 'many-to-one', fromTable: 'orders', fromColumn: 'product_id', toTable: 'products', toColumn: 'id', onDelete: 'cascade' },
      { id: 'r3', name: 'fk3', kind: 'many-to-one', fromTable: 'invoices', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id', onDelete: 'set null' },
    ]);
    const res = await svc.truncatePreview(d.id, 'products', 't1');
    expect(res.table).toBe('products');
    expect(res.rowCount).toBe(42);
    // FK in USCITA da products → categories
    expect(res.references).toEqual([{ targetTable: 'categories', column: 'category_id', targetColumn: 'id', onDelete: 'restrict' }]);
    // FK in ENTRATA su products: orders.product_id (r3 invoices→customers ignorato)
    expect(res.referencedBy).toEqual([{ sourceTable: 'orders', sourceColumn: 'product_id', targetColumn: 'id', onDelete: 'cascade' }]);
    // CROSS-DIALECT: nessuna PRAGMA/sqlite_master — solo introspectRelations.
    expect(m.introspectRelations).toHaveBeenCalled();
  });

  it('engine senza raw SQL (countRows throw) → rowCount 0 best-effort, refs dal grafo', async () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    m.executeRaw.mockRejectedValue(new Error('RAW_SQL_UNSUPPORTED'));
    m.introspectRelations.mockResolvedValue([]);
    const res = await svc.truncatePreview(d.id, 'x', 't1');
    expect(res.rowCount).toBe(0);
    expect(res.references).toEqual([]);
    expect(res.referencedBy).toEqual([]);
  });

  it('onDelete mancante nel grafo → fallback "NO ACTION"', async () => {
    const svc = new DbStudioService();
    const d = svc.create(makeDbInput());
    m.executeRaw.mockResolvedValue({ rows: [{ c: 0 }] });
    m.introspectRelations.mockResolvedValue([
      { id: 'r1', name: 'fk', kind: 'many-to-one', fromTable: 'a', fromColumn: 'b_id', toTable: 'b', toColumn: 'id' },
    ]);
    const res = await svc.truncatePreview(d.id, 'a', 't1');
    expect(res.references[0]?.onDelete).toBe('NO ACTION');
  });

  it('DB inesistente / tenant errato → throw (tenant isolation)', async () => {
    const svc = new DbStudioService();
    svc.create(makeDbInput('tA'));
    await expect(svc.truncatePreview('nope', 'x', 'tB')).rejects.toThrow(/not found/i);
  });
});

describe('redactConnectionSecrets — cross-tenant superadmin (fix 2026-06-15)', () => {
  const secretConn = {
    engine: 'postgres', embedded: false, hostname: 'db.host', port: 5432, database: 'prod', username: 'app',
    passwordSecretRef: 'PLAINTEXT-SUPER-SECRET',
    sshTunnel: { host: 'bastion', port: 22, user: 'svc', privateKeySecretRef: 'PRIVATE-KEY-DATA', passphraseSecretRef: 'PASSPHRASE', hostKeyFingerprint: 'SHA256:abc' },
  };
  function makeSecretInput(tenantId: string): Parameters<DbStudioService['create']>[0] {
    return { tenantId, name: 'extprod', description: '', connection: secretConn, tables: [], relations: [] } as Parameters<DbStudioService['create']>[0];
  }

  it('PURE: redige password + chiavi SSH, preserva i metadati, NON muta l\'input', () => {
    const input = { id: 'x', tenantId: 't', name: 'n', createdAt: '', updatedAt: '', tables: [], relations: [], connection: { ...secretConn } } as unknown as Parameters<typeof redactConnectionSecrets>[0];
    const out = redactConnectionSecrets(input);
    const oc = out.connection as Record<string, unknown>;
    expect(oc.passwordSecretRef).toBe(REDACTED_SECRET);
    expect((oc.sshTunnel as Record<string, unknown>).privateKeySecretRef).toBe(REDACTED_SECRET);
    expect((oc.sshTunnel as Record<string, unknown>).passphraseSecretRef).toBe(REDACTED_SECRET);
    // metadati non-secret preservati
    expect(oc.hostname).toBe('db.host');
    expect(oc.username).toBe('app');
    expect((oc.sshTunnel as Record<string, unknown>).host).toBe('bastion');
    // input NON mutato (no aliasing del segreto reale)
    expect((input.connection as Record<string, unknown>).passwordSecretRef).toBe('PLAINTEXT-SUPER-SECRET');
  });

  it('listAllAcrossTenants → secret REDATTI (no leak password altrui)', () => {
    const svc = new DbStudioService();
    svc.create(makeSecretInput('tA'));
    const all = svc.listAllAcrossTenants();
    const conn = all[0]!.connection as Record<string, unknown>;
    expect(conn.passwordSecretRef).toBe(REDACTED_SECRET);
    expect((conn.sshTunnel as Record<string, unknown>).privateKeySecretRef).toBe(REDACTED_SECRET);
  });

  it('getAnyTenant → secret REDATTI', () => {
    const svc = new DbStudioService();
    const d = svc.create(makeSecretInput('tA'));
    const got = svc.getAnyTenant(d.id)!;
    expect((got.connection as Record<string, unknown>).passwordSecretRef).toBe(REDACTED_SECRET);
  });

  it('get(id, tenant) TENANT-SCOPED → valore STORED cifrato, NON redatto (≠ cross-tenant)', () => {
    // Post encryption-at-rest: get() ritorna il valore a riposo (enc:), NON
    // redatto come cross-tenant. Il connect lo decifra (vedi test encryption),
    // il frontend lo riceve redatto dalla route. Qui proviamo: tenant-scoped
    // NON è redatto a livello service + è il blob cifrato (no plaintext).
    const svc = new DbStudioService();
    const d = svc.create(makeSecretInput('tA'));
    const pw = String((svc.get(d.id, 'tA')!.connection as Record<string, unknown>).passwordSecretRef);
    expect(pw).not.toBe(REDACTED_SECRET);
    expect(pw.startsWith('enc:1:')).toBe(true);
    expect(pw).not.toContain('PLAINTEXT-SUPER-SECRET');
  });
});

describe('encryption-at-rest del passwordSecretRef (fix 2026-06-15)', () => {
  type CreateInput = Parameters<DbStudioService['create']>[0];
  type UpdatePatch = Parameters<DbStudioService['update']>[1];
  function pgInput(tenantId: string, pw: string): CreateInput {
    return {
      tenantId, name: 'ext', description: '',
      connection: { engine: 'postgres', embedded: false, hostname: 'h', port: 5432, database: 'd', username: 'u', passwordSecretRef: pw },
      tables: [], relations: [],
    } as CreateInput;
  }
  function rawSpec(id: string): Record<string, unknown> {
    const row = m.db!.prepare('SELECT spec_json FROM db_studio_databases WHERE id = ?').get(id) as { spec_json: string };
    return JSON.parse(row.spec_json) as Record<string, unknown>;
  }
  function lastConnectConn(): { passwordSecretRef: string; hostname: string } {
    const call = m.connect.mock.calls.at(-1);
    return (call?.[0] as { connection: { passwordSecretRef: string; hostname: string } }).connection;
  }

  it('create: spec_json A RIPOSO non contiene la password in chiaro (enc:)', () => {
    const svc = new DbStudioService();
    const d = svc.create(pgInput('tA', 'SUPER-SECRET-PW'));
    const conn = rawSpec(d.id).connection as Record<string, unknown>;
    expect(String(conn.passwordSecretRef).startsWith('enc:1:')).toBe(true);
    expect(JSON.stringify(rawSpec(d.id))).not.toContain('SUPER-SECRET-PW');
  });

  it('getAdapter (connect) riceve la password DECIFRATA → l\'adapter funziona', async () => {
    const svc = new DbStudioService();
    const d = svc.create(pgInput('tA', 'SUPER-SECRET-PW'));
    await svc.introspect(d.id, 'tA'); // get(sealed) → getAdapter(unseal) → connect
    expect(lastConnectConn().passwordSecretRef).toBe('SUPER-SECRET-PW');
  });

  it('update col sentinel redatto → MANTIENE il secret originale (altri campi aggiornati)', async () => {
    const svc = new DbStudioService();
    const d = svc.create(pgInput('tA', 'ORIGINAL-PW'));
    svc.update(d.id, {
      connection: { engine: 'postgres', embedded: false, hostname: 'h2', port: 5432, database: 'd', username: 'u', passwordSecretRef: REDACTED_SECRET },
    } as UpdatePatch, 'tA');
    // a riposo resta cifrato e niente plaintext
    expect(String((rawSpec(d.id).connection as Record<string, unknown>).passwordSecretRef).startsWith('enc:1:')).toBe(true);
    await svc.introspect(d.id, 'tA');
    expect(lastConnectConn().hostname).toBe('h2');         // campo non-secret aggiornato
    expect(lastConnectConn().passwordSecretRef).toBe('ORIGINAL-PW'); // secret MANTENUTO
  });

  it('update con NUOVA password → cifra la nuova (no plaintext a riposo)', async () => {
    const svc = new DbStudioService();
    const d = svc.create(pgInput('tA', 'ORIGINAL-PW'));
    svc.update(d.id, {
      connection: { engine: 'postgres', embedded: false, hostname: 'h', port: 5432, database: 'd', username: 'u', passwordSecretRef: 'BRAND-NEW-PW' },
    } as UpdatePatch, 'tA');
    expect(JSON.stringify(rawSpec(d.id))).not.toContain('BRAND-NEW-PW');
    await svc.introspect(d.id, 'tA');
    expect(lastConnectConn().passwordSecretRef).toBe('BRAND-NEW-PW');
  });

  it('vault: ref NON viene cifrato (resta vault: a riposo)', () => {
    const svc = new DbStudioService();
    const d = svc.create(pgInput('tA', 'vault:secret/db#pw'));
    expect((rawSpec(d.id).connection as Record<string, unknown>).passwordSecretRef).toBe('vault:secret/db#pw');
  });
});
