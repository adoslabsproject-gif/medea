/**
 * Tests per safeParseJson — shared util workflow-engine contract.
 *
 * Invarianti CRITICALI:
 *  - undefined → null (back-compat invoke.ts/mcp.ts pre-refactor)
 *  - '' → null
 *  - non-string (object/array/number/boolean/null) → ritorna identico
 *  - string JSON valida → JSON.parse risultato
 *  - string non-JSON → ritorna la stringa come-is (no throw)
 *  - dimensione/profondita` JSON arbitraria gestita
 *  - parsing NON-recursive: se l'output e` `"\"hello\""` ritorna 'hello' (1 livello)
 */
import { describe, it, expect } from 'vitest';
import { safeParseJson } from './safe-parse-json.js';

describe('safeParseJson — null/undefined/empty', () => {
  it('undefined → null (compat consumer pre-refactor)', () => {
    expect(safeParseJson(undefined)).toBeNull();
  });

  it('empty string → null', () => {
    expect(safeParseJson('')).toBeNull();
  });

  it('null in input → null in output (no-op, non-string)', () => {
    expect(safeParseJson(null)).toBeNull();
  });
});

describe('safeParseJson — string JSON valida', () => {
  it('object stringificato → object', () => {
    const obj = { foo: 'bar', n: 42, nested: { x: true } };
    expect(safeParseJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('array stringificato → array', () => {
    expect(safeParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('numero stringificato → numero (no string)', () => {
    expect(safeParseJson('42')).toBe(42);
  });

  it('boolean stringificato → boolean', () => {
    expect(safeParseJson('true')).toBe(true);
    expect(safeParseJson('false')).toBe(false);
  });

  it('null stringificato → null', () => {
    expect(safeParseJson('null')).toBeNull();
  });

  it('string-in-string stringificata → string (no double-unwrap)', () => {
    // JSON.stringify('hello') = '"hello"'. safeParseJson lo deserializza UNA volta.
    expect(safeParseJson('"hello"')).toBe('hello');
  });
});

describe('safeParseJson — string non-JSON', () => {
  it('string semplice non-JSON → ritorna stringa as-is (no throw)', () => {
    expect(safeParseJson('garbage{')).toBe('garbage{');
  });

  it('HTML stringificato non valido → ritorna as-is', () => {
    expect(safeParseJson('<h1>Hi</h1>')).toBe('<h1>Hi</h1>');
  });

  it('JSON troncato → ritorna stringa rotta as-is', () => {
    expect(safeParseJson('{"foo": ')).toBe('{"foo": ');
  });
});

describe('safeParseJson — input gia` non-string', () => {
  it('object → ritorna identico (no-op se gia` deserializzato)', () => {
    const obj = { foo: 'bar' };
    expect(safeParseJson(obj)).toBe(obj); // referenziale: stesso ref
  });

  it('array → ritorna identico', () => {
    const arr = [1, 2, 3];
    expect(safeParseJson(arr)).toBe(arr);
  });

  it('numero → ritorna identico', () => {
    expect(safeParseJson(42)).toBe(42);
  });

  it('boolean → ritorna identico', () => {
    expect(safeParseJson(true)).toBe(true);
    expect(safeParseJson(false)).toBe(false);
  });
});

describe('safeParseJson — payload realistici workflow-engine', () => {
  it('step.output webhook-respond serializzato → object {__webhookResponse: ...}', () => {
    const original = {
      __webhookResponse: {
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<h1>Hello</h1>',
        bodyIsBase64: false,
        headers: { 'X-Custom': '1' },
      },
    };
    const wireFormat = JSON.stringify(original);
    expect(safeParseJson(wireFormat)).toEqual(original);
  });

  it('step.output DB query lookup → object {rows, rowCount}', () => {
    const original = { rows: [{ email: 'info@test.it' }], rowCount: 1 };
    expect(safeParseJson(JSON.stringify(original))).toEqual(original);
  });

  it('payload nested deep (4 livelli) preservato', () => {
    const original = { a: { b: { c: { d: 'deep' } } } };
    expect(safeParseJson(JSON.stringify(original))).toEqual(original);
  });
});
