import { describe, it, expect } from 'vitest';
import { assertSelectOnly, sqlSkeleton } from './select-only-guard.js';

const ok = (sql: string): void => { expect(() => { assertSelectOnly(sql); }).not.toThrow(); };
const ko = (sql: string, re: RegExp): void => { expect(() => { assertSelectOnly(sql); }).toThrow(re); };

describe('sqlSkeleton — rimuove stringhe/commenti (no falsi positivi)', () => {
  it('svuota letterali e commenti', () => {
    expect(sqlSkeleton("SELECT 'please DELETE me' -- DROP TABLE x\nFROM t")).toContain("''");
    expect(sqlSkeleton("SELECT 'please DELETE me' FROM t")).not.toMatch(/DELETE me/);
  });
  it('block comment via', () => {
    expect(sqlSkeleton('SELECT /* DROP TABLE x */ 1')).not.toMatch(/DROP/);
  });
});

describe('assertSelectOnly — SELECT legittimi PASSANO', () => {
  it('SELECT semplice', () => { ok('SELECT * FROM clienti'); });
  it('JOIN/GROUP BY/ORDER/LIMIT/OFFSET', () => {
    ok('SELECT o.id, count(*) FROM orders o JOIN lines l ON l.oid=o.id GROUP BY o.id ORDER BY o.id LIMIT 50 OFFSET 10');
  });
  it('CTE WITH di sola lettura', () => {
    ok('WITH recenti AS (SELECT * FROM orders WHERE created_at > now() - interval \'7 day\') SELECT * FROM recenti');
  });
  it('🔒 letterale che CONTIENE "delete"/"drop" → OK (è una stringa, non DML)', () => {
    ok("SELECT * FROM tickets WHERE titolo = 'richiesta di delete account' AND note = 'drop off point'");
  });
  it('commento che cita DML → OK', () => {
    ok('SELECT * FROM t -- TODO: poi serve un UPDATE su questa');
  });
  it('; finale tollerato', () => { ok('SELECT 1;'); });
  it('UNION di SELECT → OK', () => { ok('SELECT a FROM t1 UNION SELECT a FROM t2'); });
  it('🔒 "into" in stringa o dentro una parola → OK (no falso positivo del fix INTO)', () => {
    ok("SELECT * FROM logs WHERE msg = 'moved into archive'"); // letterale, svuotato dallo skeleton
    ok('SELECT fall_into_bucket FROM metrics');                // "into" senza word-boundary
  });
});

describe('🚨 assertSelectOnly — BYPASS bloccati', () => {
  it('🚨 CTE data-modifying Postgres (DELETE dentro WITH) → BLOCCATO', () => {
    ko('WITH gone AS (DELETE FROM orders WHERE id=1 RETURNING *) SELECT * FROM gone', /DELETE/i);
  });
  it('🚨 CTE con UPDATE → BLOCCATO', () => {
    ko('WITH x AS (UPDATE accounts SET saldo=0 RETURNING *) SELECT * FROM x', /UPDATE/i);
  });
  it('🚨 CTE con INSERT → BLOCCATO', () => {
    ko("WITH x AS (INSERT INTO log(msg) VALUES('hack') RETURNING *) SELECT * FROM x", /INSERT/i);
  });
  it('🚨 multi-statement SELECT;DELETE → BLOCCATO', () => {
    ko('SELECT 1; DELETE FROM users', /più statement|DELETE/i);
  });
  it('🚨 dollar-quote NON terminato + DELETE → BLOCCATO (no swallow-fino-a-fine)', () => {
    // Pre-fix: `$x$` senza chiusura faceva `i=n` → ingoiava `; DELETE …` → skeleton
    // "select" silenzioso. Ora il `$` è letterale e il DELETE resta visibile.
    ko('SELECT $x$ ; DELETE FROM users', /più statement|DELETE/i);
    ko('SELECT $$ ; DROP TABLE t', /più statement|DROP/i);
  });
  it('🚨 multi-statement SELECT;DROP → BLOCCATO', () => {
    ko('SELECT 1; DROP TABLE users', /più statement|DROP/i);
  });
  it('🚨 DML mascherato da commento iniziale → BLOCCATO (lead reale = DELETE)', () => {
    ko('-- innocuo\nDELETE FROM t', /solo SELECT|DELETE/i);
  });
  it('🚨 DDL diretto (DROP/ALTER/TRUNCATE/CREATE) → BLOCCATO', () => {
    ko('DROP TABLE clienti', /solo SELECT|DROP/i);
    ko('TRUNCATE clienti', /solo SELECT|TRUNCATE/i);
    ko('ALTER TABLE clienti ADD c int', /solo SELECT|ALTER/i);
  });
  it('🚨 transaction/DDL control (BEGIN/COMMIT/GRANT/COPY/VACUUM) → BLOCCATO', () => {
    ko('SELECT 1; COMMIT', /più statement|COMMIT/i);
    ko('COPY clienti TO STDOUT', /solo SELECT|COPY/i);
  });
  // 🚨 SELECT … INTO: su Postgres/MSSQL CREA una tabella pur iniziando con SELECT.
  // Bypassava il guard (into non era forbidden) E classifyStatement server-side
  // (classifica 'select'). L'unico gate read-only del nodo è questo guard → deve
  // beccarlo. (SQLite non supporta SELECT INTO → lì è errore di sintassi.)
  it('🚨 SELECT … INTO nuova_tabella (Postgres/MSSQL) → BLOCCATO', () => {
    ko('SELECT * INTO evil_copy FROM users', /solo SELECT|INTO/i);
    ko('SELECT id, email INTO TEMP staging FROM customers', /INTO/i);
    ko("WITH x AS (SELECT 1) SELECT * INTO dump FROM x", /INTO/i);
  });

  // 🚨🚨 BYPASS marcatore-commento-dentro-stringa (skeleton sequenziale era forabile).
  // L'SQL reale è multi-statement con DML; il vecchio skeleton lo vedeva come `SELECT ''`.
  it('🚨 BYPASS: /* dentro stringa apre finto commento che ingoia ; DELETE → BLOCCATO', () => {
    ko(`SELECT '/*' ; DELETE FROM t WHERE x = '*/'`, /più statement|DELETE/i);
  });
  it('🚨 BYPASS: -- dentro stringa → BLOCCATO', () => {
    ko(`SELECT '--' ; DELETE FROM t`, /più statement|DELETE/i);
  });
  it('🚨 BYPASS: /* dentro stringa + DROP → BLOCCATO', () => {
    ko(`SELECT '/*' ; DROP TABLE users WHERE '*/'='*/'`, /più statement|DROP/i);
  });
});

describe('sqlSkeleton single-pass — niente falsi positivi su quoting Postgres', () => {
  it('dollar-quote con "delete" letterale → SELECT PASSA (non è DML)', () => {
    ok('SELECT $$please delete this$$ AS nota FROM t');
  });
  it('dollar-quote con tag e ; interno → resta letterale, SELECT PASSA', () => {
    ok('SELECT $msg$ a ; b $msg$ FROM t');
  });
  it('commento a blocco ANNIDATO che cita DML → SELECT PASSA (semantica PG)', () => {
    ok('SELECT 1 /* outer /* inner ; DELETE */ still comment */ FROM t');
  });
  it('🔒 il ; REALE fuori da stringa/commento resta visibile → BLOCCATO', () => {
    ko('SELECT 1 /* c */ ; DELETE FROM t', /più statement|DELETE/i);
  });
});
