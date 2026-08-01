/**
 * Test 2026-grade — VariablesService (workflow KV mutable + audit).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { at } from '@/__testkit__/assert.js';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

const auditAppendMock = vi.fn();
class AuditLogServiceMock { append = auditAppendMock; }
vi.mock('./audit.service.js', () => ({ AuditLogService: AuditLogServiceMock }));

const { VariablesService } = await import('./variables.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
});

describe('🚨 set + get + list', () => {
  it('🚨 set: insert + audit append', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'count', 42, 'default', 'u-1');
    expect(svc.get('wf-1', 'count')).toBe(42);
    expect(auditAppendMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'variable.set',
      resourceId: 'wf-1.count',
      actorId: 'u-1',
    }));
  });

  it('🚨 set object → JSON serialized + deserialized in get', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'config', { theme: 'dark', n: 7 });
    expect(svc.get('wf-1', 'config')).toEqual({ theme: 'dark', n: 7 });
  });

  it('🚨 set 2x same key → UPSERT (latest wins)', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'k', 1);
    await svc.set('wf-1', 'k', 2);
    expect(svc.get('wf-1', 'k')).toBe(2);
  });

  it('🚨 get inesistente → undefined', () => {
    expect(new VariablesService().get('wf-x', 'no')).toBeUndefined();
  });

  it('🚨 list → record di tutte vars del workflow', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'a', 1);
    await svc.set('wf-1', 'b', 'text');
    await svc.set('wf-2', 'c', true);
    const list = svc.list('wf-1');
    expect(list).toEqual({ a: 1, b: 'text' });
    expect((list as any).c).toBeUndefined();
  });

  it('🚨 tenant isolation', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'k', 'A', 'tenant-A');
    await svc.set('wf-1', 'k', 'B', 'tenant-B');
    expect(svc.get('wf-1', 'k', 'tenant-A')).toBe('A');
    expect(svc.get('wf-1', 'k', 'tenant-B')).toBe('B');
  });

  it('🚨 actorId opzionale → audit omits actorId', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'k', 1);
    const call = at(auditAppendMock.mock.calls, 0, 'audit-calls')[0];
    expect(call).not.toHaveProperty('actorId');
  });
});

describe('🚨 delete', () => {
  it('🚨 happy: cancella + audit', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'k', 1);
    auditAppendMock.mockClear();
    const ok = await svc.delete('wf-1', 'k', 'default', 'u-2');
    expect(ok).toBe(true);
    expect(svc.get('wf-1', 'k')).toBeUndefined();
    expect(auditAppendMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'variable.delete',
      actorId: 'u-2',
    }));
  });

  it('🚨 delete inesistente → false + NO audit', async () => {
    const svc = new VariablesService();
    const ok = await svc.delete('wf', 'no');
    expect(ok).toBe(false);
    expect(auditAppendMock).not.toHaveBeenCalled();
  });

  it('🚨 wrong tenant → false (isolation)', async () => {
    const svc = new VariablesService();
    await svc.set('wf-1', 'k', 1, 'A');
    expect(await svc.delete('wf-1', 'k', 'B')).toBe(false);
    expect(svc.get('wf-1', 'k', 'A')).toBe(1); // ancora presente
  });
});

describe('🚨 ensureVariablesTable', () => {
  it('🚨 tabella creata con PK composta tenant+wf+name', () => {
    new VariablesService();
    const t = sqliteInst.prepare("SELECT sql FROM sqlite_master WHERE name='workflow_variables'").get() as any;
    expect(t.sql).toContain('PRIMARY KEY (tenant_id, workflow_id, name)');
  });
});
