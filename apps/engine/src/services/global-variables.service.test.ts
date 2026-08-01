/**
 * Test 2026-grade — GlobalVariablesService (env-like tenant globals).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

const { GlobalVariablesService } = await import('./global-variables.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
});

describe('🚨 set/get/delete', () => {
  it('🚨 set + get scalar', () => {
    const svc = new GlobalVariablesService();
    svc.set('API_KEY', 'sk-xxx');
    expect(svc.get('API_KEY')).toBe('sk-xxx');
  });

  it('🚨 set object → JSON roundtrip', () => {
    const svc = new GlobalVariablesService();
    svc.set('CONFIG', { tier: 'pro', n: 5 });
    expect(svc.get('CONFIG')).toEqual({ tier: 'pro', n: 5 });
  });

  it('🚨 UPSERT on conflict', () => {
    const svc = new GlobalVariablesService();
    svc.set('K', 'v1');
    svc.set('K', 'v2');
    expect(svc.get('K')).toBe('v2');
  });

  it('🚨 get inesistente → undefined', () => {
    expect(new GlobalVariablesService().get('NO')).toBeUndefined();
  });

  it('🚨 delete happy + return true', () => {
    const svc = new GlobalVariablesService();
    svc.set('K', 'v');
    expect(svc.delete('K')).toBe(true);
    expect(svc.get('K')).toBeUndefined();
  });

  it('🚨 delete inesistente → false', () => {
    expect(new GlobalVariablesService().delete('NO')).toBe(false);
  });

  it('🚨 tenant isolation', () => {
    const svc = new GlobalVariablesService();
    svc.set('K', 'A', 'tenant-A');
    svc.set('K', 'B', 'tenant-B');
    expect(svc.get('K', 'tenant-A')).toBe('A');
    expect(svc.get('K', 'tenant-B')).toBe('B');
  });
});

describe('🚨 list + snapshot', () => {
  it('🚨 list ordinato per name', () => {
    const svc = new GlobalVariablesService();
    svc.set('Z', 1);
    svc.set('A', 2);
    svc.set('M', 3);
    expect(svc.list().map((v) => v.name)).toEqual(['A', 'M', 'Z']);
  });

  it('🚨 snapshot flat record', () => {
    const svc = new GlobalVariablesService();
    svc.set('A', 1);
    svc.set('B', { n: 2 });
    expect(svc.snapshot()).toEqual({ A: 1, B: { n: 2 } });
  });

  it('🚨 getEnv (engine API) === snapshot', () => {
    const svc = new GlobalVariablesService();
    svc.set('X', 'y');
    expect(svc.getEnv('default')).toEqual(svc.snapshot());
  });
});
