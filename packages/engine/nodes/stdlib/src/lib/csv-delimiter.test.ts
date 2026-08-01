/**
 * Test bug-bounty — rilevamento delimitatore CSV.
 * Copre: scelta del più frequente, fallback virgola, conteggio FUORI dalle
 * virgolette, normalizzazione di "\\t"/"tab", prima riga significativa.
 */
import { describe, it, expect } from 'vitest';
import { detectDelimiter, resolveDelimiter } from './csv-delimiter.js';

describe('detectDelimiter', () => {
  it('virgola', () => { expect(detectDelimiter('a,b,c\n1,2,3')).toBe(','); });
  it('punto-e-virgola (IT)', () => { expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';'); });
  it('tab (TSV)', () => { expect(detectDelimiter('a\tb\n1\t2')).toBe('\t'); });
  it('sceglie il più frequente quando ne compaiono più di uno', () => {
    // 2 ";" vs 1 "," nella prima riga → vince ";"
    expect(detectDelimiter('a;b;c,d\n')).toBe(';');
  });
  it('🚨 ignora i delimitatori dentro i campi quotati', () => {
    // ";" reali = 0, quelli tra virgolette non contano → fallback virgola (1 reale)
    expect(detectDelimiter('"a;b;c",d\n')).toBe(',');
  });
  it('nessun delimitatore → fallback virgola', () => {
    expect(detectDelimiter('singlecolumn\nvalue')).toBe(',');
  });
  it('campiona la PRIMA riga (gestisce CRLF)', () => {
    expect(detectDelimiter('a;b\r\n1;2')).toBe(';');
  });
});

describe('resolveDelimiter', () => {
  it('"auto"/vuoto → detect sul campione', () => {
    expect(resolveDelimiter('auto', 'a;b')).toBe(';');
    expect(resolveDelimiter('', 'a,b')).toBe(',');
    expect(resolveDelimiter(undefined, 'a\tb')).toBe('\t');
  });
  it('esplicito ";" e "\\t"/"tab" normalizzati', () => {
    expect(resolveDelimiter(';', '')).toBe(';');
    expect(resolveDelimiter('\\t', '')).toBe('\t');
    expect(resolveDelimiter('tab', '')).toBe('\t');
    expect(resolveDelimiter('\t', '')).toBe('\t');
  });
  it('valore ignoto → virgola (default sicuro)', () => {
    expect(resolveDelimiter('|', '')).toBe(',');
    expect(resolveDelimiter(42, '')).toBe(',');
  });
});
