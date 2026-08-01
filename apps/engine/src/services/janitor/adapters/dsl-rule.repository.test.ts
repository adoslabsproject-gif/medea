/**
 * Test 2026-grade — adapters/dsl-rule.repository.ts (DSL rules CRUD).
 *
 * 🚨 PK SINGOLO (id): upsert atomico, listForTenant filtra solo own.
 *    Bug = leak DSL cross-tenant.
 *
 * 🚨 DELETE COMPOSTO (id + tenantId): protezione contro delete cross-tenant
 *    se chiamante UI passa solo l'id (defense-in-depth).
 *
 * 🚨 JSON COLS (placeholders, tags): resilient parse → fallback frozen empty.
 *    Bug = JSON corrotto crasha listAll → tutte le DSL vanno offline.
 *
 * 🚨 TAGS array: filtra non-string elements (no leak object/null in array).
 *
 * 🚨 IMMUTABILITY: output frozen + placeholders frozen + tags frozen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type { DslRule } from '@/services/janitor/domain/index.js';

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock('@/storage/db.js', () => ({
  getDatabase: getDatabaseMock,
}));

const { DslRuleRepository } = await import('./dsl-rule.repository.js');
const { janitorDslRules } = await import('@/storage/schema.js');

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let repo: InstanceType<typeof DslRuleRepository>;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE janitor_dsl_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      data_source_ref TEXT NOT NULL,
      target_table TEXT NOT NULL,
      target_pk_column TEXT NOT NULL,
      detect_sql TEXT NOT NULL,
      repair_sql TEXT,
      placeholders_json TEXT NOT NULL DEFAULT '{}',
      tags_json TEXT NOT NULL DEFAULT '[]',
      default_severity TEXT NOT NULL,
      default_schedule TEXT NOT NULL,
      default_max_rows_per_run INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );
  `);
  db = drizzle(sqlite, { schema: { janitorDslRules } });
  getDatabaseMock.mockReturnValue({ db, conn: sqlite, kind: 'sqlite', close: () => Promise.resolve() });
  repo = new DslRuleRepository();
});

const mkDsl = (over: Partial<DslRule> = {}): DslRule => ({
  kind: 'dsl',
  id: over.id ?? 'dsl_abc123',
  tenantId: over.tenantId ?? 't1',
  title: over.title ?? 'Test DSL Rule',
  description: over.description ?? 'desc',
  dataSourceRef: over.dataSourceRef ?? SYSTEM_REF,
  targetTable: over.targetTable ?? 'runs',
  targetPkColumn: over.targetPkColumn ?? 'id',
  detectSql: over.detectSql ?? 'SELECT id FROM runs WHERE status = $1',
  ...(over.repairSql ? { repairSql: over.repairSql } : {}),
  placeholders: over.placeholders ?? { status: 'failed' },
  tags: over.tags ?? ['critical'],
  defaultSeverity: over.defaultSeverity ?? 'critical',
  defaultSchedule: over.defaultSchedule ?? '0 * * * *',
  defaultMaxRowsPerRun: over.defaultMaxRowsPerRun ?? 100,
  createdAt: over.createdAt ?? '2026-06-08T00:00:00Z',
  updatedAt: over.updatedAt ?? '2026-06-08T00:00:00Z',
  ...(over.createdBy ? { createdBy: over.createdBy } : {}),
});

describe('🚨 upsert + get round-trip', () => {
  it('🚨 upsert + get ritorna esatto', async () => {
    await repo.upsert(mkDsl());
    const out = await repo.get('dsl_abc123');
    expect(out).not.toBeNull();
    expect(out!.id).toBe('dsl_abc123');
    expect(out!.title).toBe('Test DSL Rule');
    expect(out!.placeholders).toEqual({ status: 'failed' });
    expect(out!.tags).toEqual(['critical']);
  });

  it('🚨 upsert ESISTENTE → sovrascrive title + updatedAt', async () => {
    await repo.upsert(mkDsl({ title: 'V1' }));
    await repo.upsert(mkDsl({ title: 'V2', updatedAt: '2026-06-09' }));
    const out = await repo.get('dsl_abc123');
    expect(out!.title).toBe('V2');
    expect(out!.updatedAt).toBe('2026-06-09');
  });

  it('🚨 repairSql opzionale → assente se null in DB', async () => {
    await repo.upsert(mkDsl());
    const out = await repo.get('dsl_abc123');
    expect(out!.repairSql).toBeUndefined();
  });

  it('🚨 repairSql preserved se set', async () => {
    await repo.upsert(mkDsl({ repairSql: 'UPDATE runs SET status=$1' }));
    const out = await repo.get('dsl_abc123');
    expect(out!.repairSql).toBe('UPDATE runs SET status=$1');
  });

  it('🚨 createdBy opzionale → assente se null', async () => {
    await repo.upsert(mkDsl());
    const out = await repo.get('dsl_abc123');
    expect(out!.createdBy).toBeUndefined();
  });

  it('🚨 get inesistente → null', async () => {
    const out = await repo.get('dsl_mai_esistito');
    expect(out).toBeNull();
  });

  it('🚨 output frozen deep', async () => {
    await repo.upsert(mkDsl());
    const out = await repo.get('dsl_abc123');
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out!.placeholders)).toBe(true);
    expect(Object.isFrozen(out!.tags)).toBe(true);
  });
});

describe('🚨 listAll + listForTenant', () => {
  beforeEach(async () => {
    await repo.upsert(mkDsl({ id: 'dsl_aaa111', tenantId: 't1' }));
    await repo.upsert(mkDsl({ id: 'dsl_bbb222', tenantId: 't1' }));
    await repo.upsert(mkDsl({ id: 'dsl_ccc333', tenantId: 't2' }));
  });

  it('🚨 listAll → cross-tenant (admin scope)', async () => {
    const all = await repo.listAll();
    expect(all).toHaveLength(3);
  });

  it('🚨 SECURITY: listForTenant t1 NON include t2', async () => {
    const t1 = await repo.listForTenant('t1');
    expect(t1).toHaveLength(2);
    expect(t1.every(r => r.tenantId === 't1')).toBe(true);
  });

  it('🚨 SECURITY: listForTenant tenant inesistente → []', async () => {
    const out = await repo.listForTenant('non-esiste');
    expect(out).toEqual([]);
  });
});

describe('🚨 delete — composite PK guard', () => {
  beforeEach(async () => {
    await repo.upsert(mkDsl({ id: 'dsl_aaa111', tenantId: 't1' }));
    await repo.upsert(mkDsl({ id: 'dsl_bbb222', tenantId: 't2' }));
  });

  it('🚨 delete id+tenant match → rimosso', async () => {
    await repo.delete('dsl_aaa111', 't1');
    expect(await repo.get('dsl_aaa111')).toBeNull();
  });

  it('🚨 SECURITY: delete id corretto MA tenantId WRONG → NO-OP', async () => {
    // Defense-in-depth: anche se UI passa id giusto + tenant wrong → niente
    await repo.delete('dsl_aaa111', 'wrong-tenant');
    expect(await repo.get('dsl_aaa111')).not.toBeNull();
  });

  it('🚨 delete su id inesistente → no-op', async () => {
    await expect(repo.delete('mai', 't1')).resolves.not.toThrow();
  });
});

describe('🚨 placeholders JSON — resilient parse', () => {
  it('🚨 placeholders object multi-type round-trip', async () => {
    await repo.upsert(mkDsl({ placeholders: { str: 'x', num: 42, bool: true } }));
    const out = await repo.get('dsl_abc123');
    expect(out!.placeholders).toEqual({ str: 'x', num: 42, bool: true });
  });

  it('🚨 RESILIENCE: JSON corrotto in DB → fallback {} (no crash)', async () => {
    sqlite.prepare(`
      INSERT INTO janitor_dsl_rules (id, tenant_id, title, data_source_ref,
        target_table, target_pk_column, detect_sql, placeholders_json, tags_json,
        default_severity, default_schedule, default_max_rows_per_run,
        created_at, updated_at)
      VALUES ('dsl_x', 't1', 'X', 'system', 'runs', 'id', 'SELECT', ?, '[]',
        'critical', '0 * * * *', 100, '2026', '2026')
    `).run('NOT-JSON{garbage');
    const out = await repo.get('dsl_x');
    expect(out!.placeholders).toEqual({});
  });

  it('🚨 RESILIENCE: JSON null → fallback {}', async () => {
    sqlite.prepare(`
      INSERT INTO janitor_dsl_rules (id, tenant_id, title, data_source_ref,
        target_table, target_pk_column, detect_sql, placeholders_json, tags_json,
        default_severity, default_schedule, default_max_rows_per_run,
        created_at, updated_at)
      VALUES ('dsl_y', 't1', 'Y', 'system', 'runs', 'id', 'SELECT', 'null', '[]',
        'critical', '0 * * * *', 100, '2026', '2026')
    `).run();
    const out = await repo.get('dsl_y');
    expect(out!.placeholders).toEqual({});
  });
});

describe('🚨 tags JSON — array filter', () => {
  it('🚨 tags array round-trip', async () => {
    await repo.upsert(mkDsl({ tags: ['a', 'b', 'c'] }));
    const out = await repo.get('dsl_abc123');
    expect(out!.tags).toEqual(['a', 'b', 'c']);
  });

  it('🚨 SECURITY: tags con elementi non-string → filtrati out', async () => {
    sqlite.prepare(`
      INSERT INTO janitor_dsl_rules (id, tenant_id, title, data_source_ref,
        target_table, target_pk_column, detect_sql, placeholders_json, tags_json,
        default_severity, default_schedule, default_max_rows_per_run,
        created_at, updated_at)
      VALUES ('dsl_z', 't1', 'Z', 'system', 'runs', 'id', 'SELECT', '{}', ?,
        'critical', '0 * * * *', 100, '2026', '2026')
    `).run('["valid", 42, null, {"obj":1}, "valid2"]');
    const out = await repo.get('dsl_z');
    expect(out!.tags).toEqual(['valid', 'valid2']);
  });

  it('🚨 RESILIENCE: tags JSON non-array (object) → fallback []', async () => {
    sqlite.prepare(`
      INSERT INTO janitor_dsl_rules (id, tenant_id, title, data_source_ref,
        target_table, target_pk_column, detect_sql, placeholders_json, tags_json,
        default_severity, default_schedule, default_max_rows_per_run,
        created_at, updated_at)
      VALUES ('dsl_w', 't1', 'W', 'system', 'runs', 'id', 'SELECT', '{}', ?,
        'critical', '0 * * * *', 100, '2026', '2026')
    `).run('{"not":"array"}');
    const out = await repo.get('dsl_w');
    expect(out!.tags).toEqual([]);
  });

  it('🚨 RESILIENCE: tags JSON malformato → fallback []', async () => {
    sqlite.prepare(`
      INSERT INTO janitor_dsl_rules (id, tenant_id, title, data_source_ref,
        target_table, target_pk_column, detect_sql, placeholders_json, tags_json,
        default_severity, default_schedule, default_max_rows_per_run,
        created_at, updated_at)
      VALUES ('dsl_v', 't1', 'V', 'system', 'runs', 'id', 'SELECT', '{}', ?,
        'critical', '0 * * * *', 100, '2026', '2026')
    `).run('BROKEN[');
    const out = await repo.get('dsl_v');
    expect(out!.tags).toEqual([]);
  });
});
