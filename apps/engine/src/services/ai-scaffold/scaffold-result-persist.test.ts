import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));

import { persistScaffoldResult, loadScaffoldResult, __resetScaffoldResultPersistTableFlag } from './scaffold-result-persist.js';

beforeEach(() => {
  __resetScaffoldResultPersistTableFlag();
  db.exec('DROP TABLE IF EXISTS ai_scaffold_job_results');
});

describe('scaffold-result-persist — il done sopravvive al restart del container', () => {
  it('persist → load round-trip (oggetto complesso)', () => {
    const result = { workflow: { id: 'wf', nodes: [{ id: 'n1' }] }, notes: ['a', 'b'] };
    persistScaffoldResult('j1', result);
    expect(loadScaffoldResult('j1')).toEqual(result);
  });

  it('id sconosciuto → null', () => {
    persistScaffoldResult('j1', { a: 1 });
    expect(loadScaffoldResult('nope')).toBeNull();
  });

  it('INSERT OR REPLACE: l\'ultima scrittura vince (no duplicati su retry)', () => {
    persistScaffoldResult('j1', { v: 1 });
    persistScaffoldResult('j1', { v: 2 });
    expect(loadScaffoldResult('j1')).toEqual({ v: 2 });
  });

  it('risultato OLTRE il TTL (1h) → null (non si recupera roba stantia)', () => {
    persistScaffoldResult('j1', { a: 1 });
    db.prepare('UPDATE ai_scaffold_job_results SET created_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60_000, 'j1'); // 2h fa
    expect(loadScaffoldResult('j1')).toBeNull();
  });

  it('cleanup: persistere un nuovo job elimina i vecchi scaduti', () => {
    persistScaffoldResult('old', { a: 1 });
    db.prepare('UPDATE ai_scaffold_job_results SET created_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60_000, 'old');
    persistScaffoldResult('new', { b: 2 }); // trigghera il DELETE degli scaduti
    const row = db.prepare('SELECT id FROM ai_scaffold_job_results WHERE id = ?').get('old');
    expect(row).toBeUndefined();
  });

  it('best-effort: persist/load non throwano mai (la generazione non deve rompersi)', () => {
    expect(() => persistScaffoldResult('j', { a: 1 })).not.toThrow();
    expect(() => loadScaffoldResult('j')).not.toThrow();
  });
});
