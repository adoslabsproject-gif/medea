/**
 * Test 2026-grade — PinService (n8n-style pin data per (workflow, node)).
 *
 * UX: pin replaces upstream execution → dev iteration veloce.
 * TENANT ISOLATION: PK include tenantId → no cross-tenant leak.
 * UPSERT: ON CONFLICT update output_json + enabled + updated_at.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

const { PinService } = await import('./pin.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
});

describe('🚨 ensurePinsTable', () => {
  it('🚨 tabella creata + PK composta (tenant, wf, node)', () => {
    new PinService();
    const t = sqliteInst.prepare("SELECT sql FROM sqlite_master WHERE name='workflow_pins'").get() as any;
    expect(t.sql).toContain('PRIMARY KEY (tenant_id, workflow_id, node_id)');
  });
});

describe('🚨 set + get', () => {
  it('🚨 set + get → output deserializzato', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', { foo: 'bar', n: 42 });
    const g = svc.get('wf-1', 'n-1');
    expect(g).not.toBeNull();
    expect(g!.output).toEqual({ foo: 'bar', n: 42 });
    expect(g!.enabled).toBe(true);
    expect(g!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('🚨 get key inesistente → null', () => {
    expect(new PinService().get('no', 'no')).toBeNull();
  });

  it('🚨 set 2x same key → UPSERT (latest wins)', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', { v: 1 });
    svc.set('wf-1', 'n-1', { v: 2 });
    expect(svc.get('wf-1', 'n-1')!.output).toEqual({ v: 2 });
  });

  it('🚨 enabled=false propagato', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', { x: 1 }, false);
    expect(svc.get('wf-1', 'n-1')!.enabled).toBe(false);
  });

  it('🚨 tenant isolation: stesso (wf, node) → tenant diversi separati', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', { v: 'A' }, true, 'tenant-A');
    svc.set('wf-1', 'n-1', { v: 'B' }, true, 'tenant-B');
    expect(svc.get('wf-1', 'n-1', 'tenant-A')!.output).toEqual({ v: 'A' });
    expect(svc.get('wf-1', 'n-1', 'tenant-B')!.output).toEqual({ v: 'B' });
  });

  it('🚨 output con null, array, complex object', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-arr', [1, 2, 3]);
    svc.set('wf-1', 'n-null', null);
    expect(svc.get('wf-1', 'n-arr')!.output).toEqual([1, 2, 3]);
    expect(svc.get('wf-1', 'n-null')!.output).toBeNull();
  });
});

describe('🚨 list', () => {
  it('🚨 vuota → []', () => {
    expect(new PinService().list('wf-empty')).toEqual([]);
  });

  it('🚨 multiple pin → ordinati per node_id', () => {
    const svc = new PinService();
    svc.set('wf-1', 'z-node', {});
    svc.set('wf-1', 'a-node', {});
    svc.set('wf-1', 'm-node', {});
    const list = svc.list('wf-1');
    expect(list.map((p) => p.nodeId)).toEqual(['a-node', 'm-node', 'z-node']);
  });

  it('🚨 filter per tenant', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', {}, true, 'A');
    svc.set('wf-1', 'n-2', {}, true, 'B');
    expect(svc.list('wf-1', 'A')).toHaveLength(1);
    expect(svc.list('wf-1', 'B')).toHaveLength(1);
  });
});

describe('🚨 delete', () => {
  it('🚨 happy: cancella → true', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', {});
    expect(svc.delete('wf-1', 'n-1')).toBe(true);
    expect(svc.get('wf-1', 'n-1')).toBeNull();
  });

  it('🚨 key inesistente → false', () => {
    expect(new PinService().delete('no', 'no')).toBe(false);
  });

  it('🚨 wrong tenant → false (isolation)', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-1', {}, true, 'A');
    expect(svc.delete('wf-1', 'n-1', 'B')).toBe(false);
    expect(svc.get('wf-1', 'n-1', 'A')).not.toBeNull();
  });
});

describe('🚨 getEnabledMap — fast lookup engine bypass', () => {
  it('🚨 ritorna solo pin enabled=1', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n-on', { v: 'enabled' }, true);
    svc.set('wf-1', 'n-off', { v: 'disabled' }, false);
    const map = svc.getEnabledMap('wf-1');
    expect(map.has('n-on')).toBe(true);
    expect(map.has('n-off')).toBe(false);
    expect(map.get('n-on')).toEqual({ v: 'enabled' });
  });

  it('🚨 map vuoto se nessun pin enabled', () => {
    const svc = new PinService();
    svc.set('wf-x', 'n', {}, false);
    expect(new PinService().getEnabledMap('wf-x').size).toBe(0);
  });

  it('🚨 tenant scope rispettato', () => {
    const svc = new PinService();
    svc.set('wf-1', 'n', { x: 1 }, true, 'A');
    expect(svc.getEnabledMap('wf-1', 'B').size).toBe(0);
    expect(svc.getEnabledMap('wf-1', 'A').size).toBe(1);
  });
});
