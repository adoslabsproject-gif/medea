/**
 * Unit tests for the Excel formatter helpers: column-name → format
 * inference, ":format" syntax parsing, italian-locale value coercion.
 *
 * These are PURE functions — no exceljs / fs / node-fetch — so a single
 * vitest run covers the entire formatter logic without any I/O.
 */
import { describe, it, expect } from 'vitest';
import { inferFormatFromName, parseColumnsConfig, coerceForFormat, fmtCode } from './excel.js';

describe('inferFormatFromName', () => {
  it.each([
    ['DATA', 'date_dmy'],
    ['CONSEGNA', 'date_dmy'],
    ['SCADENZA', 'date_dmy'],
    ['SCONTO', 'percent_2'],
    ['IVA %', 'percent_2'],
    ['PREZZO UNITARIO', 'eur_4'],
    ['LISTINO', 'eur_4'],
    ['TOTALE RIGA', 'eur_2'],
    ['IMPORTO', 'eur_2'],
    ['NETTO', 'eur_2'],
    ['QUANTITA', 'integer'],
    ['QTA', 'integer'],
    ['CODICE', 'text'],
    ['SKU', 'text'],
    ['EAN', 'text'],
  ])('infers %s → %s', (name, expected) => {
    expect(inferFormatFromName(name)).toBe(expected);
  });

  it('returns "auto" for unknown columns', () => {
    expect(inferFormatFromName('DESCRIZIONE')).toBe('auto');
    expect(inferFormatFromName('NOTE')).toBe('auto');
    expect(inferFormatFromName('xyzzy')).toBe('auto');
  });

  it('is case-insensitive', () => {
    expect(inferFormatFromName('data')).toBe('date_dmy');
    expect(inferFormatFromName('Prezzo')).toBe('eur_4');
    expect(inferFormatFromName('totale')).toBe('eur_2');
  });
});

describe('parseColumnsConfig', () => {
  it('parses key:Label syntax with auto-inferred format', () => {
    const r = parseColumnsConfig('id:ID,prezzo:Prezzo,data:Data');
    expect(r).toEqual([
      { key: 'id', header: 'ID', format: 'text' },
      { key: 'prezzo', header: 'Prezzo', format: 'eur_4' },
      { key: 'data', header: 'Data', format: 'date_dmy' },
    ]);
  });

  it('honors explicit :format suffix', () => {
    const r = parseColumnsConfig('a:Header A:eur_2,b:Header B:percent_2');
    expect(r[0]?.format).toBe('eur_2');
    expect(r[1]?.format).toBe('percent_2');
  });

  it('rejects an unknown format and falls back to auto-inference', () => {
    const r = parseColumnsConfig('prezzo:Prezzo:bogus_format');
    expect(r[0]?.format).toBe('eur_4'); // inferred from "PREZZO"
  });

  it('preserves header whitespace correctly', () => {
    const r = parseColumnsConfig('a:Header con spazi:text');
    expect(r[0]?.header).toBe('Header con spazi');
  });

  it('drops entries with empty key', () => {
    const r = parseColumnsConfig(',valid:Valid,:OnlyLabel');
    expect(r).toHaveLength(1);
    expect(r[0]?.key).toBe('valid');
  });

  it('handles a single column', () => {
    expect(parseColumnsConfig('total:Total:eur_2')).toEqual([
      { key: 'total', header: 'Total', format: 'eur_2' },
    ]);
  });
});

