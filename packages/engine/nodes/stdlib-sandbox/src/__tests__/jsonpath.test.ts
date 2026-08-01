/**
 * Test jsonpath get/set/has.
 *
 * @module sandbox/__tests__/jsonpath
 */
import { describe, it, expect } from 'vitest';
import { get, getOr, set, has } from '../jsonpath.js';

describe('get', () => {
  it('happy: a.b.c', () => {
    expect(get({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('array index', () => {
    expect(get({ items: [{ id: 1 }, { id: 2 }] }, 'items[0].id')).toBe(1);
    expect(get({ items: [{ id: 1 }, { id: 2 }] }, 'items[1].id')).toBe(2);
  });

  it('🚨 negative index from end', () => {
    expect(get({ items: [1, 2, 3] }, 'items[-1]')).toBe(3);
    expect(get({ items: [1, 2, 3] }, 'items[-2]')).toBe(2);
  });

  it('🚨 missing path → undefined (no throw)', () => {
    expect(get({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(get({}, 'x')).toBeUndefined();
  });

  it('🚨 null intermediate → undefined safe', () => {
    expect(get({ a: null }, 'a.b')).toBeUndefined();
  });

  it('bracket prop access ["weird key"]', () => {
    expect(get({ 'weird key': 'X' }, "['weird key']")).toBe('X');
  });

  it('🚨 unclosed bracket → throw', () => {
    expect(() => get({}, 'a[')).toThrow(/unclosed/);
  });

  it('🚨 invalid bracket → throw', () => {
    expect(() => get({}, 'a[abc]')).toThrow(/invalid bracket/);
  });
});

describe('getOr', () => {
  it('fallback se undefined', () => {
    expect(getOr({}, 'x', 'default')).toBe('default');
  });

  it('fallback se null', () => {
    expect(getOr({ x: null }, 'x', 'default')).toBe('default');
  });

  it('NO fallback se 0 (valid falsy)', () => {
    expect(getOr({ x: 0 }, 'x', 99)).toBe(0);
  });
});

describe('set', () => {
  it('happy: set deep path', () => {
    const r = set({}, 'a.b.c', 42);
    expect(r).toEqual({ a: { b: { c: 42 } } });
  });

  it('🚨 immutable: input non modificato', () => {
    const input = { a: { b: 1 } };
    const r = set(input, 'a.b', 999);
    expect(input).toEqual({ a: { b: 1 } });
    expect(r).toEqual({ a: { b: 999 } });
  });

  it('set array element', () => {
    const r = set({ items: [1, 2, 3] }, 'items[1]', 99);
    expect(r).toEqual({ items: [1, 99, 3] });
  });

  it('🚨 create nested array if missing', () => {
    const r = set({}, 'items[0].id', 'X');
    expect(r).toEqual({ items: [{ id: 'X' }] });
  });
});

describe('has', () => {
  it('true se path existe', () => {
    expect(has({ a: { b: 1 } }, 'a.b')).toBe(true);
  });

  it('🚨 true anche se valore null', () => {
    expect(has({ a: null }, 'a')).toBe(true);
  });

  it('false se path missing', () => {
    expect(has({ a: 1 }, 'a.b')).toBe(false);
  });

  it('array bound check', () => {
    expect(has({ items: [1, 2] }, 'items[0]')).toBe(true);
    expect(has({ items: [1, 2] }, 'items[5]')).toBe(false);
  });
});
