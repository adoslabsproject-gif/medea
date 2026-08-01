import { describe, it, expect } from 'vitest';
import {
  sqlIdent,
  sqlType,
  createTableStatement,
  sqlLiteral,
  insertStatement,
  parseDumpTables,
} from './sql-dump.js';

describe('sqlIdent', () => {
  it('quota con doppi apici', () => {
    expect(sqlIdent('clienti')).toBe('"clienti"');
  });
  it('🔒 raddoppia i doppi apici interni (anti-break-out)', () => {
    expect(sqlIdent('a"b')).toBe('"a""b"');
  });
});

describe('sqlType', () => {
  it('mappa i ColumnType normalizzati → SQL', () => {
    expect(sqlType('varchar')).toBe('VARCHAR');
    expect(sqlType('datetime')).toBe('TIMESTAMP');
    expect(sqlType('uuid')).toBe('UUID');
  });
  it('tipo sconosciuto → TEXT (fallback sicuro)', () => {
    expect(sqlType('qualcosa')).toBe('TEXT');
  });
});

describe('sqlLiteral — ANTI SQL-INJECTION', () => {
  it('null/undefined → NULL', () => {
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
  });
  it('numeri finiti as-is, NaN/Infinity → NULL', () => {
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(-3.14)).toBe('-3.14');
    expect(sqlLiteral(NaN)).toBe('NULL');
    expect(sqlLiteral(Infinity)).toBe('NULL');
  });
  it('boolean → TRUE/FALSE; bigint as-is', () => {
    expect(sqlLiteral(true)).toBe('TRUE');
    expect(sqlLiteral(false)).toBe('FALSE');
    expect(sqlLiteral(10n)).toBe('10');
  });
  it('Date → literal ISO quotato', () => {
    expect(sqlLiteral(new Date('2026-06-16T09:00:00Z'))).toBe("'2026-06-16T09:00:00.000Z'");
  });
  it('stringa → quotata', () => {
    expect(sqlLiteral('mario')).toBe("'mario'");
  });
  it("🔒🔒 apici singoli RADDOPPIATI — il payload di injection è neutralizzato", () => {
    expect(sqlLiteral("Robert'); DROP TABLE students;--")).toBe("'Robert''); DROP TABLE students;--'");
    expect(sqlLiteral("d'Annunzio")).toBe("'d''Annunzio'");
  });
  it('oggetto/array → JSON quotato (apici raddoppiati)', () => {
    expect(sqlLiteral({ a: "x'y" })).toBe(`'{"a":"x''y"}'`);
    expect(sqlLiteral([1, 2])).toBe("'[1,2]'");
  });
});

describe('createTableStatement', () => {
  it('CREATE TABLE con colonne, PK e NOT NULL', () => {
    const ddl = createTableStatement('clienti', [
      { name: 'id', type: 'uuid', primaryKey: true },
      { name: 'nome', type: 'varchar', nullable: false },
      { name: 'note', type: 'text', nullable: true },
    ]);
    expect(ddl).toBe(
      'CREATE TABLE IF NOT EXISTS "clienti" (\n  "id" UUID PRIMARY KEY,\n  "nome" VARCHAR NOT NULL,\n  "note" TEXT\n);',
    );
  });
  it('🔒 nome tabella/colonna con apice → quotato (no break-out DDL)', () => {
    const ddl = createTableStatement('a"b', [{ name: 'c"d', type: 'text' }]);
    expect(ddl).toContain('"a""b"');
    expect(ddl).toContain('"c""d"');
  });
  it('zero colonne → placeholder valido (no DDL rotto)', () => {
    expect(createTableStatement('vuota', [])).toBe('CREATE TABLE IF NOT EXISTS "vuota" ();');
  });
});

describe('insertStatement', () => {
  it('INSERT con colonne fisse + literal', () => {
    expect(insertStatement('t', ['id', 'nome'], { id: 1, nome: "o'brien" })).toBe(
      `INSERT INTO "t" ("id", "nome") VALUES (1, 'o''brien');`,
    );
  });
  it('cella mancante → NULL', () => {
    expect(insertStatement('t', ['id', 'manca'], { id: 1 })).toBe('INSERT INTO "t" ("id", "manca") VALUES (1, NULL);');
  });
});

describe('parseDumpTables — estrazione type-safe da introspect (unknown)', () => {
  it('estrae name + columns (con nullable/primaryKey dai constraints)', () => {
    const tables = parseDumpTables([
      { name: 'clienti', columns: [
        { name: 'id', type: 'uuid', constraints: { primaryKey: true, nullable: false } },
        { name: 'nome', type: 'varchar', constraints: { nullable: true } },
      ] },
    ]);
    expect(tables).toEqual([
      { name: 'clienti', columns: [
        { name: 'id', type: 'uuid', nullable: false, primaryKey: true },
        { name: 'nome', type: 'varchar', nullable: true },
      ] },
    ]);
  });
  it('🔒 scarta tabelle/colonne malformate, non lancia', () => {
    expect(parseDumpTables('non un array')).toEqual([]);
    expect(parseDumpTables([null, 5, { columns: [] }, { name: '' }])).toEqual([]);
    expect(parseDumpTables([{ name: 't', columns: [null, { type: 'x' }, { name: 'ok', type: 'integer' }] }])).toEqual([
      { name: 't', columns: [{ name: 'ok', type: 'integer' }] },
    ]);
  });
  it('type colonna assente → "text" (default sicuro)', () => {
    expect(parseDumpTables([{ name: 't', columns: [{ name: 'c' }] }])).toEqual([
      { name: 't', columns: [{ name: 'c', type: 'text' }] },
    ]);
  });
});
