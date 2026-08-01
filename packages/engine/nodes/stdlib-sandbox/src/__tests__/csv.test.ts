/**
 * Test parseCsv + stringifyCsv — RFC 4180 compliance VERITIERO.
 *
 * Coverage: quote escape "" interno, BOM UTF-8, CRLF/LF, fields con
 * delimiter/newline interno, header on/off, trim, empty record finale,
 * round-trip identity.
 *
 * @module sandbox/__tests__/csv
 */
import { describe, it, expect } from 'vitest';
import { parseCsv, stringifyCsv } from '../csv.js';

describe('parseCsv — happy path', () => {
  it('header simple: name,age\\nalice,30', () => {
    const r = parseCsv('name,age\nalice,30\nbob,25');
    expect(r).toEqual([
      { name: 'alice', age: '30' },
      { name: 'bob', age: '25' },
    ]);
  });

  it('no header → array di array', () => {
    const r = parseCsv('a,b,c\n1,2,3', { hasHeader: false });
    expect(r).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('custom delimiter ;', () => {
    const r = parseCsv('a;b\n1;2', { delimiter: ';' });
    expect(r).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('🚨 parseCsv — RFC 4180 edge cases (anti-regression)', () => {
  it('quote escape "" interno: "alice ""rocks"""', () => {
    const r = parseCsv('name\n"alice ""rocks"""');
    expect(r).toEqual([{ name: 'alice "rocks"' }]);
  });

  it('field con virgola interna preserva la virgola', () => {
    const r = parseCsv('name,note\n"alice","hello, world"');
    expect(r).toEqual([{ name: 'alice', note: 'hello, world' }]);
  });

  it('field con newline interna preserva il newline', () => {
    const r = parseCsv('name,note\n"alice","line1\nline2"');
    expect(r).toEqual([{ name: 'alice', note: 'line1\nline2' }]);
  });

  it('CRLF line endings', () => {
    const r = parseCsv('a,b\r\n1,2\r\n3,4');
    expect(r).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('CR-only (legacy Mac) line endings', () => {
    const r = parseCsv('a,b\r1,2\r3,4');
    expect(r).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('🚨 BOM UTF-8 stripped', () => {
    const r = parseCsv('﻿name,age\nalice,30');
    expect(r).toEqual([{ name: 'alice', age: '30' }]);
  });

  it('trailing newline → no spurious empty row', () => {
    const r = parseCsv('a\n1\n');
    expect(r).toEqual([{ a: '1' }]);
  });

  it('🚨 row con meno campi del header → missing fields = ""', () => {
    const r = parseCsv('a,b,c\n1,2');
    expect(r).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('trim=true → spazi rimossi attorno', () => {
    const r = parseCsv('a,b\n  1  , 2 ', { trimFields: true });
    expect(r).toEqual([{ a: '1', b: '2' }]);
  });

  it('🚨 empty input → []', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('', { hasHeader: false })).toEqual([]);
  });
});

describe('stringifyCsv — happy path', () => {
  it('array of objects con header inferito', () => {
    const out = stringifyCsv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
    expect(out).toBe('a,b\n1,x\n2,y');
  });

  it('header esplicito overrida order', () => {
    const out = stringifyCsv([{ a: 1, b: 'x' }], { header: ['b', 'a'] });
    expect(out).toBe('b,a\nx,1');
  });

  it('array of array (no header)', () => {
    const out = stringifyCsv([['a', 'b'], [1, 2]]);
    expect(out).toBe('a,b\n1,2');
  });

  it('🚨 quote field con virgola interna', () => {
    const out = stringifyCsv([{ note: 'hello, world' }]);
    expect(out).toBe('note\n"hello, world"');
  });

  it('🚨 quote field con quote interno (doubled)', () => {
    const out = stringifyCsv([{ note: 'alice "rocks"' }]);
    expect(out).toBe('note\n"alice ""rocks"""');
  });

  it('🚨 quote field con newline', () => {
    const out = stringifyCsv([{ note: 'line1\nline2' }]);
    expect(out).toBe('note\n"line1\nline2"');
  });

  it('null/undefined → "" (no "undefined" stringa)', () => {
    const out = stringifyCsv([{ a: 1, b: null, c: undefined }]);
    expect(out).toBe('a,b,c\n1,,');
  });

  it('quoteAll: true → tutti i field quoted', () => {
    const out = stringifyCsv([{ a: 1, b: 'x' }], { quoteAll: true });
    expect(out).toBe('"a","b"\n"1","x"');
  });

  it('newline custom \\r\\n', () => {
    const out = stringifyCsv([{ a: 1 }], { newline: '\r\n' });
    expect(out).toBe('a\r\n1');
  });
});

describe('🔁 round-trip identity (anti-regression)', () => {
  it('parse(stringify(X)) === X per dati comuni', () => {
    const data = [
      { name: 'alice', email: 'alice@x.com', note: 'hello' },
      { name: 'bob', email: 'bob@x.com', note: 'world' },
    ];
    const csv = stringifyCsv(data);
    const back = parseCsv(csv);
    expect(back).toEqual(data.map((d) => ({ name: d.name, email: d.email, note: d.note })));
  });

  it('🚨 round-trip preserva quote interne + comma interne + newline', () => {
    const data = [
      { complex: 'has "quotes", and\nnewlines' },
      { complex: 'simple' },
    ];
    const csv = stringifyCsv(data);
    const back = parseCsv(csv);
    expect(back).toEqual(data);
  });
});
