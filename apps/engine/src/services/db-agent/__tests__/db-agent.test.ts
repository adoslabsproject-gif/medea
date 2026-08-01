/**
 * Test 2026-grade del DB-agent di Liara — caratterizzazione + bug-bounty +
 * isolamento tenant, su SQLite `:memory:` REALE (metadati = la superficie dove
 * vive l'isolamento) con adapter del data-plane stubbato (niente binari nativi).
 *
 * Filosofia: l'isolamento NON è asserito guardando il codice, ma TENTANDO di
 * romperlo da ogni angolo (id cross-tenant, tenantId iniettato, drop senza
 * conferma, tipi invalidi, tool ignoti) e pretendendo il rifiuto.
 *
 * @module services/db-agent/__tests__/db-agent
 */
import type * as DbStudioEngineNS from '@flowforge/db-studio-engine';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Table } from '@flowforge/db-studio-core';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { FLOWFORGE_DATA_DIR: '/tmp/ff-db-agent-test' },
    connect: vi.fn(),
    applyMigration: vi.fn(),
    query: vi.fn(),
    insert: vi.fn(),
    introspect: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(d: unknown) { return mockFns.connect(d); }
    async applyMigration(a: unknown) { return mockFns.applyMigration(a); }
    async previewMigration() { return '-- preview'; }
    async query(s: unknown) { return mockFns.query(s); }
    async insert(t: string, r: unknown) { return mockFns.insert(t, r); }
    async update() { return { changes: 0 }; }
    async delete() { return { changes: 0 }; }
    async introspect() { return mockFns.introspect(); }
  }
  return { ...mockFns, FakeAdapter };
});

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: m.db! }) }));
vi.mock('@/lib/logger.js');
vi.mock('@/config.js', () => ({ loadConfig: () => m.configValue }));
// Manteniamo le funzioni REALI dell'engine (classifyStatement, assertSingleStatement,
// assertSafeRawStatement — usate dai tool run_sql/create_view per blindare il
// read-only) e sostituiamo SOLO l'adapter con il fake.
vi.mock('@flowforge/db-studio-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof DbStudioEngineNS>();
  return { ...actual, SqliteAdapter: m.FakeAdapter };
});
vi.mock('@flowforge/db-studio-postgres', () => ({ PostgresAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mysql', () => ({ MysqlAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mongodb', () => ({ MongoDbAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-redis', () => ({ RedisAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-mssql', () => ({ MssqlAdapter: m.FakeAdapter }));
vi.mock('@flowforge/db-studio-duckdb', () => ({ DuckDbAdapter: m.FakeAdapter }));

// Managed provisioning: mock del client portal (niente container reale). Il
// gate allowWrites e l'instradamento engine sono verificati senza Docker.
const mm = vi.hoisted(() => ({ provision: vi.fn() }));
vi.mock('@/services/db-studio/managed-db-client.js', () => ({
  isManagedEngine: (e: string) => ['postgres', 'pgvector', 'mysql', 'mssql', 'mongodb', 'redis', 'qdrant'].includes(e),
  provisionManagedDb: mm.provision,
  ManagedDbError: class ManagedDbError extends Error {},
}));

import { DbStudioService } from '@/services/db-studio.service.js';
import { createDbAgentContext, executeDbAgentTool, listDbAgentTools, isDestructiveTool } from '../index.js';
import type { DbAgentContext } from '../index.js';

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
  const d = svc.create({
    tenantId,
    name,
    description: 'seed',
    connection: { engine: 'sqlite', embedded: true },
    tables,
    relations: [],
  });
  return d.id;
}

let svc: DbStudioService;
let ctxA: DbAgentContext;
let ctxB: DbAgentContext;

beforeEach(() => {
  m.db = new Database(':memory:');
  for (const v of Object.values(m)) {
    if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset();
  }
  m.connect.mockResolvedValue(undefined);
  m.applyMigration.mockResolvedValue({ sql: '-- ok', affectedTables: [] });
  m.introspect.mockResolvedValue([]); // manifest sync no-op di default
  m.query.mockResolvedValue([{ id: 1, amount: 9.99 }]);
  m.insert.mockResolvedValue({ id: 1 });
  svc = new DbStudioService();
  // allowWrites=true: questo file testa la LOGICA dei tool (incl. distruttivi) e
  // l'isolamento tenant ASSUMENDO che l'utente abbia autorizzato le scritture.
  // Il GATE allowWrites (default false) è coperto a parte, sotto.
  ctxA = createDbAgentContext(TENANT_A, svc, true);
  ctxB = createDbAgentContext(TENANT_B, svc, true);
});

// ───────────────────────── contesto ─────────────────────────

describe('createDbAgentContext', () => {
  it('rifiuta tenant vuoto o whitespace', () => {
    expect(() => createDbAgentContext('', svc)).toThrow(/tenant/i);
    expect(() => createDbAgentContext('   ', svc)).toThrow(/tenant/i);
  });

  it('congela il contesto: tenantId non riscrivibile a runtime', () => {
    const ctx = createDbAgentContext(TENANT_A, svc);
    expect(() => {
      (ctx as { tenantId: string }).tenantId = TENANT_B;
    }).toThrow();
    expect(ctx.tenantId).toBe(TENANT_A);
  });

  it('trim del tenant', () => {
    expect(createDbAgentContext('  t1  ', svc).tenantId).toBe('t1');
  });
});

// ───────────────────────── 🚨 ISOLAMENTO TENANT (cuore) ─────────────────────────

describe('🚨 isolamento tenant — Liara non vede né tocca DB altrui', () => {
  it('read_db_schema su DB di un altro tenant → TENANT_SCOPE (msg anti-enumeration)', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret_b', [seedTable()]);
    const r = await executeDbAgentTool(ctxA, 'read_db_schema', { databaseId: dbB });
    expect(r).toEqual({ ok: false, code: 'TENANT_SCOPE', error: expect.stringContaining('non trovato nel tuo workspace') });
  });

  it('messaggio IDENTICO per DB altrui e DB inesistente (no enumeration)', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret_b');
    const other = (await executeDbAgentTool(ctxA, 'read_db_schema', { databaseId: dbB })) as { error: string };
    const ghost = (await executeDbAgentTool(ctxA, 'read_db_schema', { databaseId: 'db-inesistente-xyz' })) as { error: string };
    // Stesso prefisso, cambia solo l'id citato → nessun segnale di esistenza.
    expect(other.error.replace(dbB, 'X')).toBe(ghost.error.replace('db-inesistente-xyz', 'X'));
  });

  it('list_databases ritorna SOLO i DB del proprio tenant', async () => {
    makeDb(svc, TENANT_A, 'mine_1');
    makeDb(svc, TENANT_A, 'mine_2');
    makeDb(svc, TENANT_B, 'theirs');
    const r = (await executeDbAgentTool(ctxA, 'list_databases', {})) as { ok: true; data: { name: string }[] };
    expect(r.ok).toBe(true);
    expect(r.data.map((d) => d.name).sort()).toEqual(['mine_1', 'mine_2']);
  });

  it('OGNI tool di scrittura su DB altrui → TENANT_SCOPE e adapter MAI chiamato', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret_b', [seedTable()]);
    const attempts: [string, Record<string, unknown>][] = [
      ['create_table', { databaseId: dbB, name: 'evil', columns: [{ name: 'x', type: 'text' }] }],
      ['add_column', { databaseId: dbB, table: 'orders', column: { name: 'leak', type: 'text' } }],
      ['drop_column', { databaseId: dbB, table: 'orders', columnName: 'amount', confirm: true }],
      ['drop_table', { databaseId: dbB, tableName: 'orders', confirmTableName: 'orders' }],
      ['add_index', { databaseId: dbB, table: 'orders', indexName: 'idx_x', columns: ['amount'] }],
      ['insert_row', { databaseId: dbB, table: 'orders', row: { amount: 1 } }],
      ['run_select', { databaseId: dbB, table: 'orders' }],
    ];
    for (const [tool, args] of attempts) {
      const r = (await executeDbAgentTool(ctxA, tool, args));
      expect(r.ok, `${tool} doveva essere rifiutato`).toBe(false);
      if (!r.ok) expect(r.code, `${tool} codice`).toBe('TENANT_SCOPE');
    }
    expect(m.applyMigration).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.query).not.toHaveBeenCalled();
  });

  it('tenantId iniettato negli args → TOOL_VALIDATION (strict), non viene MAI onorato', async () => {
    const dbB = makeDb(svc, TENANT_B, 'secret_b', [seedTable()]);
    // Anche se il modello prova a "spacciarsi" per tenant B passando tenantId.
    const r = (await executeDbAgentTool(ctxA, 'read_db_schema', { databaseId: dbB, tenantId: TENANT_B }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOOL_VALIDATION');
  });

  it('create_database crea SEMPRE nel tenant del contesto, mai altrove', async () => {
    const r = (await executeDbAgentTool(ctxA, 'create_database', { name: 'fresh' })) as { ok: true; data: { databaseId: string } };
    expect(r.ok).toBe(true);
    // Visibile ad A, invisibile a B.
    const listA = (await executeDbAgentTool(ctxA, 'list_databases', {})) as { data: { name: string }[] };
    const listB = (await executeDbAgentTool(ctxB, 'list_databases', {})) as { data: { name: string }[] };
    expect(listA.data.map((d) => d.name)).toContain('fresh');
    expect(listB.data.map((d) => d.name)).not.toContain('fresh');
  });
});

// ───────── create_database: engine + managed (blocco 2) ─────────
describe('create_database — engine embedded + provisioning managed', () => {
  beforeEach(() => { mm.provision.mockReset(); });

  it('engine omesso → sqlite embedded di default, nessun provisioning', async () => {
    const r = (await executeDbAgentTool(ctxA, 'create_database', { name: 'plain' })) as { ok: true; data: { engine: string; managed: boolean } };
    expect(r.ok).toBe(true);
    expect(r.data.engine).toBe('sqlite');
    expect(r.data.managed).toBe(false);
    expect(mm.provision).not.toHaveBeenCalled();
  });

  it('managed=true + allowWrites → provisiona il sidecar e crea il DB managed', async () => {
    mm.provision.mockResolvedValueOnce({ engine: 'postgres', host: 'ff-db-postgres-a', port: 5432, database: 'app', username: 'u', password: 'p' });
    const r = (await executeDbAgentTool(ctxA, 'create_database', { name: 'crm', engine: 'postgres', managed: true })) as { ok: true; data: { managed: boolean; engine: string } };
    expect(r.ok).toBe(true);
    expect(mm.provision).toHaveBeenCalledWith(TENANT_A, 'postgres');
    expect(r.data.managed).toBe(true);
    expect(r.data.engine).toBe('postgres');
  });

  it('🔒 managed=true SENZA allowWrites (sola lettura) → CONFIRMATION_REQUIRED, nessun provisioning', async () => {
    const ctxRO = createDbAgentContext(TENANT_A, svc, false);
    const r = (await executeDbAgentTool(ctxRO, 'create_database', { name: 'crm', engine: 'postgres', managed: true })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRMATION_REQUIRED');
    expect(mm.provision).not.toHaveBeenCalled();
  });

  it('🚨 engine server SENZA managed → TOOL_VALIDATION (no credenziali inventate), no provisioning', async () => {
    const r = (await executeDbAgentTool(ctxA, 'create_database', { name: 'x', engine: 'postgres' })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOOL_VALIDATION');
    expect(mm.provision).not.toHaveBeenCalled();
  });

  it('🚨 engine sconosciuto → TOOL_VALIDATION (zod enum), mai eseguito', async () => {
    const r = (await executeDbAgentTool(ctxA, 'create_database', { name: 'x', engine: 'oracle' })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOOL_VALIDATION');
  });
});

// ───────── create_view / drop_view (blocco 4: SQL avanzato) ─────────
describe('create_view / drop_view — VIEW read-only blindate', () => {
  beforeEach(() => { m.applyMigration.mockResolvedValue({ sql: '', affectedTables: [] }); });

  async function freshSqliteDb(): Promise<string> {
    const r = (await executeDbAgentTool(ctxA, 'create_database', { name: 'viewdb' })) as { ok: true; data: { databaseId: string } };
    return r.data.databaseId;
  }

  it('create_view valido (SELECT) → ok + applyMigration con kind create_view', async () => {
    const id = await freshSqliteDb();
    m.applyMigration.mockClear();
    const r = (await executeDbAgentTool(ctxA, 'create_view', { databaseId: id, name: 'attivi', select: 'SELECT * FROM orders WHERE total >= 100' })) as { ok: boolean; data?: { created: string } };
    expect(r.ok).toBe(true);
    expect(r.data?.created).toBe('attivi');
    const actions = m.applyMigration.mock.calls.at(-1)?.[0] as { kind: string; view?: { name: string } }[];
    expect(actions[0]?.kind).toBe('create_view');
    expect(actions[0]?.view?.name).toBe('attivi');
  });

  it('🚨 SELECT che NASCONDE una scrittura (CTE DELETE) → TOOL_VALIDATION, applyMigration MAI', async () => {
    const id = await freshSqliteDb();
    m.applyMigration.mockClear();
    const r = (await executeDbAgentTool(ctxA, 'create_view', { databaseId: id, name: 'v', select: 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d' })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOOL_VALIDATION');
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('🚨 multi-statement (SELECT 1; DROP TABLE) → TOOL_VALIDATION', async () => {
    const id = await freshSqliteDb();
    const r = (await executeDbAgentTool(ctxA, 'create_view', { databaseId: id, name: 'v', select: 'SELECT 1; DROP TABLE orders' })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOOL_VALIDATION');
  });

  it('🚨 view su engine NON relazionale (mongodb) → TOOL_VALIDATION', async () => {
    const mongo = svc.create({ tenantId: TENANT_A, name: 'mongodb-db', description: 'd', connection: { engine: 'mongodb', embedded: false }, tables: [], relations: [] }).id;
    const r = (await executeDbAgentTool(ctxA, 'create_view', { databaseId: mongo, name: 'v', select: 'SELECT 1' })) as { ok: false; code: string; error: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOOL_VALIDATION');
    expect(r.error).toMatch(/mongodb/u);
  });

  it('🚨 create_view su DB di un altro tenant → TENANT_SCOPE', async () => {
    const other = svc.create({ tenantId: TENANT_B, name: 'b', description: 'd', connection: { engine: 'sqlite', embedded: true }, tables: [], relations: [] }).id;
    const r = (await executeDbAgentTool(ctxA, 'create_view', { databaseId: other, name: 'v', select: 'SELECT 1' })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TENANT_SCOPE');
  });

  it('🔒 drop_view senza confirmViewName combaciante → CONFIRMATION_REQUIRED', async () => {
    const id = await freshSqliteDb();
    const r = (await executeDbAgentTool(ctxA, 'drop_view', { databaseId: id, viewName: 'attivi', confirmViewName: 'sbagliato' })) as { ok: false; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('drop_view con conferma corretta → ok', async () => {
    const id = await freshSqliteDb();
    const r = (await executeDbAgentTool(ctxA, 'drop_view', { databaseId: id, viewName: 'attivi', confirmViewName: 'attivi' })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it('gate: create_view NON gated (additivo), drop_view gated (destructive)', () => {
    expect(isDestructiveTool('create_view')).toBe(false);
    expect(isDestructiveTool('drop_view')).toBe(true);
  });

  it('i tool view sono registrati', () => {
    const names = listDbAgentTools().map((t) => t.name);
    expect(names).toContain('create_view');
    expect(names).toContain('drop_view');
  });
});

// ───────────────────────── happy path (tenant proprio) ─────────────────────────

describe('operazioni nel proprio tenant', () => {
  it('create_table chiama applyMigration con la create_table action + colonne costruite', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app');
    const r = (await executeDbAgentTool(ctxA, 'create_table', {
      databaseId: dbA,
      name: 'customers',
      columns: [
        { name: 'id', type: 'integer', constraints: { primaryKey: true, nullable: false } },
        { name: 'email', type: 'text' },
      ],
    }));
    expect(r).toEqual({ ok: true, data: { created: 'customers', columns: 2 } });
    expect(m.applyMigration).toHaveBeenCalledTimes(1);
    const action = (m.applyMigration.mock.calls[0]![0] as unknown[])[0] as { kind: string; table: Table };
    expect(action.kind).toBe('create_table');
    expect(action.table.columns[1]).toMatchObject({ id: 'customers.email', name: 'email', type: 'text' });
    // default constraints applicati
    expect(action.table.columns[1]!.constraints).toMatchObject({ nullable: true, unique: false, primaryKey: false });
  });

  it('add_column / add_index / insert_row funzionano su tabella esistente', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    // applyMigration risincronizza il manifest da introspect(): qui l'adapter
    // "vede" ancora la tabella orders, così resta nel manifest tra un'op e l'altra.
    m.introspect.mockResolvedValue([seedTable()]);
    expect((await executeDbAgentTool(ctxA, 'add_column', { databaseId: dbA, table: 'orders', column: { name: 'note', type: 'text' } })).ok).toBe(true);
    expect((await executeDbAgentTool(ctxA, 'add_index', { databaseId: dbA, table: 'orders', indexName: 'idx_amount', columns: ['amount'] })).ok).toBe(true);
    const ins = (await executeDbAgentTool(ctxA, 'insert_row', { databaseId: dbA, table: 'orders', row: { amount: 5 } }));
    expect(ins.ok).toBe(true);
    expect(m.insert).toHaveBeenCalledWith('orders', { amount: 5 });
  });

  it('run_select passa la spec all\'adapter e ritorna le righe', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'run_select', { databaseId: dbA, table: 'orders', limit: 10 })) as { ok: true; data: unknown };
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([{ id: 1, amount: 9.99 }]);
    const spec = m.query.mock.calls[0]![0] as { table: string; limit: number };
    expect(spec).toMatchObject({ table: 'orders', limit: 10 });
  });

  it('read_db_schema riflette il manifest del DB posseduto', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'read_db_schema', { databaseId: dbA })) as { ok: true; data: { tables: { name: string; columns: unknown[] }[] } };
    expect(r.ok).toBe(true);
    expect(r.data.tables[0]!.name).toBe('orders');
    expect(r.data.tables[0]!.columns).toHaveLength(2);
  });
});

// ───────────────────────── conferme distruttive ─────────────────────────

describe('operazioni distruttive richiedono conferma esplicita', () => {
  it('drop_table senza confirmTableName combaciante → CONFIRMATION_REQUIRED, nessuna migration', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'drop_table', { databaseId: dbA, tableName: 'orders', confirmTableName: 'sbagliato' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONFIRMATION_REQUIRED');
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('drop_table con conferma esatta → esegue', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = await executeDbAgentTool(ctxA, 'drop_table', { databaseId: dbA, tableName: 'orders', confirmTableName: 'orders' });
    expect(r.ok).toBe(true);
    expect(m.applyMigration).toHaveBeenCalledTimes(1);
  });

  it('drop_column con confirm=false → CONFIRMATION_REQUIRED, nessuna migration', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = (await executeDbAgentTool(ctxA, 'drop_column', { databaseId: dbA, table: 'orders', columnName: 'amount', confirm: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONFIRMATION_REQUIRED');
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('isDestructiveTool marca solo drop_*', () => {
    expect(isDestructiveTool('drop_table')).toBe(true);
    expect(isDestructiveTool('drop_column')).toBe(true);
    expect(isDestructiveTool('create_table')).toBe(false);
    expect(isDestructiveTool('insert_row')).toBe(false);
  });
});

// ─────────── GATE SCRITTURE human-in-the-loop (revisore 2026-06-14) ───────────
describe('🔒 gate allowWrites — scritture solo con consenso esplicito utente', () => {
  // Contesto READ-ONLY (allowWrites=false, il DEFAULT): simula la richiesta
  // senza il toggle "Consenti modifiche". Un prompt-injection nei dati del DB
  // che convincesse l'LLM a chiamare un tool distruttivo NON deve poter scrivere.
  let ctxRO: DbAgentContext;
  let dbA: string;
  beforeEach(() => {
    ctxRO = createDbAgentContext(TENANT_A, svc, false);
    dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
  });

  const destructive: [string, Record<string, unknown>][] = [
    ['update_rows', { databaseId: '__DB__', table: 'orders', where: { id: 1 }, patch: { amount: 9 }, confirm: true }],
    ['delete_rows', { databaseId: '__DB__', table: 'orders', where: { id: 1 }, confirm: true }],
    ['drop_table', { databaseId: '__DB__', tableName: 'orders', confirmTableName: 'orders' }],
    ['drop_column', { databaseId: '__DB__', table: 'orders', columnName: 'amount', confirm: true }],
    ['apply_schema_plan', { databaseId: '__DB__', plan: [{ op: 'drop_table', table: 'orders' }] }],
  ];

  for (const [tool, args] of destructive) {
    it(`🔒 ${tool} con allowWrites=false → CONFIRMATION_REQUIRED, adapter MAI chiamato (anche con confirm:true dell'LLM)`, async () => {
      const a = { ...args, databaseId: dbA };
      const r = await executeDbAgentTool(ctxRO, tool, a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('CONFIRMATION_REQUIRED');
      // Prova che NESSUNA migration di schema è arrivata all'adapter (il gate è
      // PRIMA dell'handler). Per update/delete la prova "service non chiamato" è
      // in db-agent-plan.test (lì il mock espone update/deleteRow).
      expect(m.applyMigration).not.toHaveBeenCalled();
    });
  }

  it('gli stessi tool con allowWrites=true → superano il gate (poi seguono la propria validazione)', async () => {
    const r = await executeDbAgentTool(ctxA, 'delete_rows', { databaseId: dbA, table: 'orders', where: { id: 1 }, confirm: true });
    expect(r.ok, 'delete_rows con consenso non deve essere bloccato dal gate').toBe(true);
  });

  it('i tool di LETTURA e ADDITIVI non sono gated (girano anche con allowWrites=false)', async () => {
    expect((await executeDbAgentTool(ctxRO, 'run_select', { databaseId: dbA, table: 'orders' })).ok).toBe(true);
    expect((await executeDbAgentTool(ctxRO, 'insert_row', { databaseId: dbA, table: 'orders', row: { amount: 1 } })).ok).toBe(true);
    expect((await executeDbAgentTool(ctxRO, 'create_table', { databaseId: dbA, name: 'c', columns: [{ name: 'id', type: 'integer' }] })).ok).toBe(true);
  });
});

// ───────────────────────── validazione / robustezza executor ─────────────────────────

describe('validazione e robustezza', () => {
  it('tool sconosciuto → UNKNOWN_TOOL (no throw)', async () => {
    const r = (await executeDbAgentTool(ctxA, 'rm_minus_rf', {}));
    expect(r).toEqual({ ok: false, code: 'UNKNOWN_TOOL', error: expect.stringContaining('rm_minus_rf') });
  });

  it('tipo colonna invalido → TOOL_VALIDATION (no coercizione silenziosa)', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app');
    const r = (await executeDbAgentTool(ctxA, 'create_table', { databaseId: dbA, name: 't', columns: [{ name: 'c', type: 'supertext' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOOL_VALIDATION');
    expect(m.applyMigration).not.toHaveBeenCalled();
  });

  it('nome colonna non snake_case → TOOL_VALIDATION', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app');
    const r = await executeDbAgentTool(ctxA, 'create_table', { databaseId: dbA, name: 't', columns: [{ name: 'MixedCase', type: 'text' }] });
    expect(r.ok).toBe(false);
  });

  it('run_select limit oltre il cap → TOOL_VALIDATION', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const r = await executeDbAgentTool(ctxA, 'run_select', { databaseId: dbA, table: 'orders', limit: 999_999 });
    expect(r.ok).toBe(false);
  });

  it('run_select / insert_row su tabella inesistente → TOOL_VALIDATION (manifest)', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    const sel = (await executeDbAgentTool(ctxA, 'run_select', { databaseId: dbA, table: 'ghost' }));
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.code).toBe('TOOL_VALIDATION');
    expect(m.query).not.toHaveBeenCalled();
  });

  it('executor non lancia MAI: un throw dell\'adapter diventa INTERNAL', async () => {
    const dbA = makeDb(svc, TENANT_A, 'app', [seedTable()]);
    m.insert.mockRejectedValueOnce(new Error('disk full'));
    const r = (await executeDbAgentTool(ctxA, 'insert_row', { databaseId: dbA, table: 'orders', row: { amount: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('INTERNAL'); expect(r.error).toContain('disk full'); }
  });

  it('args mancanti (databaseId) → TOOL_VALIDATION', async () => {
    const r = await executeDbAgentTool(ctxA, 'read_db_schema', {});
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────── metadati per LLM ─────────────────────────

describe('listDbAgentTools (advertising LLM)', () => {
  it('espone i 17 tool con nome/descrizione/parameters JSON-schema', () => {
    const tools = listDbAgentTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_column', 'add_index', 'apply_schema_plan', 'create_database', 'create_table',
        'create_view', 'delete_rows', 'drop_column', 'drop_table', 'drop_view', 'insert_row',
        'list_databases', 'preview_schema_plan', 'read_db_schema', 'run_select', 'run_sql', 'update_rows',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('nessun tool espone un parametro tenantId (il tenant non è mai negoziabile dal modello)', () => {
    for (const t of listDbAgentTools()) {
      const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props)).not.toContain('tenantId');
    }
  });
});
