/**
 * parseIntParam — test bug-bounty + anti-regressione (finding #10).
 *
 * Ogni caso rotto è un test che DEVE fallire sul codice pre-fix
 * (`Number(raw)` nudo): NaN, input non-numerico, overflow, negativi, float.
 */
import { describe, it, expect } from 'vitest';
import { parseIntParam } from './query-int.js';

const B = { def: 50, min: 1, max: 200 } as const;

describe('parseIntParam — happy path', () => {
  it('intero valido nell’intervallo → invariato', () => {
    expect(parseIntParam('100', B)).toBe(100);
  });
  it('min e max inclusi', () => {
    expect(parseIntParam('1', B)).toBe(1);
    expect(parseIntParam('200', B)).toBe(200);
  });
});

describe('parseIntParam — bug-bounty input rotti', () => {
  it('undefined → def', () => {
    expect(parseIntParam(undefined, B)).toBe(50);
  });
  it('null → def', () => {
    expect(parseIntParam(null, B)).toBe(50);
  });
  it('stringa vuota / whitespace → def', () => {
    expect(parseIntParam('', B)).toBe(50);
    expect(parseIntParam('   ', B)).toBe(50);
  });
  it('🚨 non-numerico "abc" → def (NON NaN)', () => {
    const r = parseIntParam('abc', B);
    expect(Number.isNaN(r)).toBe(false);
    expect(r).toBe(50);
  });
  it('🚨 "12abc" → def (Number, non parseInt che darebbe 12)', () => {
    expect(parseIntParam('12abc', B)).toBe(50);
  });
  it('🚨 overflow "9e9" → clamp a max', () => {
    expect(parseIntParam('9e9', B)).toBe(200);
  });
  it('🚨 Infinity → def (non finito)', () => {
    expect(parseIntParam('Infinity', B)).toBe(50);
    expect(parseIntParam('-Infinity', B)).toBe(50);
  });
  it('🚨 NaN literal → def', () => {
    expect(parseIntParam('NaN', B)).toBe(50);
  });
  it('negativo sotto min → clamp a min', () => {
    expect(parseIntParam('-5', B)).toBe(1);
  });
  it('float → troncato poi clampato', () => {
    expect(parseIntParam('3.99', B)).toBe(3);
    expect(parseIntParam('199.9', B)).toBe(199);
  });
  it('offset con min 0 → -0 normalizzato a 0 (Object.is)', () => {
    const r = parseIntParam('-0', { def: 0, min: 0, max: 1000 });
    expect(Object.is(r, -0)).toBe(false);
    expect(r).toBe(0);
  });
  it('esadecimale "0x10" → 16 (Number lo parsa) clampato', () => {
    // Number('0x10') === 16 — comportamento documentato, entro i bounds.
    expect(parseIntParam('0x10', B)).toBe(16);
  });
});
