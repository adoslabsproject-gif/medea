/**
 * Test bug-bounty — SSOT anti CSV/Spreadsheet formula injection (CWE-1236).
 *
 * Obiettivo: dimostrare che OGNI trigger di formula viene neutralizzato e che i
 * valori innocui restano BIT-IDENTICI (no falsi positivi). Mutation-verify: se la
 * neutralizzazione sparisce, gli assert "inizia con apice" diventano rossi.
 */
import { describe, it, expect } from 'vitest';
import { neutralizeCsvFormula, CSV_FORMULA_PREFIX } from './csv-formula-guard.js';

describe('neutralizeCsvFormula — trigger di formula', () => {
  // Payload reali dal catalogo OWASP CSV-injection.
  it.each([
    ['=1+1', "'=1+1"],
    ['=HYPERLINK("http://evil","clic")', '\'=HYPERLINK("http://evil","clic")'],
    ["=cmd|'/c calc'!A1", "'=cmd|'/c calc'!A1"],
    ['+1+1', "'+1+1"],
    ['-2-3', "'-2-3"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ['\t=1+1', "'\t=1+1"], // TAB iniziale (Excel lo ignora e valuta la formula)
    ['\r=1+1', "'\r=1+1"], // CR iniziale
  ])('neutralizza %j → %j', (input, expected) => {
    expect(neutralizeCsvFormula(input)).toBe(expected);
  });
});

describe('neutralizeCsvFormula — valori innocui restano invariati (no falso positivo)', () => {
  it.each([
    'Mario Rossi',
    'prezzo 10 euro',
    '1+1 nel mezzo non a inizio', // il trigger non è in posizione 0
    'a=b', // '=' interno
    '', // stringa vuota
    'IT60X0542811101000000123456', // IBAN: inizia con lettera, innocuo
    '00184', // CAP numerico in stringa
  ])('lascia invariato %j', (input) => {
    expect(neutralizeCsvFormula(input)).toBe(input);
  });

  it('è idempotente solo nel senso giusto: una cella già-apicizzata NON viene ri-apicizzata', () => {
    // L'apice non è un trigger → "'=1+1" resta "'=1+1" (no doppio apice).
    expect(neutralizeCsvFormula("'=1+1")).toBe("'=1+1");
  });
});

describe('CSV_FORMULA_PREFIX — contratto del set di trigger', () => {
  it('matcha esattamente = + - @ TAB CR in posizione 0', () => {
    for (const c of ['=', '+', '-', '@', '\t', '\r']) {
      expect(CSV_FORMULA_PREFIX.test(`${c}x`)).toBe(true);
    }
  });
  it('NON matcha caratteri non-trigger in posizione 0', () => {
    for (const c of ['a', '0', ' ', '"', "'", '#', '\n']) {
      expect(CSV_FORMULA_PREFIX.test(`${c}x`)).toBe(false);
    }
  });
});
