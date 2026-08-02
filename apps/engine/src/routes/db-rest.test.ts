/**
 * Test db-rest validateSqlIdentifier — regression SQL injection guard.
 *
 * Focus 2026-05-29: `?pk=` query param ora validato regex
 * `^[A-Za-z_][A-Za-z0-9_]{0,62}$` PRIMA di essere passato al service layer.
 */
import { describe, expect, it } from 'vitest';
import { validateSqlIdentifier } from './db-rest';

describe('validateSqlIdentifier — accepted', () => {
  it('id (default)', () => {
    expect(validateSqlIdentifier('id')).toBe('id');
  });

  it('snake_case', () => {
    expect(validateSqlIdentifier('user_id')).toBe('user_id');
  });

  it('camelCase', () => {
    expect(validateSqlIdentifier('userId')).toBe('userId');
  });

  it('underscore prefix', () => {
    expect(validateSqlIdentifier('_internal_pk')).toBe('_internal_pk');
  });

  it('digits dopo prima lettera', () => {
    expect(validateSqlIdentifier('col123')).toBe('col123');
  });

  it('63 char totali (max)', () => {
    const name = 'a' + 'b'.repeat(62);
    expect(validateSqlIdentifier(name)).toBe(name);
  });
});

describe('validateSqlIdentifier — rejected (anti-injection)', () => {
  it('SQL injection classico: ");DROP TABLE users;--', () => {
    expect(() => validateSqlIdentifier('id");DROP TABLE users;--')).toThrow(
      /Invalid SQL identifier/,
    );
  });

  it('spazio singolo', () => {
    expect(() => validateSqlIdentifier('user id')).toThrow();
  });

  it('quote singolo', () => {
    expect(() => validateSqlIdentifier("id'='1")).toThrow();
  });

  it('backtick', () => {
    expect(() => validateSqlIdentifier('`id`')).toThrow();
  });

  it('punto (sql qualified)', () => {
    expect(() => validateSqlIdentifier('users.id')).toThrow();
  });

  it('newline', () => {
    expect(() => validateSqlIdentifier('id\nDROP TABLE x')).toThrow();
  });

  it('inizio con cifra', () => {
    expect(() => validateSqlIdentifier('1id')).toThrow();
  });

  it('64+ char (oltre limite)', () => {
    expect(() => validateSqlIdentifier('a'.repeat(64))).toThrow();
  });

  it('stringa vuota', () => {
    expect(() => validateSqlIdentifier('')).toThrow();
  });

  it('solo cifre', () => {
    expect(() => validateSqlIdentifier('12345')).toThrow();
  });

  it('Unicode/emoji', () => {
    expect(() => validateSqlIdentifier('id😀')).toThrow();
  });

  it('parentesi', () => {
    expect(() => validateSqlIdentifier('id()')).toThrow();
  });

  it('semicolon', () => {
    expect(() => validateSqlIdentifier('id;')).toThrow();
  });
});
