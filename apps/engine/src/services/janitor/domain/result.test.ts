/**
 * Test 2026-grade — domain/result.ts (Result<T,E> discriminated union).
 *
 * 🚨 DOCTRINE: throw per errori sistemici, Result per dominio.
 *    Bug = silent fall-through di Err → use case ignora errore atteso.
 *
 * 🚨 mapResult: trasforma value, propaga error.
 *
 * 🚨 andThen: chain operazioni fallibili (flatMap stile Rust).
 *
 * 🚨 combineResults: fail-fast su primo Err (no aggregate).
 */
import { describe, it, expect } from 'vitest';
import { Ok, Err, mapResult, andThen, combineResults } from './result.js';

describe('🚨 Ok / Err — discriminated union', () => {
  it('🚨 Ok ha ok=true + value', () => {
    const r = Ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('🚨 Err ha ok=false + error', () => {
    const r = Err('boom');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('boom');
  });

  it('🚨 Ok generico (oggetto)', () => {
    const r = Ok({ name: 'foo' });
    if (r.ok) expect(r.value.name).toBe('foo');
  });

  it('🚨 Err generico (Error instance)', () => {
    const e = new Error('fail');
    const r = Err(e);
    if (!r.ok) expect(r.error).toBe(e);
  });
});

describe('🚨 mapResult — transform value', () => {
  it('🚨 ok → applica f e ritorna Ok', () => {
    const r = mapResult(Ok(5), (v) => v * 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(10);
  });

  it('🚨 err → NON chiama f, propaga error', () => {
    let called = false;
    const r = mapResult(Err('fail'), () => {
      called = true;
      return 'never';
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('fail');
  });

  it('🚨 type narrowing: ok → value typed', () => {
    const r = mapResult(Ok('hello'), (s) => s.length);
    if (r.ok) expect(r.value).toBe(5);
  });
});

describe('🚨 andThen — flatMap chain', () => {
  it('🚨 ok → applica f e ritorna nuovo Result', () => {
    const r = andThen(Ok(5), (v) => Ok(v + 1));
    if (r.ok) expect(r.value).toBe(6);
  });

  it('🚨 ok → f può ritornare Err', () => {
    const r = andThen(Ok(5), () => Err('downstream-fail'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('downstream-fail');
  });

  it('🚨 err → propaga senza chiamare f', () => {
    let called = false;
    const r = andThen(Err('initial'), () => {
      called = true;
      return Ok(1);
    });
    expect(called).toBe(false);
    if (!r.ok) expect(r.error).toBe('initial');
  });

  it('🚨 chain multipla', () => {
    const r = andThen(
      andThen(Ok(2), (v) => Ok(v + 1)),
      (v) => Ok(v * 10),
    );
    if (r.ok) expect(r.value).toBe(30);
  });

  it('🚨 chain interrotta dal primo Err', () => {
    let secondCalled = false;
    const r = andThen(
      andThen(Ok(2), () => Err('mid-fail')),
      () => {
        secondCalled = true;
        return Ok(999);
      },
    );
    expect(secondCalled).toBe(false);
    if (!r.ok) expect(r.error).toBe('mid-fail');
  });
});

describe('🚨 combineResults — fail-fast collection', () => {
  it('🚨 tutti Ok → Ok([values])', () => {
    const r = combineResults([Ok(1), Ok(2), Ok(3)]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([1, 2, 3]);
  });

  it('🚨 primo Err → ritorna Err (fail-fast)', () => {
    const r = combineResults([Ok(1), Err('fail-at-2'), Ok(3)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('fail-at-2');
  });

  it('🚨 SOLO primo Err riportato (non aggregati)', () => {
    const r = combineResults([Err('e1'), Err('e2'), Err('e3')]);
    if (!r.ok) expect(r.error).toBe('e1');
  });

  it('🚨 array vuoto → Ok([])', () => {
    const r = combineResults([]);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('🚨 singolo Ok → Ok([value])', () => {
    const r = combineResults([Ok('only')]);
    if (r.ok) expect(r.value).toEqual(['only']);
  });

  it('🚨 ordine preservato', () => {
    const r = combineResults([Ok('a'), Ok('b'), Ok('c'), Ok('d')]);
    if (r.ok) expect(r.value).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('🚨 Combinazione idiomatic — Result come builder', () => {
  it('🚨 pipeline parse → validate → transform', () => {
    interface Parsed { n: number }
    const parse = (s: string): ReturnType<typeof Ok<Parsed>> | ReturnType<typeof Err<string>> => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? Err('not-a-number') : Ok({ n });
    };
    const validate = (p: Parsed) =>
      p.n > 0 ? Ok(p) : Err('not-positive');
    const double = (p: Parsed) => ({ n: p.n * 2 });

    const happy = mapResult(andThen(parse('5'), validate), double);
    if (happy.ok) expect(happy.value.n).toBe(10);

    const sadParse = mapResult(andThen(parse('xx'), validate), double);
    expect(sadParse.ok).toBe(false);

    const sadValidate = mapResult(andThen(parse('-3'), validate), double);
    expect(sadValidate.ok).toBe(false);
    if (!sadValidate.ok) expect(sadValidate.error).toBe('not-positive');
  });
});
