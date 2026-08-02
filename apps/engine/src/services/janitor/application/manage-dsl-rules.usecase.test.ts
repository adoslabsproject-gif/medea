/**
 * Test 2026-grade — ManageDslRulesUseCase (janitor DSL CRUD + SQL validation).
 *
 * 🚨 BUSINESS-CRITICAL: usato dall'admin UI per creare regole DSL janitor che
 * scansionano DB tenant per corruption. SQL validation OBBLIGATORIA:
 *  - detectSql: SELECT/WITH only (no DML/DDL)
 *  - repairSql: UPDATE only (no DELETE/INSERT/TRUNCATE)
 *  - PK column referenced in detectSql
 *  - identifier regex (table + pk) [a-zA-Z][a-zA-Z0-9_]{0,63}
 *  - schedule cron validation
 *  - maxRows 1-100k
 *
 * Coverage:
 *  - create: validate → upsert → registry register → audit
 *  - update: tenant mismatch → Err, repairSql 3 paths (undefined/null/string)
 *  - delete: tenant scope guard
 *  - validation: 10 error paths
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  classifyStatement: vi.fn(),
  engineSupportsRawSql: vi.fn(),
  validateCronExpression: vi.fn(),
  repoUpsert: vi.fn(),
  repoGet: vi.fn(),
  repoDelete: vi.fn(),
  repoListForTenant: vi.fn(),
  registryRegister: vi.fn(),
  registryUnregister: vi.fn(),
  resolverResolve: vi.fn(),
  auditEmit: vi.fn(),
}));

vi.mock('@medea/engine-db-studio-engine', () => ({
  classifyStatement: (...a: unknown[]) => m.classifyStatement(...a),
}));

vi.mock('@/services/janitor/domain/data-source-ref.js', () => ({
  engineSupportsRawSql: (...a: unknown[]) => m.engineSupportsRawSql(...a),
}));

vi.mock('./cron-evaluator.js', () => ({
  validateCronExpression: (...a: unknown[]) => m.validateCronExpression(...a),
}));

vi.mock('@/services/janitor/adapters/dsl-rule.repository.js', () => ({
  DslRuleRepository: class {
    upsert = m.repoUpsert;
    get = m.repoGet;
    delete = m.repoDelete;
    listForTenant = m.repoListForTenant;
  },
}));

import { ManageDslRulesUseCase, type CreateDslRuleInput } from './manage-dsl-rules.usecase.js';
import { DslRuleRepository } from '@/services/janitor/adapters/dsl-rule.repository.js';

function makeUseCase(): ManageDslRulesUseCase {
  const repo = new DslRuleRepository();
  return new ManageDslRulesUseCase(
    repo,
    { registerDslRule: m.registryRegister, unregisterDslRule: m.registryUnregister } as never,
    { resolve: m.resolverResolve } as never,
    { emit: m.auditEmit } as never,
  );
}

const baseInput = (over: Partial<CreateDslRuleInput> = {}): CreateDslRuleInput => ({
  tenantId: 't1',
  title: 'My Rule',
  dataSourceRef: { engine: 'postgres', tenantId: 't1', name: 'main' } as never,
  targetTable: 'users',
  targetPkColumn: 'id',
  detectSql: 'SELECT id, name FROM users WHERE state = ?',
  repairSql: 'UPDATE users SET state = ? WHERE id = ?',
  createdBy: 'admin-1',
  ...over,
});

beforeEach(() => {
  m.classifyStatement.mockReset().mockImplementation((sql: string) => {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('select') || s.startsWith('with')) return 'select';
    if (s.startsWith('update')) return 'update';
    if (s.startsWith('delete')) return 'delete';
    if (s.startsWith('insert')) return 'insert';
    return 'other';
  });
  m.engineSupportsRawSql.mockReset().mockReturnValue(true);
  m.validateCronExpression.mockReset().mockReturnValue(null);
  m.repoUpsert.mockReset().mockResolvedValue(undefined);
  m.repoGet.mockReset();
  m.repoDelete.mockReset().mockResolvedValue(undefined);
  m.repoListForTenant.mockReset().mockResolvedValue([]);
  m.registryRegister.mockReset();
  m.registryUnregister.mockReset();
  m.resolverResolve.mockReset().mockResolvedValue({ engine: 'postgres' });
  m.auditEmit.mockReset().mockResolvedValue(undefined);
});

describe('listForTenant', () => {
  it('delega al repo', async () => {
    m.repoListForTenant.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    const r = await makeUseCase().listForTenant('t1');
    expect(r).toHaveLength(2);
    expect(m.repoListForTenant).toHaveBeenCalledWith('t1');
  });
});

describe('create() — validation paths', () => {
  it('🚨 happy: upsert + register + audit', async () => {
    const r = await makeUseCase().create(baseInput());
    expect(r.ok).toBe(true);
    expect(m.repoUpsert).toHaveBeenCalled();
    expect(m.registryRegister).toHaveBeenCalled();
    expect(m.auditEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'janitor.dsl_rule.created',
        actorId: 'admin-1',
      }),
    );
  });

  it('rule id pattern: dsl_<nanoid10>', async () => {
    const r = await makeUseCase().create(baseInput());
    expect(r.ok).toBe(true);
    const rule = m.repoUpsert.mock.calls[0]?.[0] as { id: string };
    expect(rule.id).toMatch(/^dsl_[a-zA-Z0-9_-]{10}$/u);
  });

  it('🚨 title vuoto → Err "Titolo obbligatorio"', async () => {
    const r = await makeUseCase().create(baseInput({ title: '   ' }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('Titolo obbligatorio');
    expect(m.repoUpsert).not.toHaveBeenCalled();
  });

  it('🚨 targetTable con caratteri invalidi → Err', async () => {
    const r = await makeUseCase().create(baseInput({ targetTable: 'users;DROP' }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Nome tabella non valido');
  });

  it('🚨 targetTable inizia con number → Err (deve essere [a-z][a-z0-9_]{0,63})', async () => {
    const r = await makeUseCase().create(baseInput({ targetTable: '1users' }));
    expect(r.ok).toBe(false);
  });

  it('🚨 targetTable > 64 char → Err', async () => {
    const r = await makeUseCase().create(baseInput({ targetTable: 'a' + 'b'.repeat(64) }));
    expect(r.ok).toBe(false);
  });

  it('🚨 targetPkColumn invalido → Err', async () => {
    const r = await makeUseCase().create(baseInput({ targetPkColumn: 'id; --' }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Nome colonna PK');
  });

  it('🚨 detectSql NON è SELECT → Err', async () => {
    const r = await makeUseCase().create(
      baseInput({
        detectSql: 'DELETE FROM users WHERE id = 1',
      }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('detectSql deve essere SELECT');
  });

  it('🚨 detectSql con WITH → ok (CTE allowed)', async () => {
    const r = await makeUseCase().create(
      baseInput({
        detectSql: 'WITH t AS (SELECT id FROM users) SELECT id FROM t',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('🚨 repairSql NON è UPDATE → Err', async () => {
    const r = await makeUseCase().create(
      baseInput({
        repairSql: 'DELETE FROM users WHERE id = ?',
      }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('repairSql deve essere UPDATE');
  });

  it('🚨 repairSql INSERT → Err', async () => {
    const r = await makeUseCase().create(
      baseInput({
        repairSql: 'INSERT INTO users(id) VALUES (1)',
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('🚨 detectSql NON menziona PK column → Err', async () => {
    const r = await makeUseCase().create(
      baseInput({
        targetPkColumn: 'id',
        detectSql: 'SELECT name FROM users WHERE state = ?', // no `id`
      }),
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('detectSql deve selezionare la colonna PK');
  });

  it('🚨 data source NON SQL engine → Err', async () => {
    m.engineSupportsRawSql.mockReturnValue(false);
    m.resolverResolve.mockResolvedValue({ engine: 'redis' });
    const r = await makeUseCase().create(baseInput());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('non supporta SQL');
  });

  it('🚨 data source resolver throws → Err', async () => {
    m.resolverResolve.mockRejectedValue(new Error('connection refused'));
    const r = await makeUseCase().create(baseInput());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Data source non risolvibile');
  });

  it('🚨 defaultSchedule cron invalido → Err', async () => {
    m.validateCronExpression.mockReturnValue('malformed cron');
    const r = await makeUseCase().create(baseInput({ defaultSchedule: 'not-cron' }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Schedule non valido');
  });

  it('🚨 defaultMaxRowsPerRun = 0 → Err', async () => {
    const r = await makeUseCase().create(baseInput({ defaultMaxRowsPerRun: 0 }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('tra 1 e 100.000');
  });

  it('🚨 defaultMaxRowsPerRun > 100k → Err', async () => {
    const r = await makeUseCase().create(baseInput({ defaultMaxRowsPerRun: 100_001 }));
    expect(r.ok).toBe(false);
  });

  it('🚨 defaultMaxRowsPerRun non-integer → Err', async () => {
    const r = await makeUseCase().create(baseInput({ defaultMaxRowsPerRun: 100.5 }));
    expect(r.ok).toBe(false);
  });

  it('default severity/schedule/maxRows applicati', async () => {
    await makeUseCase().create(baseInput());
    const rule = m.repoUpsert.mock.calls[0]?.[0] as {
      defaultSeverity: string;
      defaultSchedule: string;
      defaultMaxRowsPerRun: number;
    };
    expect(rule.defaultSeverity).toBe('warning');
    expect(rule.defaultSchedule).toBe('*/30 * * * *');
    expect(rule.defaultMaxRowsPerRun).toBe(200);
  });

  it('repairSql omesso → rule senza repairSql (no DELETE auto-clean)', async () => {
    const { repairSql: _drop, ...withoutRepair } = baseInput();
    await makeUseCase().create(withoutRepair);
    const rule = m.repoUpsert.mock.calls[0]?.[0] as { repairSql?: string };
    expect(rule.repairSql).toBeUndefined();
  });
});

