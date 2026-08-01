import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, map, flatMap, mapErr, unwrap, unwrapOr, fromTry, fromPromise, collect } from './result.js';

describe('Result<T, E>', () => {
  describe('constructors + type guards', () => {
    it('ok() produces success variant', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(42);
    });

    it('err() produces error variant', () => {
      const r = err('boom');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('boom');
    });

    it('isOk / isErr narrow correctly', () => {
      const r1 = ok(1);
      const r2 = err('x');
      expect(isOk(r1)).toBe(true);
      expect(isErr(r1)).toBe(false);
      expect(isOk(r2)).toBe(false);
      expect(isErr(r2)).toBe(true);
    });
  });

  describe('map', () => {
    it('transforms ok value', () => {
      const r = map(ok(5), (x) => x * 2);
      expect(r).toEqual({ ok: true, value: 10 });
    });

    it('passes through err', () => {
      const r = map(err<string, number>('e'), (x) => x * 2);
      expect(r).toEqual({ ok: false, error: 'e' });
    });
  });

  describe('flatMap', () => {
    it('chains ok->ok', () => {
      const r = flatMap(ok(5), (x) => ok(x + 1));
      expect(r).toEqual({ ok: true, value: 6 });
    });

    it('chains ok->err short-circuits', () => {
      const r = flatMap(ok(5), () => err<string, number>('boom'));
      expect(r).toEqual({ ok: false, error: 'boom' });
    });

    it('propagates initial err without calling fn', () => {
      let called = false;
      const r = flatMap(err<string, number>('e'), () => {
        called = true;
        return ok(1);
      });
      expect(r).toEqual({ ok: false, error: 'e' });
      expect(called).toBe(false);
    });
  });

  describe('mapErr', () => {
    it('transforms err value', () => {
      const r = mapErr(err<string, number>('e'), (s) => s.toUpperCase());
      expect(r).toEqual({ ok: false, error: 'E' });
    });

    it('passes through ok', () => {
      const r = mapErr(ok<number, string>(5), (s) => s.toUpperCase());
      expect(r).toEqual({ ok: true, value: 5 });
    });
  });

  describe('unwrap / unwrapOr', () => {
    it('unwrap returns value on ok', () => {
      expect(unwrap(ok(42))).toBe(42);
    });

    it('unwrap throws Error on err with Error', () => {
      expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
    });

    it('unwrap throws synthetic Error on err with non-Error', () => {
      expect(() => unwrap(err('weird'))).toThrow(/unwrap on Err/);
    });

    it('unwrapOr returns fallback on err', () => {
      expect(unwrapOr(err<string, number>('e'), 99)).toBe(99);
      expect(unwrapOr(ok(42), 99)).toBe(42);
    });
  });

  describe('fromTry', () => {
    it('captures success', () => {
      const r = fromTry(() => JSON.parse('{"a":1}'));
      expect(r).toEqual({ ok: true, value: { a: 1 } });
    });

    it('captures throw into err', () => {
      const r = fromTry(() => JSON.parse('not-json'));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(Error);
    });

    it('wraps non-Error throws into Error', () => {
      const r = fromTry(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string-thrown';
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe('string-thrown');
    });
  });

  describe('fromPromise', () => {
    it('captures resolved value', async () => {
      const r = await fromPromise(Promise.resolve(42));
      expect(r).toEqual({ ok: true, value: 42 });
    });

    it('captures rejection into err', async () => {
      const r = await fromPromise(Promise.reject(new Error('rejected')));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe('rejected');
    });

    it('wraps non-Error rejection', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Legacy reject pattern compatibile API esistente
      const r = await fromPromise(Promise.reject('str-reject'));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe('str-reject');
    });
  });

  describe('collect', () => {
    it('returns ok with all values when all ok', () => {
      const r = collect([ok(1), ok(2), ok(3)]);
      expect(r).toEqual({ ok: true, value: [1, 2, 3] });
    });

    it('short-circuits on first err', () => {
      const r = collect([ok(1), err<string, number>('boom'), ok(3)]);
      expect(r).toEqual({ ok: false, error: 'boom' });
    });

    it('handles empty input', () => {
      const r = collect<number, string>([]);
      expect(r).toEqual({ ok: true, value: [] });
    });
  });
});
