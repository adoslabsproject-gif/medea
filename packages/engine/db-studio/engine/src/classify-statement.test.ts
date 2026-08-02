/**
 * Tests per `classifyStatement` — N19 audit (anti SQL injection via DSL).
 *
 * Bug pre-fix (CRITICAL):
 *  - `SELECT 1; DROP TABLE x` → 'select' (only first keyword inspected)
 *  - `WITH d AS (DELETE FROM t RETURNING *) SELECT count(*) FROM d` →
 *    'select' (Postgres modifying CTE not detected)
 *
 * Both bypassed the DSL detect-rule validator (which gates on
 * `kind === 'select'`) and the executeRaw isSelect branch (which
 * dispatched non-select statements to `tx.unsafe()`).
 *
 * Fix:
 *  - classifyStatement now folds multi-statement to WORST-kind via
 *    splitStatements + priority map (ddl > delete > update > insert >
 *    other > select|explain)
 *  - classifySingleStatement detects "modifying CTE" by scanning all
 *    parenthesised bodies after WITH for DML verbs
 */
import { describe, it, expect } from 'vitest';
import { classifyStatement, assertSafeRawStatement } from './adapter.js';

describe('classifyStatement — N19 audit (multi-statement worst-kind)', () => {
  it('single SELECT → select', () => {
    expect(classifyStatement('SELECT 1')).toBe('select');
    expect(classifyStatement('select * from users')).toBe('select');
  });

  it('single SELECT with trailing semicolon → select', () => {
    expect(classifyStatement('SELECT 1;')).toBe('select');
  });

  it('single INSERT → insert', () => {
    expect(classifyStatement('INSERT INTO t VALUES (1)')).toBe('insert');
  });

  it('single UPDATE → update', () => {
    expect(classifyStatement('UPDATE t SET x=1 WHERE id=1')).toBe('update');
  });

  it('single DELETE → delete', () => {
    expect(classifyStatement('DELETE FROM t WHERE id=1')).toBe('delete');
  });

  it('single DROP → ddl', () => {
    expect(classifyStatement('DROP TABLE t')).toBe('ddl');
  });

  it('single TRUNCATE → ddl', () => {
    expect(classifyStatement('TRUNCATE TABLE t')).toBe('ddl');
  });

  it('REGRESSION CRITICAL: SELECT 1; DROP TABLE x → ddl (was "select" pre-fix)', () => {
    expect(classifyStatement('SELECT 1; DROP TABLE x')).toBe('ddl');
  });

  it('REGRESSION CRITICAL: SELECT 1; DELETE FROM users → delete (was "select")', () => {
    expect(classifyStatement('SELECT 1; DELETE FROM users')).toBe('delete');
  });

  it('REGRESSION: SELECT 1; UPDATE t SET x=1 → update', () => {
    expect(classifyStatement('SELECT 1; UPDATE t SET x=1')).toBe('update');
  });

  it('REGRESSION: SELECT 1; INSERT INTO logs VALUES (1) → insert', () => {
    expect(classifyStatement('SELECT 1; INSERT INTO logs VALUES (1)')).toBe('insert');
  });

  it('REGRESSION: SELECT 1; TRUNCATE flowforge.audit_log → ddl', () => {
    expect(classifyStatement('SELECT 1; TRUNCATE flowforge.audit_log')).toBe('ddl');
  });

  it('REGRESSION: SELECT 1; ALTER TABLE t ADD COLUMN x INT → ddl', () => {
    expect(classifyStatement('SELECT 1; ALTER TABLE t ADD COLUMN x INT')).toBe('ddl');
  });

  it('REGRESSION: 3 statements SELECT;SELECT;DROP → ddl (worst kind found)', () => {
    expect(classifyStatement('SELECT 1; SELECT 2; DROP TABLE x')).toBe('ddl');
  });

  it('multiple SELECTs → select (no worst found)', () => {
    expect(classifyStatement('SELECT 1; SELECT 2; SELECT 3')).toBe('select');
  });

  it('priority: DDL > DELETE (mixed multi-stmt) → ddl', () => {
    expect(classifyStatement('DELETE FROM t; DROP TABLE x')).toBe('ddl');
  });

  it('priority: DELETE > UPDATE > INSERT', () => {
    expect(classifyStatement('INSERT INTO t VALUES (1); UPDATE t SET x=1')).toBe('update');
    expect(classifyStatement('UPDATE t SET x=1; DELETE FROM t')).toBe('delete');
  });

  it('priority: other > select (CALL/VACUUM/GRANT unknown verb)', () => {
    expect(classifyStatement('CALL my_proc()')).toBe('other');
    expect(classifyStatement('SELECT 1; VACUUM ANALYZE')).toBe('other');
  });
});