describe('update()', () => {
  const existing = {
    kind: 'dsl' as const,
    id: 'dsl_existing',
    tenantId: 't1',
    title: 'old title',
    description: '',
    dataSourceRef: { engine: 'postgres', tenantId: 't1', name: 'main' },
    targetTable: 'users',
    targetPkColumn: 'id',
    detectSql: 'SELECT id FROM users',
    placeholders: {},
    tags: [],
    defaultSeverity: 'warning' as const,
    defaultSchedule: '* * * * *',
    defaultMaxRowsPerRun: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('🚨 happy: partial update → upsert + re-register + audit', async () => {
    m.repoGet.mockResolvedValue(existing);
    const r = await makeUseCase().update({
      id: 'dsl_existing',
      tenantId: 't1',
      title: 'new title',
      updatedBy: 'admin-2',
    });
    expect(r.ok).toBe(true);
    expect(m.registryUnregister).toHaveBeenCalledWith('dsl_existing');
    expect(m.registryRegister).toHaveBeenCalled();
    expect(m.auditEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'janitor.dsl_rule.updated',
        actorId: 'admin-2',
      }),
    );
  });

  it('🚨 rule not found → Err "non trovata"', async () => {
    m.repoGet.mockResolvedValue(null);
    const r = await makeUseCase().update({ id: 'ghost', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('non trovata');
  });

  it('🚨 cross-tenant → Err "Tenant mismatch"', async () => {
    m.repoGet.mockResolvedValue(existing);
    const r = await makeUseCase().update({ id: 'dsl_existing', tenantId: 't2-OTHER' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('Tenant mismatch');
  });

  it('🚨 repairSql=null → rimuove repairSql dalla rule', async () => {
    m.repoGet.mockResolvedValue({ ...existing, repairSql: 'UPDATE users SET x = ?' });
    const r = await makeUseCase().update({
      id: 'dsl_existing',
      tenantId: 't1',
      repairSql: null,
    });
    expect(r.ok).toBe(true);
    const merged = m.repoUpsert.mock.calls[0]?.[0] as { repairSql?: string };
    expect(merged.repairSql).toBeUndefined();
  });

  it('repairSql=undefined → mantieni existing', async () => {
    m.repoGet.mockResolvedValue({ ...existing, repairSql: 'UPDATE users SET x = ?' });
    const r = await makeUseCase().update({
      id: 'dsl_existing',
      tenantId: 't1',
      title: 'new title',
    });
    expect(r.ok).toBe(true);
    const merged = m.repoUpsert.mock.calls[0]?.[0] as { repairSql?: string };
    expect(merged.repairSql).toBe('UPDATE users SET x = ?');
  });

  it('🚨 repairSql nuovo string → validato + applied', async () => {
    m.repoGet.mockResolvedValue(existing);
    const r = await makeUseCase().update({
      id: 'dsl_existing',
      tenantId: 't1',
      repairSql: 'UPDATE users SET state = 0',
    });
    expect(r.ok).toBe(true);
    const merged = m.repoUpsert.mock.calls[0]?.[0] as { repairSql: string };
    expect(merged.repairSql).toBe('UPDATE users SET state = 0');
  });

  it('🚨 nuovo detectSql validato → se NON SELECT → Err + no upsert', async () => {
    m.repoGet.mockResolvedValue(existing);
    const r = await makeUseCase().update({
      id: 'dsl_existing',
      tenantId: 't1',
      detectSql: 'DELETE FROM users WHERE id = ?',
    });
    expect(r.ok).toBe(false);
    expect(m.repoUpsert).not.toHaveBeenCalled();
  });
});

describe('delete()', () => {
  it('🚨 happy: delete + unregister + audit', async () => {
    m.repoGet.mockResolvedValue({ id: 'dsl_x', tenantId: 't1' });
    const r = await makeUseCase().delete('dsl_x', 't1', 'admin-3');
    expect(r.ok).toBe(true);
    expect(m.repoDelete).toHaveBeenCalledWith('dsl_x', 't1');
    expect(m.registryUnregister).toHaveBeenCalledWith('dsl_x');
    expect(m.auditEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'janitor.dsl_rule.deleted',
        actorId: 'admin-3',
      }),
    );
  });

  it('🚨 rule not found → Err + no delete', async () => {
    m.repoGet.mockResolvedValue(null);
    const r = await makeUseCase().delete('ghost', 't1');
    expect(r.ok).toBe(false);
    expect(m.repoDelete).not.toHaveBeenCalled();
  });

  it('🚨 cross-tenant → Err "Tenant mismatch" + no delete', async () => {
    m.repoGet.mockResolvedValue({ id: 'dsl_x', tenantId: 't1' });
    const r = await makeUseCase().delete('dsl_x', 't2-OTHER');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('Tenant mismatch');
    expect(m.repoDelete).not.toHaveBeenCalled();
  });
});
