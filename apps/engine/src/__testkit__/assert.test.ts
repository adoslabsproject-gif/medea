/**
 * Test degli assertion helper — verificano sia il narrowing (compile-time,
 * implicito) sia il fallimento esplicito a runtime con messaggio parlante.
 */
import { describe, it, expect } from 'vitest';
import { assertDefined, at, first } from './assert.js';

describe('assertDefined', () => {
  it('valore definito → non lancia + restringe il tipo', () => {
    const v: string | undefined = 'x';
    expect(() => assertDefined(v)).not.toThrow();
    assertDefined(v);
    expect(v.length).toBe(1);
  });

  it('undefined → lancia con label', () => {
    expect(() => assertDefined(undefined, 'rule')).toThrowError(/rule è undefined/u);
  });

  it('null → distingue null da undefined', () => {
    expect(() => assertDefined(null, 'run')).toThrowError(/run è null/u);
  });

  it('0 / "" / false sono definiti', () => {
    expect(() => assertDefined(0)).not.toThrow();
    expect(() => assertDefined('')).not.toThrow();
    expect(() => assertDefined(false)).not.toThrow();
  });
});

describe('at', () => {
  it('indice valido → elemento tipizzato', () => {
    expect(at([{ id: 1 }, { id: 2 }], 1).id).toBe(2);
  });
  it('fuori range → lancia con indice + len', () => {
    expect(() => at([10], 5, 'rows')).toThrowError(/rows\[5\] è undefined \(len=1\)/u);
  });
});

describe('first', () => {
  it('non vuoto → primo', () => {
    expect(first(['a', 'b'])).toBe('a');
  });
  it('vuoto → lancia', () => {
    expect(() => first([], 'steps')).toThrowError(/steps\[0\] è undefined \(len=0\)/u);
  });
});
