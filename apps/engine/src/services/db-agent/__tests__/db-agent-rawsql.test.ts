/**
 * Test 2026-grade — run_sql (lettura raw sola-lettura blindata).
 *
 * Bug-bounty sull'INJECTION: ogni tentativo di scrivere/distruggere/evadere il
 * sandbox sotto mentite spoglie di SELECT deve essere RIFIUTATO PRIMA di toccare
 * il DB (executeRaw MAI chiamato). Harness reale (SQLite :memory' metadati,
 * adapter del data-plane stub con executeRaw controllabile).
 *
 * @module services/db-agent/__tests__/db-agent-rawsql
 */
import type * as DbStudioEngineNS from '@medea/engine-db-studio-engine';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Table } from '@medea/engine-db-studio-core';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { MEDEA_DATA_DIR: '/tmp/ff-db-agent-rawsql-test' },
    connect: vi.fn(),
    executeRaw: vi.fn(),
    introspect: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(d: unknown) { return mockFns.connect(d); }
    async applyMigration() { return { sql: '', affectedTables: [] }; }
    async previewMigration() { return ''; }
    async query() { return []; }
    executeRaw = (sql: string, opts: unknown) => mockFns.executeRaw(sql, opts) as unknown;
    async insert() { return {}; }
    async update() { return {}; }
    async delete() { return {}; }
    async introspect() { return mockFns.introspect(); }
  }
  return { ...mockFns, FakeAdapter };
});

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({ loadConfig: () => m.configValue }));
vi.mock('@medea/engine-db-studio-engine', async (importOriginal) => {
  // IMPORTANTE: NON mockare classifyStatement/assertSafeRawStatement — sono la
  // guardia sotto test. Mockiamo SOLO l'adapter (per non aprire file reali).
  const real = await importOriginal<typeof DbStudioEngineNS>();
  return { ...real, SqliteAdapter: m.FakeAdapter };
});
vi.mock('@medea/engine-db-studio-postgres', () => ({ PostgresAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mysql', () => ({ MysqlAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mongodb', () => ({ MongoDbAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-redis', () => ({ RedisAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-mssql', () => ({ MssqlAdapter: m.FakeAdapter }));
vi.mock('@medea/engine-db-studio-duckdb', () => ({ DuckDbAdapter: m.FakeAdapter }));

import { DbStudioService } from '@/services/db-studio.service.js';
import { createDbAgentContext, executeDbAgentTool } from '../index.js';
import type { DbAgentContext } from '../index.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function seedTable(name = 'orders'): Table {
  return { id: name, name, columns: [{ id: `${name}.id`, name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: true } }], indexes: [] };
}
function makeDb(svc: DbStudioService, tenantId: string, name: string, tables: Table[] = []): string {
  return svc.create({ tenantId, name, description: 'seed', connection: { engine: 'sqlite', embedded: true }, tables, relations: [] }).id;
}

let svc: DbStudioService;
let ctxA: DbAgentContext;
let dbA: string;

beforeEach(() => {
  m.db = new Database(':memory:');
  for (const v of Object.values(m)) {
    if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset();
  }
  m.connect.mockResolvedValue(undefined);
  m.introspect.mockResolvedValue([seedTable()]);
  m.executeRaw.mockReturnValue({ statementKind: 'select', rows: [{ id: 1 }], rolledBack: false });
  svc = new DbStudioService();
  ctxA = createDbAgentContext(TENANT_A, svc);
  dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
});

describe('run_sql — happy path lettura', () => {
  it('SELECT valido → executeRaw chiamato con rowLimit, ritorna le righe', async () => {
    const r = (await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql: 'SELECT * FROM orders', rowLimit: 50 })) as { ok: true; data: unknown };
    expect(r.ok).toBe(true);
    expect(m.executeRaw).toHaveBeenCalledTimes(1);
    const [sql, opts] = m.executeRaw.mock.calls[0]!;
    expect(sql).toBe('SELECT * FROM orders');
    expect(opts).toMatchObject({ dryRun: false, rowLimit: 50 });
  });

  it('EXPLAIN consentito', async () => {
    const r = await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql: 'EXPLAIN QUERY PLAN SELECT 1' });
    expect(r.ok).toBe(true);
  });

  it('rowLimit default applicato se omesso', async () => {
    await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql: 'SELECT 1' });
    expect(m.executeRaw.mock.calls[0]![1]).toMatchObject({ rowLimit: 200 });
  });
});

