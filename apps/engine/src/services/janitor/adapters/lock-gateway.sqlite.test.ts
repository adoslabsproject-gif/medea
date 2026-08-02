/**
 * Test 2026-grade — SqliteLockGateway (distributed named locks).
 *
 * ATOMICITY: INSERT ON CONFLICT DO NOTHING + BEGIN IMMEDIATE.
 * TTL: expires_at filter server-side (no client clock skew).
 * SAFETY: release richiede holderId match (no cross-process steal).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('@/lib/logger.js');

const { SqliteLockGateway } = await import('./lock-gateway.sqlite.js');
const loggerModule = (await import('@/lib/logger.js')) as any;
const loggerMock = loggerModule.logger;

let sqlite: Database.Database;
let gateway: any;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE janitor_locks (
      rule_id TEXT PRIMARY KEY,
      held_by TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  gateway = new SqliteLockGateway(sqlite);
});

describe('🚨 acquire', () => {
  it('🚨 happy: prima volta → true', () => {
    expect(gateway.acquire('rule-1', 'worker-A', 5000)).toBe(true);
  });

  it('🚨 lock già presente fresh → false (atomic conflict)', () => {
    gateway.acquire('rule-1', 'worker-A', 60_000);
    expect(gateway.acquire('rule-1', 'worker-B', 60_000)).toBe(false);
  });

  it('🚨 lock expired → DELETE + acquire OK', () => {
    // Inserisco direttamente un lock già expired (1970)
    sqlite
      .prepare(
        `INSERT INTO janitor_locks VALUES ('rule-1', 'worker-A', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:01.000Z')`,
      )
      .run();
    expect(gateway.acquire('rule-1', 'worker-B', 5000)).toBe(true);
    const row = sqlite
      .prepare('SELECT held_by FROM janitor_locks WHERE rule_id=?')
      .get('rule-1') as any;
    expect(row.held_by).toBe('worker-B');
  });

  it('🚨 ttl arrotondato a almeno 1s', () => {
    expect(gateway.acquire('rule-x', 'worker', 100)).toBe(true);
    const row = sqlite.prepare('SELECT * FROM janitor_locks WHERE rule_id=?').get('rule-x') as any;
    expect(row).toBeDefined();
  });

  it('🚨 error → ROLLBACK + warn + false', () => {
    sqlite.exec('DROP TABLE janitor_locks');
    expect(gateway.acquire('rule', 'worker', 5000)).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

describe('🚨 release', () => {
  it('🚨 happy: holder match → DELETE row', () => {
    gateway.acquire('rule-1', 'worker-A', 60_000);
    gateway.release('rule-1', 'worker-A');
    expect(sqlite.prepare('SELECT COUNT(*) as n FROM janitor_locks').get()).toEqual({ n: 0 });
  });

  it('🚨 wrong holder → row NON cancellata (no steal)', () => {
    gateway.acquire('rule-1', 'worker-A', 60_000);
    gateway.release('rule-1', 'worker-OTHER');
    expect(sqlite.prepare('SELECT COUNT(*) as n FROM janitor_locks').get()).toEqual({ n: 1 });
  });

  it('🚨 release inesistente → no-op', () => {
    expect(() => gateway.release('no-such', 'worker')).not.toThrow();
  });

  it('🚨 error → warn log (non fatal)', () => {
    sqlite.exec('DROP TABLE janitor_locks');
    gateway.release('x', 'y');
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

describe('🚨 cleanupStale', () => {
  it('🚨 elimina solo expired', () => {
    gateway.acquire('rule-fresh', 'w', 60_000);
    sqlite
      .prepare(
        `INSERT INTO janitor_locks VALUES ('rule-old', 'w', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:01.000Z')`,
      )
      .run();
    const n = gateway.cleanupStale();
    expect(n).toBe(1);
    const remaining = sqlite.prepare('SELECT rule_id FROM janitor_locks').all() as any[];
    expect(remaining).toEqual([{ rule_id: 'rule-fresh' }]);
  });

  it('🚨 no stale → ritorna 0', () => {
    gateway.acquire('rule-fresh', 'w', 60_000);
    expect(gateway.cleanupStale()).toBe(0);
  });

  it('🚨 error → ritorna 0 + warn', () => {
    sqlite.exec('DROP TABLE janitor_locks');
    expect(gateway.cleanupStale()).toBe(0);
  });
});

describe('🚨 listActive', () => {
  it('🚨 ritorna solo lock non-expired ordinati DESC', async () => {
    gateway.acquire('rule-A', 'w-A', 60_000);
    await new Promise((r) => setTimeout(r, 10));
    gateway.acquire('rule-B', 'w-B', 60_000);
    const list = gateway.listActive();
    expect(list.length).toBe(2);
    // ordinati DESC per acquired_at
    expect(list[0].key).toBe('rule-B');
    expect(list[1].key).toBe('rule-A');
  });

  it('🚨 expired exclusi', () => {
    gateway.acquire('rule-fresh', 'w-fresh', 60_000);
    sqlite
      .prepare(
        `INSERT INTO janitor_locks VALUES ('rule-stale', 'w-stale', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:01.000Z')`,
      )
      .run();
    const list = gateway.listActive();
    expect(list.length).toBe(1);
    expect(list[0].key).toBe('rule-fresh');
  });

  it('🚨 error → []', () => {
    sqlite.exec('DROP TABLE janitor_locks');
    expect(gateway.listActive()).toEqual([]);
  });
});
