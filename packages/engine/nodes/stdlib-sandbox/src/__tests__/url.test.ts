/**
 * Test url helpers — buildQuery/parseQuery/buildUrl/parseUrl/joinUrl.
 *
 * @module sandbox/__tests__/url
 */
import { describe, it, expect } from 'vitest';
import { buildQuery, parseQuery, buildUrl, parseUrl, joinUrl } from '../url.js';

describe('buildQuery', () => {
  it('happy: { a: 1, b: "x" } → "a=1&b=x"', () => {
    expect(buildQuery({ a: 1, b: 'x' })).toBe('a=1&b=x');
  });

  it('🚨 skip undefined/null (no "key=undefined" bug)', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: 0 })).toBe('a=1&d=0');
  });

  it('🚨 array → multiple entries', () => {
    expect(buildQuery({ tag: ['a', 'b', 'c'] })).toBe('tag=a&tag=b&tag=c');
  });

  it('🚨 special chars encoded', () => {
    expect(buildQuery({ q: 'hello world' })).toBe('q=hello+world');
    expect(buildQuery({ q: 'a&b=c' })).toMatch(/q=a%26b%3Dc/);
  });
});

describe('parseQuery', () => {
  it('happy: "a=1&b=x" → { a, b }', () => {
    expect(parseQuery('a=1&b=x')).toEqual({ a: '1', b: 'x' });
  });

  it('🚨 leading ? stripped', () => {
    expect(parseQuery('?a=1')).toEqual({ a: '1' });
  });

  it('🚨 ripeti key → array', () => {
    expect(parseQuery('tag=a&tag=b&tag=c')).toEqual({ tag: ['a', 'b', 'c'] });
  });

  it('🚨 empty value preservato', () => {
    expect(parseQuery('a=&b=x')).toEqual({ a: '', b: 'x' });
  });
});

describe('buildUrl', () => {
  it('base no query existing', () => {
    expect(buildUrl('https://x.com/path', { a: 1 })).toBe('https://x.com/path?a=1');
  });

  it('🚨 base con ? existing → usa &', () => {
    expect(buildUrl('https://x.com?z=0', { a: 1 })).toBe('https://x.com?z=0&a=1');
  });

  it('🚨 empty params → base unchanged', () => {
    expect(buildUrl('https://x.com', {})).toBe('https://x.com');
  });
});

describe('parseUrl', () => {
  it('parse completo', () => {
    const r = parseUrl('https://x.com:8080/api/v1?q=1#anchor');
    expect(r.protocol).toBe('https:');
    expect(r.host).toBe('x.com:8080');
    expect(r.port).toBe('8080');
    expect(r.path).toBe('/api/v1');
    expect(r.query).toEqual({ q: '1' });
    expect(r.hash).toBe('#anchor');
  });

  it('🚨 invalid URL → throw', () => {
    expect(() => parseUrl('not a url')).toThrow();
  });
});

describe('joinUrl', () => {
  it('happy', () => {
    expect(joinUrl('https://x.com', 'api/v1')).toBe('https://x.com/api/v1');
  });

  it('🚨 entrambi con slash', () => {
    expect(joinUrl('https://x.com/', '/api')).toBe('https://x.com/api');
  });

  it('🚨 nessuno con slash', () => {
    expect(joinUrl('https://x.com', 'api')).toBe('https://x.com/api');
  });
});

describe('🔁 round-trip buildQuery ↔ parseQuery', () => {
  it('roundtrip preserva semantica', () => {
    const obj = { a: '1', b: 'hello world', c: '&special=' };
    const qs = buildQuery(obj);
    const back = parseQuery(qs);
    expect(back).toEqual(obj);
  });
});
