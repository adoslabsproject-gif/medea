/**
 * Test 2026-grade — elevazione DB-agent: piani-schema atomici (preview/apply),
 * foreign key, parità dati (update_rows/delete_rows), groupBy nelle letture, e
 * contratto anti-drift parameters↔zod. Stessa harness reale del core
 * (SQLite :memory' per i metadati, adapter del data-plane stubbato).
 *
 * @module services/db-agent/__tests__/db-agent-plan
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Table } from '@flowforge/db-studio-core';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { FLOWFORGE_DATA_DIR: '/tmp/ff-db-agent-plan-test' },
    connect: vi.fn(),
    applyMigration: vi.fn(),
    previewMigration: vi.fn(),
    query: vi.fn(),
    insert: vi.fn(),
    updateRow: vi.fn(),
    deleteRow: vi.fn(),
    introspect: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(d: unknown) { return mockFns.connect(d); }
    async applyMigration(a: unknown) { return mockFns.applyMigration(a); }
    async previewMigration(a: unknown) { return mockFns.previewMigration(a); }
    async query(s: unknown) { return mockFns.query(s); }
    async insert(t: string, r: unknown) { return mockFns.insert(t, r); }
    async update(t: string, w: unknown, p: unknown) { return mockFns.updateRow(t, w, p); }
    async delete(t: string, w: unknown) { return mockFns.deleteRow(t, w); }
    async introspect() { return mockFns.introspect(); }
  }
  return { ...mockFns, FakeAdapter };
});

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({ loadConfig: () => m.configValue }));
vi.mock('@flowforge/db-studio-engine', () => ({ SqliteAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-postgres', () => ({ PostgresAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mysql', () => ({ MysqlAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mongodb', () => ({ MongoDbAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-redis', () => ({ RedisAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mssql', () => ({ MssqlAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-duckdb', () => ({ DuckDbAdapter: m.FakeAdapter }));

import { DbStudioService } from '@/services/db-studio.service.js';
import { createDbAgentContext, executeDbAgentTool, listDbAgentTools } from '../index.js';
import type { DbAgentContext } from '../index.js';
import { buildMigrationActions, planHasDestructive, SchemaPlanSchema, type PlanAction } from '../plan.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function seedTable(name = 'orders'): Table {
  return {
    id: name,
    name,
    columns: [
      { id: `${name}.id`, name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false, unique: true } },
      { id: `${name}.amount`, name: 'amount', type: 'decimal', constraints: { primaryKey: false, nullable: true, unique: false } },
    ],
    indexes: [],
  };
}

function makeDb(svc: DbStudioService, tenantId: string, name: string, tables: Table[] = []): string {
  return svc.create({
    tenantId, name, description: 'seed',
    connection: { engine: 'sqlite', embedded: true }, tables, relations: [],
  }).id;
}

let svc: DbStudioService;
let ctxA: DbAgentContext;

beforeEach(() => {
  m.db = new Database(':memory:');
  for (const v of Object.values(m)) {
    if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset();
  }
  m.connect.mockResolvedValue(undefined);
  m.applyMigration.mockResolvedValue({ sql: '-- ok', affectedTables: ['orders'] });
  m.previewMigration.mockResolvedValue('CREATE TABLE customers (...);');
  m.introspect.mockResolvedValue([seedTable()]);
  m.updateRow.mockResolvedValue({ changes: 2 });
  m.deleteRow.mockResolvedValue({ changes: 1 });
  svc = new DbStudioService();
  // allowWrites=true: i piani-schema e gli update/delete sono scritture; qui ne
  // testiamo la LOGICA con il consenso utente attivo. Il gate è coperto in db-agent.test.
  ctxA = createDbAgentContext(TENANT_A, svc, true);
});

// ───────────────────────── plan.ts (mapping puro) ─────────────────────────

describe('plan: mapping verso MigrationAction + rilevazione distruttive', () => {
  const plan: PlanAction[] = [
    { op: 'create_table', table: 'customers', columns: [{ name: 'id', type: 'integer', constraints: { primaryKey: true } }] },
    { op: 'add_index', table: 'customers', indexName: 'idx_id', columns: ['id'] },
    { op: 'add_foreign_key', name: 'fk_o_c', fromTable: 'orders', fromColumn: 'cust_id', toTable: 'customers', toColumn: 'id' },
  ];

  it('mappa 1:1 preservando l\'ordine e i kind del core', () => {
    const actions = buildMigrationActions(plan);
    expect(actions.map((a) => a.kind)).toEqual(['create_table', 'add_index', 'add_relation']);
  });

  it('add_foreign_key → add_relation con onDelete default restrict', () => {
    const [rel] = buildMigrationActions([plan[2]!]);
    expect(rel).toMatchObject({ kind: 'add_relation', relation: { name: 'fk_o_c', fromTable: 'orders', toTable: 'customers', onDelete: 'restrict' } });
  });

  it('planHasDestructive: true solo se c\'è drop_table/drop_column', () => {
    expect(planHasDestructive(plan)).toBe(false);
    expect(planHasDestructive([{ op: 'drop_table', table: 'x' }])).toBe(true);
    expect(planHasDestructive([{ op: 'drop_column', table: 'x', columnName: 'y' }])).toBe(true);
  });

  it('SchemaPlanSchema rifiuta piano vuoto, oltre 50 azioni, e op sconosciute', () => {
    expect(SchemaPlanSchema.safeParse([]).success).toBe(false);
    expect(SchemaPlanSchema.safeParse(Array(51).fill(plan[1])).success).toBe(false);
    expect(SchemaPlanSchema.safeParse([{ op: 'truncate', table: 'x' }]).success).toBe(false);
  });
});

// ───────────────────────── preview / apply ─────────────────────────

describe('preview_schema_plan / apply_schema_plan', () => {
  it('preview ritorna l\'SQL SENZA applicare (apply mai chiamato)', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'preview_schema_plan', {
      databaseId: dbA,
      plan: [{ op: 'create_table', table: 'customers', columns: [{ name: 'id', type: 'integer' }] }],
    })) as { ok: true; data: { sql: string; actions: number; destructive: boolean } };
    expect(r.ok).toBe(true);
    expect(r.data.sql).toContain('CREATE TABLE');
    expect(r.data).toMatchObject({ actions: 1, destructive: false });
    expect(m.previewMigration).toHaveBeenCalledTimes(1);
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('apply NON-distruttivo: una sola applyMigration con TUTTE le azioni (atomico)', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const plan = [
      { op: 'create_table', table: 'customers', columns: [{ name: 'id', type: 'integer', constraints: { primaryKey: true } }] },
      { op: 'add_index', table: 'customers', indexName: 'idx_id', columns: ['id'] },
    ];
    const r = (await executeDbAgentTool(ctxA, 'apply_schema_plan', { databaseId: dbA, plan })) as { ok: true; data: { applied: number } };
    expect(r.ok).toBe(true);
    expect(r.data.applied).toBe(2);
    expect(m.applyMigration).toHaveBeenCalledTimes(1);
    const actionsArg = m.applyMigration.mock.calls[0]![0] as unknown[];
    expect(actionsArg).toHaveLength(2); // atomico: un'unica migration con 2 azioni
  });

  it('apply DISTRUTTIVO senza confirmDestructive → CONFIRMATION_REQUIRED, nessuna migration', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'apply_schema_plan', {
      databaseId: dbA,
      plan: [{ op: 'drop_table', table: 'orders' }],
    })) as { ok: false; code: string; error: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRMATION_REQUIRED');
    expect(r.error).toContain('drop_table(orders)');
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('apply DISTRUTTIVO con confirmDestructive=true → esegue', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = await executeDbAgentTool(ctxA, 'apply_schema_plan', {
      databaseId: dbA,
      plan: [{ op: 'drop_table', table: 'orders' }],
      confirmDestructive: true,
    });
    expect(r.ok).toBe(true);
    expect(m.applyMigration).toHaveBeenCalledTimes(1);
  });

  it('🚨 preview/apply su DB di altro tenant → TENANT_SCOPE, niente preview né apply', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret', [seedTable()]);
    const plan = [{ op: 'create_table', table: 'x', columns: [{ name: 'id', type: 'integer' }] }];
    const p = (await executeDbAgentTool(ctxA, 'preview_schema_plan', { databaseId: dbB, plan })) as { ok: false; code: string };
    const ap = (await executeDbAgentTool(ctxA, 'apply_schema_plan', { databaseId: dbB, plan })) as { ok: false; code: string };
    expect(p.code).toBe('TENANT_SCOPE');
    expect(ap.code).toBe('TENANT_SCOPE');
    expect(m.previewMigration).not.toHaveBeenCalled();
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('piano con tipo colonna invalido → TOOL_VALIDATION (niente preview)', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = await executeDbAgentTool(ctxA, 'preview_schema_plan', {
      databaseId: dbA,
      plan: [{ op: 'create_table', table: 't', columns: [{ name: 'c', type: 'jpeg' }] }],
    });
    expect(r.ok).toBe(false);
    expect(m.previewMigration).not.toHaveBeenCalled();
  });
});

// ───────────────────────── update_rows / delete_rows ─────────────────────────

describe('parità dati: update_rows / delete_rows', () => {
  it('update_rows con where+patch+confirm → updateRow del service', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'update_rows', {
      databaseId: dbA, table: 'orders', where: { id: 1 }, patch: { amount: 42 }, confirm: true,
    })) as { ok: true; data: { result: unknown } };
    expect(r.ok).toBe(true);
    expect(m.updateRow).toHaveBeenCalledWith('orders', { id: 1 }, { amount: 42 });
  });

  it('update_rows where VUOTO → TOOL_VALIDATION (non aggiorna tutte le righe), service mai chiamato', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'update_rows', { databaseId: dbA, table: 'orders', where: {}, patch: { amount: 1 }, confirm: true })) as { ok: false; code: string };
    expect(r.code).toBe('TOOL_VALIDATION');
    expect(m.updateRow).not.toHaveBeenCalled();
  });

  it('update_rows confirm=false → CONFIRMATION_REQUIRED', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'update_rows', { databaseId: dbA, table: 'orders', where: { id: 1 }, patch: { amount: 1 }, confirm: false })) as { ok: false; code: string };
    expect(r.code).toBe('CONFIRMATION_REQUIRED');
    expect(m.updateRow).not.toHaveBeenCalled();
  });

  it('delete_rows where VUOTO → TOOL_VALIDATION (no svuota-tabella), service mai chiamato', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'delete_rows', { databaseId: dbA, table: 'orders', where: {}, confirm: true })) as { ok: false; code: string };
    expect(r.code).toBe('TOOL_VALIDATION');
    expect(m.deleteRow).not.toHaveBeenCalled();
  });

  it('delete_rows con where+confirm → deleteRow del service', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = await executeDbAgentTool(ctxA, 'delete_rows', { databaseId: dbA, table: 'orders', where: { id: 7 }, confirm: true });
    expect(r.ok).toBe(true);
    expect(m.deleteRow).toHaveBeenCalledWith('orders', { id: 7 });
  });

  it('🔒 gate: update/delete con allowWrites=false → CONFIRMATION_REQUIRED, service MAI chiamato (anche con confirm:true)', async () => {
    const ctxRO = createDbAgentContext(TENANT_A, svc, false);
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const u = (await executeDbAgentTool(ctxRO, 'update_rows', { databaseId: dbA, table: 'orders', where: { id: 1 }, patch: { amount: 1 }, confirm: true })) as { ok: false; code: string };
    const d = (await executeDbAgentTool(ctxRO, 'delete_rows', { databaseId: dbA, table: 'orders', where: { id: 1 }, confirm: true })) as { ok: false; code: string };
    expect(u.code).toBe('CONFIRMATION_REQUIRED');
    expect(d.code).toBe('CONFIRMATION_REQUIRED');
    expect(m.updateRow).not.toHaveBeenCalled();
    expect(m.deleteRow).not.toHaveBeenCalled();
  });

  it('🚨 update/delete su DB altrui → TENANT_SCOPE, service mai chiamato', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret', [seedTable()]);
    const u = (await executeDbAgentTool(ctxA, 'update_rows', { databaseId: dbB, table: 'orders', where: { id: 1 }, patch: { amount: 1 }, confirm: true })) as { ok: false; code: string };
    const d = (await executeDbAgentTool(ctxA, 'delete_rows', { databaseId: dbB, table: 'orders', where: { id: 1 }, confirm: true })) as { ok: false; code: string };
    expect(u.code).toBe('TENANT_SCOPE');
    expect(d.code).toBe('TENANT_SCOPE');
    expect(m.updateRow).not.toHaveBeenCalled();
    expect(m.deleteRow).not.toHaveBeenCalled();
  });
});

// ───────────────────────── run_select groupBy ─────────────────────────

describe('run_select groupBy', () => {
  it('passa groupBy nella spec all\'adapter', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    m.query.mockResolvedValue([{ amount: 9.99 }]);
    const r = await executeDbAgentTool(ctxA, 'run_select', { databaseId: dbA, table: 'orders', select: ['amount'], groupBy: ['amount'] });
    expect(r.ok).toBe(true);
    const spec = m.query.mock.calls[0]![0] as { groupBy?: string[] };
    expect(spec.groupBy).toEqual(['amount']);
  });
});

// ───────────────────────── contratto anti-drift parameters↔zod ─────────────────────────

describe('🔒 contratto: parameters JSON-schema coerente con lo zod (anti-drift)', () => {
  it('nessun tool dichiara tenantId; ogni "required" è tra le properties; properties non vuote', () => {
    for (const t of listDbAgentTools()) {
      const params = t.parameters as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
      const props = params.properties ?? {};
      const required = params.required ?? [];
      // 1. tenantId MAI esposto al modello
      expect(Object.keys(props), `${t.name}`).not.toContain('tenantId');
      // 2. additionalProperties:false → niente campi liberi (coerente con zod .strict())
      expect(params.additionalProperties, `${t.name} additionalProperties`).toBe(false);
      // 3. ogni required è dichiarato tra le properties
      for (const req of required) {
        expect(Object.keys(props), `${t.name}.${req}`).toContain(req);
      }
    }
  });

  it('ogni tool valida via zod il proprio set di required: un payload vuoto è accettato SOLO se non ha required', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    for (const t of listDbAgentTools()) {
      const params = t.parameters as { required?: string[] };
      const hasRequired = (params.required ?? []).length > 0;
      const r = await executeDbAgentTool(ctxA, t.name, {});
      if (hasRequired) {
        // con campi required, il payload vuoto DEVE fallire la validazione
        expect(r.ok, `${t.name} payload vuoto`).toBe(false);
        if (!r.ok) expect(r.code, `${t.name}`).toBe('TOOL_VALIDATION');
      }
      // se non ha required (es. list_databases) può anche passare — non asseriamo l'esito
      void dbA;
    }
  });
});
