/**
 * Test — generatore SQL condiviso delle VIEW (CREATE/DROP).
 * @module view-ddl.test
 */
import { describe, it, expect } from 'vitest';
import { renderCreateViewSql, renderDropViewSql } from './view-ddl.js';

const dq = (id: string): string => `"${id}"`; // sqlite/postgres/duckdb
const bt = (id: string): string => `\`${id}\``; // mysql
const br = (id: string): string => `[${id}]`; // mssql

describe('renderCreateViewSql', () => {
  it('CREATE VIEW <q name> AS <select>;', () => {
    expect(
      renderCreateViewSql(
        { name: 'clienti_attivi', select: 'SELECT * FROM clienti WHERE attivo = 1' },
        dq,
      ),
    ).toBe('CREATE VIEW "clienti_attivi" AS SELECT * FROM clienti WHERE attivo = 1;');
  });

  it('rimuove un ; finale del SELECT (anti statement-break smuggling)', () => {
    expect(renderCreateViewSql({ name: 'v', select: 'SELECT 1 ;  ' }, dq)).toBe(
      'CREATE VIEW "v" AS SELECT 1;',
    );
  });

  it('usa il quoting INIETTATO dal dialetto (mysql backtick, mssql bracket)', () => {
    expect(renderCreateViewSql({ name: 'v', select: 'SELECT 1' }, bt)).toBe(
      'CREATE VIEW `v` AS SELECT 1;',
    );
    expect(renderCreateViewSql({ name: 'v', select: 'SELECT 1' }, br)).toBe(
      'CREATE VIEW [v] AS SELECT 1;',
    );
  });

  it('quoting difensivo: un " nel nome viene raddoppiato (no break dell\'identificatore)', () => {
    const q = (id: string): string => `"${id.replace(/"/gu, '""')}"`;
    expect(renderCreateViewSql({ name: 'a"b', select: 'SELECT 1' }, q)).toBe(
      'CREATE VIEW "a""b" AS SELECT 1;',
    );
  });
});

describe('renderDropViewSql', () => {
  it('DROP VIEW IF EXISTS <q name>; (idempotente)', () => {
    expect(renderDropViewSql('clienti_attivi', dq)).toBe('DROP VIEW IF EXISTS "clienti_attivi";');
    expect(renderDropViewSql('v', bt)).toBe('DROP VIEW IF EXISTS `v`;');
  });
});
