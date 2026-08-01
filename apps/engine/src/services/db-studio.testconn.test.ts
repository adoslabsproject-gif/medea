/**
 * Test — DbStudioService.testConnection (test connessione pre-salvataggio).
 * Adapter mockato: connect/introspect ok → {ok:true}; throw → {ok:false,error};
 * niente persistenza, adapter effimero disconnesso e rimosso dalla cache.
 *
 * @module services/db-studio.testconn.test
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DbType } from '@flowforge/db-studio-core';

const m = vi.hoisted(() => {
  const mockFns = {
    db: null as Database.Database | null,
    configValue: { FLOWFORGE_DATA_DIR: '/tmp/ff-testconn' },
    connect: vi.fn(), introspect: vi.fn(), disconnect: vi.fn(),
  };
  class FakeAdapter {
    engine = 'sqlite';
    async connect(d: unknown) { return mockFns.connect(d); }
    async applyMigration() { return { sql: '', affectedTables: [] }; }
    async previewMigration() { return ''; }
    async query() { return []; }
    async insert() { return {}; }
    async update() { return {}; }
    async delete() { return {}; }
    async introspect() { return mockFns.introspect(); }
    async disconnect() { return mockFns.disconnect(); }
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
// Guardia SSRF testata a parte (external-host-guard.test) → no-op qui per usare
// host fittizi senza DNS reale.
vi.mock('@/services/db-studio/external-host-guard.js', () => ({ assertExternalHostAllowed: () => Promise.resolve() }));

import { DbStudioService } from './db-studio.service.js';

const PG: DbType['connection'] = { engine: 'postgres', embedded: false, hostname: 'db.example.com', port: 5432, database: 'app' };

beforeEach(() => {
  m.db = new Database(':memory:');
  for (const v of Object.values(m)) { if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset(); }
  m.connect.mockResolvedValue(undefined);
  m.introspect.mockResolvedValue([]);
  m.disconnect.mockResolvedValue(undefined);
});

describe('DbStudioService.testConnection', () => {
  it('connessione valida → { ok: true }, e disconnette l\'adapter effimero', async () => {
    const svc = new DbStudioService();
    const r = await svc.testConnection(PG, 'tA');
    expect(r).toEqual({ ok: true });
    expect(m.connect).toHaveBeenCalledTimes(1);
    expect(m.disconnect).toHaveBeenCalledTimes(1);
  });

  it('connessione che fallisce → { ok:false, error } (no throw)', async () => {
    m.connect.mockRejectedValueOnce(new Error('ECONNREFUSED db.example.com:5432'));
    const svc = new DbStudioService();
    const r = await svc.testConnection(PG, 'tA');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
    // adapter mai cache-ato (connect throw prima del set) → niente da disconnettere, nessun leak
  });

  it('introspect fallisce DOPO connect → adapter (cache-ato) viene disconnesso', async () => {
    m.introspect.mockRejectedValueOnce(new Error('auth failed'));
    const svc = new DbStudioService();
    await svc.testConnection(PG, 'tA');
    expect(m.disconnect).toHaveBeenCalledTimes(1);
  });

  it('introspect che fallisce dopo il connect → { ok:false }', async () => {
    m.introspect.mockRejectedValueOnce(new Error('auth failed'));
    const svc = new DbStudioService();
    const r = await svc.testConnection(PG, 'tA');
    expect(r).toMatchObject({ ok: false });
  });

  it('NON persiste: nessun database creato nel registro', async () => {
    const svc = new DbStudioService();
    await svc.testConnection(PG, 'tA');
    expect(svc.list('tA')).toEqual([]);
  });

  it('engine non bundlato → { ok:false } (non lancia)', async () => {
    const svc = new DbStudioService();
    const r = await svc.testConnection({ engine: 'oracle' as DbType['connection']['engine'], embedded: false }, 'tA');
    expect(r.ok).toBe(false);
  });
});
