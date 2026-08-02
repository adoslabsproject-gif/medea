import { describe, it, expect } from 'vitest';
import {
  safeString,
  safeNumber,
  asBool,
  parseKvJson,
  splitCsv,
  parseCsvInts,
  pick,
} from './safe-coerce.js';

describe('safeString', () => {
  it('null/undefined → ""', () => {
    expect(safeString(null)).toBe('');
    expect(safeString(undefined)).toBe('');
  });

  it('string passes through', () => {
    expect(safeString('hello')).toBe('hello');
  });

  it('number/boolean stringified', () => {
    expect(safeString(42)).toBe('42');
    expect(safeString(true)).toBe('true');
    expect(safeString(false)).toBe('false');
  });

  it('bigint stringified without "n"', () => {
    expect(safeString(BigInt(99))).toBe('99');
  });

  it('object JSON-encoded', () => {
    expect(safeString({ a: 1 })).toBe('{"a":1}');
  });

  it('circular ref → "[object]" (no throw)', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(safeString(a)).toBe('[object]');
  });
});

describe('safeNumber', () => {
  it('passes finite number through', () => {
    expect(safeNumber(42, 0)).toBe(42);
    expect(safeNumber(0, 99)).toBe(0);
    expect(safeNumber(-3.14, 0)).toBe(-3.14);
  });

  it('NaN/Infinity → fallback', () => {
    expect(safeNumber(NaN, 5)).toBe(5);
    expect(safeNumber(Infinity, 5)).toBe(5);
    expect(safeNumber(-Infinity, 5)).toBe(5);
  });

  it('numeric string coerced', () => {
    expect(safeNumber('42', 0)).toBe(42);
    expect(safeNumber('3.14', 0)).toBe(3.14);
  });

  it('non-numeric string → fallback', () => {
    expect(safeNumber('abc', 99)).toBe(99);
  });

  it('null/undefined → fallback', () => {
    expect(safeNumber(null, 99)).toBe(99);
    expect(safeNumber(undefined, 99)).toBe(99);
  });
});

describe('asBool', () => {
  it('true variants → true', () => {
    expect(asBool(true)).toBe(true);
    expect(asBool('true')).toBe(true);
    expect(asBool('TRUE')).toBe(true);
    expect(asBool(' true ')).toBe(true);
    expect(asBool('1')).toBe(true);
    expect(asBool('yes')).toBe(true);
    expect(asBool('on')).toBe(true);
    expect(asBool(1)).toBe(true);
  });

  it('false-ish → false', () => {
    expect(asBool(false)).toBe(false);
    expect(asBool('false')).toBe(false);
    expect(asBool('0')).toBe(false);
    expect(asBool('no')).toBe(false);
    expect(asBool(0)).toBe(false);
    expect(asBool(null)).toBe(false);
    expect(asBool(undefined)).toBe(false);
    expect(asBool({})).toBe(false);
    expect(asBool([])).toBe(false);
  });
});

describe('parseKvJson', () => {
  it('parses valid object JSON', () => {
    expect(parseKvJson('{"a":"1","b":"2"}')).toEqual({ a: '1', b: '2' });
  });

  it('stringifies non-string values', () => {
    expect(parseKvJson('{"port":8080,"enabled":true}')).toEqual({ port: '8080', enabled: 'true' });
  });

  it('skips null/undefined values', () => {
    expect(parseKvJson('{"a":null,"b":"x"}')).toEqual({ b: 'x' });
  });

  it('empty/non-string/invalid → {}', () => {
    expect(parseKvJson('')).toEqual({});
    expect(parseKvJson(null)).toEqual({});
    expect(parseKvJson(undefined)).toEqual({});
    expect(parseKvJson('not json')).toEqual({});
  });

  it('JSON array (not object) → {}', () => {
    expect(parseKvJson('[1,2]')).toEqual({});
  });

  it('JSON primitive → {}', () => {
    expect(parseKvJson('42')).toEqual({});
    expect(parseKvJson('"str"')).toEqual({});
  });
});

describe('splitCsv', () => {
  it('splits and trims', () => {
    expect(splitCsv('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty tokens', () => {
    expect(splitCsv('a,,b,')).toEqual(['a', 'b']);
  });

  it('empty/non-string → []', () => {
    expect(splitCsv('')).toEqual([]);
    expect(splitCsv('   ')).toEqual([]);
    expect(splitCsv(null)).toEqual([]);
    expect(splitCsv(42)).toEqual([]);
  });
});

describe('parseCsvInts', () => {
  it('parses integers, filters NaN', () => {
    expect(parseCsvInts('200, 201, abc, 204')).toEqual([200, 201, 204]);
  });

  it('handles negative integers', () => {
    expect(parseCsvInts('-1,-2,3')).toEqual([-1, -2, 3]);
  });

  it('empty → []', () => {
    expect(parseCsvInts('')).toEqual([]);
  });
});

describe('pick', () => {
  it('returns first non-empty string', () => {
    expect(pick('', null, 'first', 'second')).toBe('first');
  });

  it('coerces non-string candidates', () => {
    expect(pick(undefined, 42)).toBe('42');
  });

  it('returns "" when all empty', () => {
    expect(pick('', null, undefined)).toBe('');
  });
});