describe('classifyStatement — N19 audit (modifying CTE — Postgres feature)', () => {
  it('SELECT 1 → select', () => {
    expect(classifyStatement('SELECT 1')).toBe('select');
  });

  it('plain CTE WITH ... SELECT → select', () => {
    expect(classifyStatement('WITH t AS (SELECT 1) SELECT * FROM t')).toBe('select');
  });

  it('REGRESSION CRITICAL: WITH d AS (DELETE FROM users RETURNING *) SELECT count(*) FROM d → delete (was "select")', () => {
    const payload =
      'WITH del AS (DELETE FROM flowforge.users RETURNING *) SELECT count(*) FROM del';
    expect(classifyStatement(payload)).toBe('delete');
  });

  it('REGRESSION: WITH u AS (UPDATE t SET x=1 RETURNING *) SELECT * FROM u → update', () => {
    expect(classifyStatement('WITH u AS (UPDATE t SET x=1 RETURNING *) SELECT * FROM u')).toBe(
      'update',
    );
  });

  it('REGRESSION: WITH i AS (INSERT INTO logs VALUES (1) RETURNING id) SELECT * FROM i → insert', () => {
    expect(
      classifyStatement('WITH i AS (INSERT INTO logs VALUES (1) RETURNING id) SELECT * FROM i'),
    ).toBe('insert');
  });

  it('REGRESSION: WITH d AS (DELETE FROM t) SELECT 1 → delete', () => {
    expect(classifyStatement('WITH d AS (DELETE FROM t) SELECT 1')).toBe('delete');
  });

  it('CTE with whitespace before DML keyword (multi-line) → detected', () => {
    const sql = `WITH del AS (
      DELETE FROM users
      WHERE id = 1
      RETURNING *
    ) SELECT count(*) FROM del`;
    expect(classifyStatement(sql)).toBe('delete');
  });
});

