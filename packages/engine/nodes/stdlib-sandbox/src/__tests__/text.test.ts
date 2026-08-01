/**
 * Test text helpers — slugify/truncate/escapeHtml/stripHtml/case converters.
 *
 * @module sandbox/__tests__/text
 */
import { describe, it, expect } from 'vitest';
import {
  slugify, truncate, escapeHtml, stripHtml,
  capitalize, toCamelCase, toSnakeCase, toKebabCase, approxTokenCount,
} from '../text.js';

describe('slugify', () => {
  it('happy: "Hello World" → "hello-world"', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('🚨 accented chars stripped: "café" → "cafe"', () => {
    expect(slugify('café')).toBe('cafe');
  });

  it('🚨 multiple separator collapsed', () => {
    expect(slugify('a---b  c__d')).toBe('a-b-c-d');
  });

  it('trim leading/trailing dashes', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('maxLength enforced', () => {
    expect(slugify('a'.repeat(100), 10)).toBe('a'.repeat(10));
  });

  it('🚨 empty input → ""', () => {
    expect(slugify('')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

describe('truncate', () => {
  it('happy: stringa più corta del max → unchanged', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('🚨 word-boundary preserved se ultimo space > 70% del cut', () => {
    // maxLength=20, ellipsis='…' (1 char) → cut=19. "supercalifragilistic " ha lastSpace
    // a 19 e 19 > 19*0.7=13.3 → trim al boundary.
    const r = truncate('supercalifragilistic expialidocious', 21);
    expect(r).toBe('supercalifragilistic…');
    expect(r.length).toBeLessThanOrEqual(21);
  });

  it('🚨 word-boundary NON applicato se troppo presto (< 70% cut) → hard cut', () => {
    // maxLength=12, ellipsis='…' → cut=11. 'hello wonde' lastSpace=5 < 11*0.7=7.7 → hard
    const r = truncate('hello wonderful world', 12);
    expect(r).toBe('hello wonde…');
    expect(r.length).toBe(12);
  });

  it('🚨 no word boundary → hard cut', () => {
    expect(truncate('supercalifragilisticexpialidocious', 10)).toBe('supercali…');
  });

  it('🚨 ellipsis custom', () => {
    expect(truncate('abcdefghij', 5, '..')).toBe('abc..');
  });

  it('🚨 maxLength < ellipsis length → ellipsis truncated', () => {
    expect(truncate('long', 1, '…')).toBe('…');
  });
});

describe('escapeHtml — anti-XSS', () => {
  it('& < > " \' tutti escaped', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it("apostrofo → &#39;", () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('🚨 & SEMPRE prima — no double-escape (&amp;lt; bug classico)', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('stripHtml', () => {
  it('rimuove tag', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
  });

  it('🚨 collassa whitespace', () => {
    expect(stripHtml('<p>a</p>\n  <p>b</p>')).toBe('a b');
  });
});

describe('case converters', () => {
  it('capitalize', () => {
    expect(capitalize('hello')).toBe('Hello');
    expect(capitalize('')).toBe('');
  });

  it('toCamelCase: my-var-name → myVarName', () => {
    expect(toCamelCase('my-var-name')).toBe('myVarName');
    expect(toCamelCase('my_var_name')).toBe('myVarName');
    expect(toCamelCase('my var name')).toBe('myVarName');
  });

  it('toSnakeCase: myVarName → my_var_name', () => {
    expect(toSnakeCase('myVarName')).toBe('my_var_name');
    expect(toSnakeCase('my-var-name')).toBe('my_var_name');
  });

  it('toKebabCase: myVarName → my-var-name', () => {
    expect(toKebabCase('myVarName')).toBe('my-var-name');
    expect(toKebabCase('my_var_name')).toBe('my-var-name');
  });
});

describe('approxTokenCount', () => {
  it('"hello world" = 2', () => {
    expect(approxTokenCount('hello world')).toBe(2);
  });

  it('puntuation conta separati', () => {
    expect(approxTokenCount('hello, world!')).toBe(4);
  });

  it('🚨 empty = 0', () => {
    expect(approxTokenCount('')).toBe(0);
    expect(approxTokenCount('   ')).toBe(0);
  });
});
