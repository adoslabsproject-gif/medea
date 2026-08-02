/**
 * Test transform helpers — pick/omit/groupBy/sortBy/uniqBy/chunk/etc.
 *
 * @module sandbox/__tests__/transform
 */
import { describe, it, expect } from 'vitest';
import {
  pick,
  omit,
  groupBy,
  sortBy,
  uniqBy,
  chunk,
  deepClone,
  flatten,
  sum,
  avg,
  minBy,
  maxBy,
  range,
} from '../transform.js';

describe('pick', () => {
  it('happy path: { a, b, c } pick ["a", "b"]', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toEqual({ a: 1, b: 2 });
  });

  it('🚨 key non esistente → skipped (no undefined entry)', () => {
    const r = pick({ a: 1 }, ['a', 'b' as 'a']);
    expect(r).toEqual({ a: 1 });
    expect('b' in r).toBe(false);
  });

  it('🚨 prototype pollution: solo own props', () => {
    const obj = Object.create({ inherited: 'BAD' });
    obj.own = 'OK';
    const r = pick(obj, ['inherited' as never, 'own' as never] as never[]);
    expect(r).toEqual({ own: 'OK' });
    expect('inherited' in r).toBe(false);
  });
});

describe('omit', () => {
  it('happy path: { a, b, c } omit ["b"]', () => {
    expect(omit({ a: 1, b: 2, c: 3 }, ['b'])).toEqual({ a: 1, c: 3 });
  });

  it('omit all keys → {}', () => {
    expect(omit({ a: 1, b: 2 }, ['a', 'b'])).toEqual({});
  });
});

describe('groupBy', () => {
  it('by key', () => {
    const items = [
      { name: 'a', type: 'X' },
      { name: 'b', type: 'Y' },
      { name: 'c', type: 'X' },
    ];
    const r = groupBy(items, 'type');
    expect(r.X).toHaveLength(2);
    expect(r.Y).toHaveLength(1);
  });

  it('by function', () => {
    const r = groupBy([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? 'even' : 'odd'));
    expect(r.even).toEqual([2, 4]);
    expect(r.odd).toEqual([1, 3, 5]);
  });

  it('🚨 empty input → {}', () => {
    expect(groupBy([], (x) => String(x))).toEqual({});
  });
});

describe('sortBy', () => {
  it('numerico ascending', () => {
    expect(sortBy([3, 1, 2], (n) => n)).toEqual([1, 2, 3]);
  });

  it('string ascending', () => {
    expect(sortBy(['c', 'a', 'b'], (s) => s)).toEqual(['a', 'b', 'c']);
  });

  it('🚨 stable: items uguali mantengono ordine input', () => {
    const items = [
      { id: 1, key: 'X' },
      { id: 2, key: 'X' },
      { id: 3, key: 'Y' },
    ];
    const r = sortBy(items, (i) => i.key);
    expect(r[0]?.id).toBe(1);
    expect(r[1]?.id).toBe(2);
  });

  it('🚨 immutable: input non modificato', () => {
    const input = [3, 1, 2];
    sortBy(input, (n) => n);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('uniqBy', () => {
  it('default identity', () => {
    expect(uniqBy([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
  });

  it('with key fn', () => {
    const r = uniqBy([{ id: 1 }, { id: 2 }, { id: 1 }], (i) => i.id);
    expect(r).toHaveLength(2);
  });

  it('🚨 preserva primo occorrenza, scarta successivi', () => {
    const items = [
      { id: 1, name: 'first' },
      { id: 1, name: 'second' },
    ];
    expect(uniqBy(items, (i) => i.id)[0]?.name).toBe('first');
  });
});

describe('chunk', () => {
  it('happy path: 6 items chunked by 2', () => {
    expect(chunk([1, 2, 3, 4, 5, 6], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('last chunk parziale', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('🚨 size 0 → throw (no infinite loop)', () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow(/positive integer/);
  });

  it('🚨 size float → throw', () => {
    expect(() => chunk([1, 2, 3], 1.5)).toThrow(/positive integer/);
  });

  it('🚨 size negativo → throw', () => {
    expect(() => chunk([1, 2, 3], -1)).toThrow(/positive integer/);
  });
});

describe('deepClone', () => {
  it('clone nested object', () => {
    const a = { x: { y: { z: 1 } } };
    const b = deepClone(a);
    b.x.y.z = 99;
    expect(a.x.y.z).toBe(1);
  });

  it('🚨 Date persa (JSON.stringify limit)', () => {
    const d = new Date('2026-06-08');
    const cloned = deepClone({ d });
    expect(typeof cloned.d).toBe('string'); // Date → ISO string
  });
});

describe('flatten', () => {
  it('1 livello', () => {
    expect(flatten([[1, 2], [3], [4, 5]])).toEqual([1, 2, 3, 4, 5]);
  });

  it('🚨 NON ricorsivo (1 livello only)', () => {
    // @ts-expect-error - testing wrong type
    expect(flatten([[1, [2, 3]], [4]])).toEqual([1, [2, 3], 4]);
  });
});

describe('sum / avg', () => {
  it('sum [1,2,3] = 6', () => {
    expect(sum([1, 2, 3])).toBe(6);
  });
  it('sum [] = 0', () => {
    expect(sum([])).toBe(0);
  });
  it('avg [2,4,6] = 4', () => {
    expect(avg([2, 4, 6])).toBe(4);
  });
  it('🚨 avg [] = NaN (no DIV0 bug)', () => {
    expect(avg([])).toBeNaN();
  });
});

describe('minBy / maxBy', () => {
  it('minBy by id', () => {
    expect(minBy([{ id: 5 }, { id: 2 }, { id: 8 }], (i) => i.id)?.id).toBe(2);
  });

  it('maxBy by id', () => {
    expect(maxBy([{ id: 5 }, { id: 2 }, { id: 8 }], (i) => i.id)?.id).toBe(8);
  });

  it('🚨 empty → undefined (no crash)', () => {
    expect(minBy([], (x: number) => x)).toBeUndefined();
    expect(maxBy([], (x: number) => x)).toBeUndefined();
  });
});

describe('range', () => {
  it('range(5) = [0..4]', () => {
    expect(range(5)).toEqual([0, 1, 2, 3, 4]);
  });
  it('range(2,5) = [2,3,4]', () => {
    expect(range(2, 5)).toEqual([2, 3, 4]);
  });
  it('range(0,10,2) = [0,2,4,6,8]', () => {
    expect(range(0, 10, 2)).toEqual([0, 2, 4, 6, 8]);
  });
  it('🚨 range step=0 → throw', () => {
    expect(() => range(0, 5, 0)).toThrow();
  });
  it('🚨 reverse: range(5,0,-1) = [5,4,3,2,1]', () => {
    expect(range(5, 0, -1)).toEqual([5, 4, 3, 2, 1]);
  });
});
