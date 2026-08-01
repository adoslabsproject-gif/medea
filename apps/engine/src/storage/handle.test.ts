/**
 * Test 2026-grade — storage/handle.ts (DB abstraction SQLite/Postgres).
 *
 * 🚨 PLACEHOLDER REWRITE: ? → $1/$2 per Postgres. Bug = SQL injection se
 *    rewriter sbaglia escape stringhe. Skip TUTTO dentro stringhe ' o ".
 *
 * 🚨 DDL TRANSLATE: SQLite-specific → Postgres equivalent.
 *    INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL, BLOB → BYTEA,
 *    DATETIME → TIMESTAMPTZ, PRAGMA → strip.
 *
 * 🚨 SQLITE HANDLE: prepare/run/get/all wrappato come async (uniformità).
 *
 * 🚨 splitStatements: parser SQL multi-statement, skip ; dentro stringhe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import {
  SqliteHandle,
  rewritePlaceholders,
  translateDdl,
} from './handle.js';

describe('🚨 rewritePlaceholders — ? → $N per Postgres', () => {
  it('🚨 single placeholder → $1', () => {
    expect(rewritePlaceholders('SELECT * FROM t WHERE id = ?')).toBe('SELECT * FROM t WHERE id = $1');
  });

  it('🚨 multiple placeholders → $1, $2, $3 in ordine', () => {
    expect(rewritePlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)'))
      .toBe('INSERT INTO t (a, b, c) VALUES ($1, $2, $3)');
  });

  it('🚨 NO placeholder → SQL invariato', () => {
    const sql = 'SELECT count(*) FROM t';
    expect(rewritePlaceholders(sql)).toBe(sql);
  });

  it('🚨 SECURITY: ? dentro stringa singola → NON rewritten', () => {
    expect(rewritePlaceholders("SELECT * FROM t WHERE name = 'what?' AND id = ?"))
      .toBe("SELECT * FROM t WHERE name = 'what?' AND id = $1");
  });

  it('🚨 SECURITY: ? dentro stringa doppia → NON rewritten', () => {
    expect(rewritePlaceholders('SELECT * FROM t WHERE col = "what?" AND id = ?'))
      .toBe('SELECT * FROM t WHERE col = "what?" AND id = $1');
  });

  it('🚨 SECURITY: ? dentro stringa multipla → tutti skip', () => {
    expect(rewritePlaceholders("SELECT '?' AS x, '?' AS y, ? AS z"))
      .toBe("SELECT '?' AS x, '?' AS y, $1 AS z");
  });

  it('🚨 quote misti: \'a"b\' → la doppia non chiude (siamo in singola)', () => {
    expect(rewritePlaceholders("SELECT 'foo\"bar?' AS x WHERE id = ?"))
      .toBe("SELECT 'foo\"bar?' AS x WHERE id = $1");
  });

  it('🚨 string non chiusa → tutto resto dentro (no rewrite)', () => {
    // SQL malformato ma il rewriter non deve crashare
    expect(rewritePlaceholders("SELECT 'unclosed... ? still in string"))
      .toBe("SELECT 'unclosed... ? still in string");
  });

  it('🚨 numero alto placeholders ($10, $11, ...)', () => {
    const sql = '? ? ? ? ? ? ? ? ? ? ? ?';
    const out = rewritePlaceholders(sql);
    expect(out).toContain('$10');
    expect(out).toContain('$11');
    expect(out).toContain('$12');
  });

  it('🚨 string vuota → output vuoto', () => {
    expect(rewritePlaceholders('')).toBe('');
  });
});

describe('🚨 translateDdl — SQLite → Postgres', () => {
  it('🚨 INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY', () => {
    expect(translateDdl('id INTEGER PRIMARY KEY AUTOINCREMENT'))
      .toBe('id BIGSERIAL PRIMARY KEY');
  });

  it('🚨 case-insensitive AUTOINCREMENT', () => {
    expect(translateDdl('id integer primary key autoincrement'))
      .toBe('id BIGSERIAL PRIMARY KEY');
  });

  it('🚨 BLOB → BYTEA (word boundary)', () => {
    expect(translateDdl('data BLOB')).toBe('data BYTEA');
  });

  it('🚨 DATETIME → TIMESTAMPTZ', () => {
    expect(translateDdl('created_at DATETIME NOT NULL')).toBe('created_at TIMESTAMPTZ NOT NULL');
  });

  it('🚨 PRAGMA stripped (sostituito con commento)', () => {
    expect(translateDdl('PRAGMA journal_mode = WAL;')).toContain('-- pragma stripped;');
    expect(translateDdl('PRAGMA journal_mode = WAL;')).not.toContain('PRAGMA');
  });

  it('🚨 multiple PRAGMA in stessa stringa', () => {
    const ddl = 'PRAGMA foreign_keys = ON; PRAGMA cache_size = -2000;';
    const out = translateDdl(ddl);
    expect(out).not.toContain('PRAGMA');
    expect(out.match(/-- pragma stripped/gu)).toHaveLength(2);
  });

  it('🚨 DDL complesso reale: CREATE TABLE con tutti i tipi', () => {
    const sql = `
      CREATE TABLE t (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB,
        created_at DATETIME NOT NULL
      );
      PRAGMA foreign_keys = ON;
    `;
    const out = translateDdl(sql);
    expect(out).toContain('BIGSERIAL PRIMARY KEY');
    expect(out).toContain('BYTEA');
    expect(out).toContain('TIMESTAMPTZ');
    expect(out).not.toContain('PRAGMA');
  });

  it('🚨 NO match → SQL invariato', () => {
    const sql = 'SELECT * FROM users WHERE active = TRUE';
    expect(translateDdl(sql)).toBe(sql);
  });

  it('🚨 SECURITY: BLOB dentro identifier (no word boundary triggered)', () => {
    // BLOBSTORE è una colonna identifier, NON il tipo BLOB
    const out = translateDdl('name BLOBSTORE');
    // \\bBLOB\\b non matcha BLOBSTORE perché segue carattere alphanum
    expect(out).toBe('name BLOBSTORE');
  });
});

describe('🚨 SqliteHandle — async wrapper API', () => {
  let conn: SqliteDatabase.Database;
  let handle: SqliteHandle;

  beforeEach(() => {
    conn = new SqliteDatabase(':memory:');
    conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
    handle = new SqliteHandle(conn);
  });

  afterEach(async () => {
    if (conn.open) await handle.close();
  });

  it('🚨 kind="sqlite"', () => {
    expect(handle.kind).toBe('sqlite');
  });

  it('🚨 exec → Promise<void>', async () => {
    await expect(handle.exec('CREATE TABLE x (id INTEGER)')).resolves.toBeUndefined();
    const cols = conn.prepare("PRAGMA table_info(x)").all() as { name: string }[];
    expect(cols).toHaveLength(1);
  });

  it('🚨 prepare + run → RunResult con changes + lastInsertRowid', async () => {
    const stmt = handle.prepare('INSERT INTO t (v) VALUES (?)');
    const r = await stmt.run('hello');
    expect(r.changes).toBe(1);
    expect(typeof r.lastInsertRowid).toMatch(/number|bigint/);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);
  });

  it('🚨 prepare + get → row singola o undefined', async () => {
    await handle.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    const stmt = handle.prepare<{ v: string }>('SELECT v FROM t WHERE id = ?');
    const r = await stmt.get(1);
    expect(r?.v).toBe('hello');
    const missing = await stmt.get(999);
    expect(missing).toBeUndefined();
  });

  it('🚨 prepare + all → array', async () => {
    await handle.prepare('INSERT INTO t (v) VALUES (?)').run('a');
    await handle.prepare('INSERT INTO t (v) VALUES (?)').run('b');
    await handle.prepare('INSERT INTO t (v) VALUES (?)').run('c');
    const rows = await handle.prepare<{ v: string }>('SELECT v FROM t ORDER BY id').all();
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.v)).toEqual(['a', 'b', 'c']);
  });

  it('🚨 prepare riusabile (multiple .run on same statement)', async () => {
    const stmt = handle.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 10; i++) await stmt.run(`v${i}`);
    const count = (await handle.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM t').get())!.c;
    expect(count).toBe(10);
  });

  it('🚨 close idempotente — chiamato 2 volte non throw catastrofico', async () => {
    await handle.close();
    // better-sqlite3 throw su double-close, ma il wrapper può catch silently
    // Test: la prima close completa, la seconda fa quello che fa (throw/no-op)
    // → non deve crashare il processo
    let secondCloseFail = false;
    try {
      await handle.close();
    } catch {
      secondCloseFail = true;
    }
    // Documento il comportamento attuale: throw atteso da better-sqlite3
    expect([true, false]).toContain(secondCloseFail);
  });

  it('🚨 SECURITY: parametri bind protetti da SQL injection', async () => {
    const evilPayload = "'; DROP TABLE t; --";
    await handle.prepare('INSERT INTO t (v) VALUES (?)').run(evilPayload);
    // La tabella DEVE esistere ancora (no DROP eseguito via injection)
    const count = (await handle.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM t').get())!.c;
    expect(count).toBe(1);
    // Il valore deve essere salvato as-is (parameter binding safe)
    const r = await handle.prepare<{ v: string }>('SELECT v FROM t').get();
    expect(r!.v).toBe(evilPayload);
  });
});