describe('🚨 run_sql — bug-bounty injection (executeRaw MAI chiamato)', () => {
  const blocked: [string, string][] = [
    ['DROP nascosta dopo SELECT', 'SELECT 1; DROP TABLE orders'],
    ['DELETE diretto', 'DELETE FROM orders'],
    ['UPDATE diretto', 'UPDATE orders SET id = 2'],
    ['INSERT diretto', "INSERT INTO orders (id) VALUES (9)"],
    ['DDL CREATE', 'CREATE TABLE evil (x int)'],
    ['DDL ALTER', 'ALTER TABLE orders ADD COLUMN leak text'],
    ['TRUNCATE', 'TRUNCATE TABLE orders'],
    ['CTE modificante (DELETE)', 'WITH d AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM d'],
    // BYPASS revisore 2026-06-14: DML PRIMARIO dopo CTE benigno (pre-fix passava come 'select').
    ['CTE benigno + DELETE primario', 'WITH x AS (SELECT 1) DELETE FROM orders WHERE id > 0'],
    ['CTE benigno + UPDATE primario', 'WITH x AS (SELECT 1) UPDATE orders SET id = 2'],
    ['CTE multipli + DELETE primario', 'WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM orders'],
    ['multi-statement select+update', 'SELECT 1; UPDATE orders SET id=2'],
    ['verbo ignoto (PRAGMA/VACUUM)', 'VACUUM'],
    ['commento iniziale poi DROP', '/* innocuo */ DROP TABLE orders'],
  ];
  for (const [label, sql] of blocked) {
    it(`rifiuta: ${label}`, async () => {
      const r = (await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql })) as { ok: false; code: string };
      expect(r.ok, sql).toBe(false);
      expect(r.code, sql).toBe('TOOL_VALIDATION');
      expect(m.executeRaw, sql).not.toHaveBeenCalled();
    });
  }

  const fsEscape: [string, string][] = [
    ['ATTACH filesystem', "ATTACH DATABASE '/etc/passwd' AS x"],
    ['VACUUM INTO exfil', "VACUUM INTO '/tmp/leak.db'"],
    ['load_extension in SELECT (resta select!)', "SELECT load_extension('/tmp/evil.so')"],
  ];
  for (const [label, sql] of fsEscape) {
    it(`rifiuta filesystem-escape: ${label}`, async () => {
      const r = (await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql })) as { ok: false; code: string };
      expect(r.ok, sql).toBe(false);
      expect(r.code, sql).toBe('TOOL_VALIDATION');
      expect(m.executeRaw, sql).not.toHaveBeenCalled();
    });
  }

  it('🚨 SELECT valido ma su DB di un altro tenant → TENANT_SCOPE, executeRaw mai chiamato', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbB, sql: 'SELECT * FROM orders' })) as { ok: false; code: string };
    expect(r.code).toBe('TENANT_SCOPE');
    expect(m.executeRaw).not.toHaveBeenCalled();
  });

  it('sql vuoto / oltre il cap → TOOL_VALIDATION', async () => {
    expect((await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql: '' })).ok).toBe(false);
    expect((await executeDbAgentTool(ctxA, 'run_sql', { databaseId: dbA, sql: `SELECT '${'x'.repeat(20_001)}'` })).ok).toBe(false);
    expect(m.executeRaw).not.toHaveBeenCalled();
  });
});
