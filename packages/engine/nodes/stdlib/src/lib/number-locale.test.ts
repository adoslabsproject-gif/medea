/**
 * Test bug-bounty — SSOT coercion numerica locale-aware (EN/ISO + IT/EU).
 * Mutation-verify: la disambiguazione virgola↔punto è il cuore; se salta, i casi
 * "1.234,56" e "1.234" collidono e i test diventano rossi.
 */
import { describe, it, expect } from 'vitest';
import { parseNumberLocale } from './number-locale.js';

describe('parseNumberLocale — formato EN/ISO', () => {
  it.each([
    ['42', 42],
    ['3.5', 3.5],
    ['1234.56', 1234.56],
    ['-7', -7],
    ['+8', 8],
    ['0', 0],
    ['1.234', 1.234], // 🚨 senza virgola = decimale EN, NON 1234 (no indovinare)
  ])('%j → %j', (input, expected) => {
    expect(parseNumberLocale(input)).toBe(expected);
  });
});

describe('parseNumberLocale — formato IT/EU (virgola = decimale)', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1.000.000,00', 1000000],
    ['3,5', 3.5],
    ['0,99', 0.99],
    ['-1.500,25', -1500.25],
    ['1234,5', 1234.5], // virgola senza migliaia
  ])('%j → %j', (input, expected) => {
    expect(parseNumberLocale(input)).toBe(expected);
  });
});

describe('parseNumberLocale — number/boolean nativi', () => {
  it('number finito → se stesso; NaN/Infinity → null', () => {
    expect(parseNumberLocale(42)).toBe(42);
    expect(parseNumberLocale(-3.14)).toBe(-3.14);
    expect(parseNumberLocale(NaN)).toBeNull();
    expect(parseNumberLocale(Infinity)).toBeNull();
  });
  it('boolean → 1/0', () => {
    expect(parseNumberLocale(true)).toBe(1);
    expect(parseNumberLocale(false)).toBe(0);
  });
});

describe('parseNumberLocale — non-numerico → null (mai 0)', () => {
  it.each([
    'abc', '', '   ', 'a,b', '1,2,3', '1.2.3,4', '12,', '€10',
  ])('%j → null', (input) => {
    expect(parseNumberLocale(input)).toBeNull();
  });
  it('null/undefined/oggetti/array → null', () => {
    expect(parseNumberLocale(null)).toBeNull();
    expect(parseNumberLocale(undefined)).toBeNull();
    expect(parseNumberLocale({})).toBeNull();
    expect(parseNumberLocale([1])).toBeNull();
  });
  it('🚨 una stringa con virgola ma struttura NON-numerica non viene "salvata" a numero', () => {
    // mutation: il replace ingenuo (.→'' , ,→.) trasformerebbe "1.2.3,4" in 123.4; il guard IT_NUMERIC lo blocca.
    expect(parseNumberLocale('1.2.3,4')).toBeNull();
  });
});
