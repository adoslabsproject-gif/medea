/**
 * readonly-flag.service — test su SQLite REALE (:memory:): persistenza, cache,
 * upsert idempotente, fail-open. Niente smoke: verifica le semantiche che il
 * gate dell'esecuzione (RunService) si fida siano corrette.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const sqlite = new Database(':memory:');
sqlite.exec(
  `CREATE TABLE system_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`,
);

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite }) }));
vi.mock('@/lib/logger.js');

import {
  isWorkspaceReadOnly,
  setWorkspaceReadOnly,
  WorkspaceReadOnlyError,
  __resetReadOnlyCacheForTest,
} from './readonly-flag.service.js';

beforeEach(() => {
  sqlite.exec('DELETE FROM system_flags');
  __resetReadOnlyCacheForTest();
});

describe('readonly-flag — persistenza + cache', () => {
  it('default (nessun flag) → false (fail-open, non blocca)', () => {
    expect(isWorkspaceReadOnly()).toBe(false);
  });

  it('set true → persistito in sqlite + letto true', () => {
    setWorkspaceReadOnly(true);
    __resetReadOnlyCacheForTest(); // forza rilettura dal disco
    expect(isWorkspaceReadOnly()).toBe(true);
    const row = sqlite.prepare('SELECT value FROM system_flags WHERE key = ?').get('read_only') as { value: string };
    expect(row.value).toBe('true');
  });

  it('set true poi false → false (sblocco)', () => {
    setWorkspaceReadOnly(true);
    setWorkspaceReadOnly(false);
    __resetReadOnlyCacheForTest();
    expect(isWorkspaceReadOnly()).toBe(false);
  });

  it('upsert idempotente: toggle ripetuto → UNA sola row (no duplicati)', () => {
    setWorkspaceReadOnly(true);
    setWorkspaceReadOnly(true);
    setWorkspaceReadOnly(false);
    const c = sqlite.prepare('SELECT COUNT(*) AS c FROM system_flags').get() as { c: number };
    expect(c.c).toBe(1);
  });

  it('🔒 sopravvive al "restart" (rilettura da sqlite dopo cache reset)', () => {
    setWorkspaceReadOnly(true);
    __resetReadOnlyCacheForTest(); // simula nuovo processo
    expect(isWorkspaceReadOnly()).toBe(true);
  });

  it('cache hot-path: dopo set non rilegge sqlite finché non resettata', () => {
    setWorkspaceReadOnly(true);
    sqlite.exec("UPDATE system_flags SET value = 'false' WHERE key = 'read_only'");
    expect(isWorkspaceReadOnly()).toBe(true);  // serve dalla cache
    __resetReadOnlyCacheForTest();
    expect(isWorkspaceReadOnly()).toBe(false); // dopo reset rilegge il vero valore
  });
});

describe('WorkspaceReadOnlyError', () => {
  it('code WORKSPACE_READ_ONLY + httpStatus 423 Locked', () => {
    const e = new WorkspaceReadOnlyError();
    expect(e.code).toBe('WORKSPACE_READ_ONLY');
    expect(e.httpStatus).toBe(423);
    expect(e).toBeInstanceOf(Error);
  });
});