describe('coerceForFormat', () => {
  describe('date_dmy', () => {
    it('keeps a Date object as-is', () => {
      const d = new Date(2026, 4, 23);
      expect(coerceForFormat(d, 'date_dmy')).toBe(d);
    });
    it('parses ISO YYYY-MM-DD strings', () => {
      const r = coerceForFormat('2026-05-23', 'date_dmy');
      expect(r).toBeInstanceOf(Date);
      expect((r as Date).getFullYear()).toBe(2026);
    });
    it('parses dd-mm-yyyy strings', () => {
      const r = coerceForFormat('23-05-2026', 'date_dmy');
      expect(r).toBeInstanceOf(Date);
      expect((r as Date).getMonth()).toBe(4); // May (0-indexed)
    });
    it('parses dd/mm/yyyy strings', () => {
      const r = coerceForFormat('23/05/2026', 'date_dmy');
      expect((r as Date).getDate()).toBe(23);
    });
    it('returns original value for unparseable input', () => {
      expect(coerceForFormat('not-a-date', 'date_dmy')).toBe('not-a-date');
    });
  });

  describe('percent_2', () => {
    it('smart-detects percentage-style numbers (>1) and divides by 100', () => {
      expect(coerceForFormat(10, 'percent_2')).toBe(0.1);
      expect(coerceForFormat(67.61, 'percent_2')).toBeCloseTo(0.6761, 4);
      expect(coerceForFormat(100, 'percent_2')).toBe(1.0);
    });
    it('preserves already-normalized decimals (≤1) untouched', () => {
      expect(coerceForFormat(0.5, 'percent_2')).toBe(0.5);
      expect(coerceForFormat(0.0762, 'percent_2')).toBe(0.0762);
    });
    it('parses italian decimals "10,50" → 0.105 (>1 path)', () => {
      expect(coerceForFormat('10,50', 'percent_2')).toBe(0.105);
    });
    it('strips "%" suffix before parsing', () => {
      expect(coerceForFormat('10%', 'percent_2')).toBe(0.1);
    });
  });

  describe('eur_4 / eur_2', () => {
    it('strips currency symbols and parses to number', () => {
      expect(coerceForFormat('€ 10,52', 'eur_4')).toBeCloseTo(10.52, 4);
      expect(coerceForFormat('10.52 €', 'eur_2')).toBeCloseTo(10.52, 2);
    });
    it('keeps a plain number untouched', () => {
      expect(coerceForFormat(1234.56, 'eur_2')).toBe(1234.56);
    });
    it('handles italian thousand separators "1.234,56" → 1234.56', () => {
      expect(coerceForFormat('1.234,56', 'eur_2')).toBeCloseTo(1234.56, 2);
    });
  });

  describe('integer', () => {
    it('truncates a float', () => {
      expect(coerceForFormat(10.9, 'integer')).toBe(10);
    });
    it('parses a numeric string', () => {
      expect(coerceForFormat('100', 'integer')).toBe(100);
    });
  });

  describe('text', () => {
    it('keeps strings as-is even when numeric (preserves leading zeros)', () => {
      expect(coerceForFormat('001234', 'text')).toBe('001234');
    });
  });

  describe('edge cases', () => {
    it('returns null/undefined/empty-string unchanged', () => {
      expect(coerceForFormat(null, 'eur_2')).toBe(null);
      expect(coerceForFormat(undefined, 'eur_2')).toBe(undefined);
      expect(coerceForFormat('', 'eur_2')).toBe('');
    });
    it('falls back to original value when number parse fails', () => {
      expect(coerceForFormat('abc', 'eur_2')).toBe('abc');
    });
  });
});

describe('fmtCode', () => {
  it.each([
    ['integer', '[$-410]#,##0'],
    ['number_2', '[$-410]#,##0.00'],
    ['number_4', '[$-410]#,##0.0000'],
    ['eur_2', '[$-410]#,##0.00\\ "€"'],
    ['eur_4', '[$-410]#,##0.0000\\ "€"'],
    ['percent_2', '[$-410]0.00%'],
    ['date_dmy', '[$-410]dd-mm-yyyy'],
    ['datetime', '[$-410]dd-mm-yyyy\\ hh:mm'],
    ['text', '@'],
    ['auto', ''],
  ] as const)('format %s → numFmt "%s"', (format, expected) => {
    expect(fmtCode(format)).toBe(expected);
  });
});