describe('classifyStatement — BYPASS DML primario dopo CTE (revisore 2026-06-14)', () => {
  // CLASSE di bypass, non singolo esempio: `WITH <benigno> <DML> …` dove il
  // DML è lo statement PRINCIPALE dopo i CTE. Postgres/SQLite lo eseguono e
  // muta i dati; pre-fix classifyStatement tornava 'select' → run_sql e il
  // nodo SSH "sola lettura" lo eseguivano. Tutti i casi DEVONO essere ≠ select.
  it('WITH benigno + DELETE primario → delete', () => {
    expect(classifyStatement('WITH cte AS (SELECT 1) DELETE FROM users WHERE id > 0')).toBe(
      'delete',
    );
  });

  it('WITH benigno + UPDATE primario → update', () => {
    expect(classifyStatement('WITH cte AS (SELECT 1) UPDATE users SET x = 1')).toBe('update');
  });

  it('WITH benigno + INSERT primario → insert', () => {
    expect(classifyStatement('WITH cte AS (SELECT 1) INSERT INTO logs SELECT * FROM cte')).toBe(
      'insert',
    );
  });

  it('CTE multipli + DELETE primario → delete', () => {
    expect(
      classifyStatement(
        'WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM t WHERE id IN (SELECT id FROM b)',
      ),
    ).toBe('delete');
  });

  it('WITH RECURSIVE + DELETE primario → delete', () => {
    expect(classifyStatement('WITH RECURSIVE r AS (SELECT 1) DELETE FROM t')).toBe('delete');
  });

  it('case-insensitive + multilinea → delete', () => {
    expect(
      classifyStatement('with cte as (\n  select 1\n)\nDELETE\n  from users\n  where id = 1'),
    ).toBe('delete');
  });

  it('WITH benigno + MERGE primario → NON select (mutazione bloccata)', () => {
    expect(
      classifyStatement(
        'WITH cte AS (SELECT 1) MERGE INTO t USING cte ON t.id=cte.id WHEN MATCHED THEN DELETE',
      ),
    ).not.toBe('select');
  });

  it('worst-kind: CTE modificante (DELETE) + UPDATE primario → delete (peggiore)', () => {
    expect(
      classifyStatement(
        'WITH d AS (DELETE FROM a RETURNING id) UPDATE b SET x=1 WHERE id IN (SELECT id FROM d)',
      ),
    ).toBe('delete');
  });

  // ── Anti-falso-positivo: un WITH puramente in lettura resta 'select' anche
  //    se i verbi DML compaiono in STRINGHE / COMMENTI / nomi di colonna. ──
  it('WITH + SELECT con stringa "delete from" → select', () => {
    expect(
      classifyStatement(`WITH x AS (SELECT 1) SELECT 'delete from cache' AS note FROM x`),
    ).toBe('select');
  });

  it('WITH + SELECT con identificatore quotato "delete_log" → select', () => {
    expect(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM "delete_log"')).toBe('select');
  });

  it('WITH + SELECT con colonne update_flag/asset (substring) → select', () => {
    expect(
      classifyStatement('WITH x AS (SELECT 1) SELECT update_flag, asset, count(*) FROM t'),
    ).toBe('select');
  });

  it('WITH + SELECT con commento "/* delete from t */" → select', () => {
    expect(classifyStatement('WITH x AS (SELECT 1) SELECT 1 /* delete from t */ FROM x')).toBe(
      'select',
    );
  });

  it('WITH puramente in lettura → select (nessun falso positivo)', () => {
    expect(
      classifyStatement('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON true'),
    ).toBe('select');
  });
});

describe('classifyStatement — N19 audit (no false positive on benign queries)', () => {
  it('SELECT with subquery using "delete" as table name → still select', () => {
    // Table named "delete" — only DML if `(\s*delete\s+` (paren + verb) matches
    expect(classifyStatement('SELECT * FROM "delete_log"')).toBe('select');
  });

  it('SELECT with string literal containing "DROP TABLE" → still select', () => {
    expect(classifyStatement(`SELECT 'DROP TABLE x' AS warning`)).toBe('select');
  });

  it('leading comment + SELECT → select', () => {
    expect(classifyStatement('-- comment\nSELECT 1')).toBe('select');
  });

  it('leading block comment + SELECT → select', () => {
    expect(classifyStatement('/* block */\nSELECT 1')).toBe('select');
  });
});

describe('classifyStatement — N19 audit (edge cases)', () => {
  it('empty string → other (no statements split)', () => {
    expect(classifyStatement('')).toBe('other');
  });

  it('only whitespace → other', () => {
    expect(classifyStatement('   \n   ')).toBe('other');
  });

  it('only comment → other', () => {
    expect(classifyStatement('-- nothing here\n')).toBe('other');
  });

  it('EXPLAIN single → explain', () => {
    expect(classifyStatement('EXPLAIN SELECT 1')).toBe('explain');
  });

  it('EXPLAIN + DROP → ddl (worst-kind fold)', () => {
    expect(classifyStatement('EXPLAIN SELECT 1; DROP TABLE x')).toBe('ddl');
  });
});

describe('🔒 assertSafeRawStatement — filesystem escape guard (SQLite)', () => {
  const blocked = [
    "ATTACH DATABASE '/etc/passwd' AS x",
    "attach '/tmp/evil.db' as e",
    "  ATTACH '../../host.db' AS h",
    "/* comment */ ATTACH 'x' AS y", // commento iniziale non bypassa
    "-- note\nATTACH 'x' AS y",
    'DETACH DATABASE x',
    "VACUUM INTO '/tmp/exfil.db'",
    "VACUUM main INTO '/tmp/x.db'",
    "SELECT load_extension('/tmp/evil.so')",
    "SELECT * FROM t WHERE x = load_extension('a')",
  ];
  it.each(blocked)('blocca: %s', (sql) => {
    expect(() => assertSafeRawStatement(sql)).toThrow();
  });

  const allowed = [
    'SELECT * FROM orders',
    "INSERT INTO logs (msg) VALUES ('attached to the case')", // 'attach' in stringa ≠ verbo
    'UPDATE t SET note = "detach the form"',
    "SELECT 'vacuum into the void' AS poem",
    'CREATE TABLE t (id INTEGER PRIMARY KEY)',
    'VACUUM', // VACUUM senza INTO è ok
    'DELETE FROM t WHERE id = 1',
  ];
  it.each(allowed)('consente: %s', (sql) => {
    expect(() => assertSafeRawStatement(sql)).not.toThrow();
  });
});
