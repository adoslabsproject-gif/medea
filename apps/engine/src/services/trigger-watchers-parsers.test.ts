/**
 * Unit tests for the IMAP trigger config parsers — markSeen mode + sender
 * allowlist. Both are critical for idempotency and security and used to
 * be inline code, now exported pure functions to make them testable.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkSeen, parseAllowlist, resolveJsonPointer } from './trigger-watchers.service.js';

describe('resolveJsonPointer (RFC 6901 — filtro trigger WebSocket)', () => {
  const doc = { type: 'trade', data: { price: 42, tags: ['a', 'b'] }, 'a/b': 1, 'm~n': 2 };

  it('pointer vuoto → documento intero', () => {
    expect(resolveJsonPointer(doc, '')).toBe(doc);
  });
  it('naviga oggetti annidati', () => {
    expect(resolveJsonPointer(doc, '/type')).toBe('trade');
    expect(resolveJsonPointer(doc, '/data/price')).toBe(42);
  });
  it('indicizza array', () => {
    expect(resolveJsonPointer(doc, '/data/tags/0')).toBe('a');
    expect(resolveJsonPointer(doc, '/data/tags/1')).toBe('b');
  });
  it('undefined se il path non risolve (filtro → no run)', () => {
    expect(resolveJsonPointer(doc, '/missing')).toBeUndefined();
    expect(resolveJsonPointer(doc, '/data/nope')).toBeUndefined();
    expect(resolveJsonPointer(doc, '/data/tags/9')).toBeUndefined(); // out of range
    expect(resolveJsonPointer(doc, '/type/x')).toBeUndefined(); // discende in primitivo
  });
  it('pointer non valido (senza / iniziale) → undefined', () => {
    expect(resolveJsonPointer(doc, 'type')).toBeUndefined();
  });
  it('token escaping ~1→/ e ~0→~', () => {
    expect(resolveJsonPointer(doc, '/a~1b')).toBe(1); // chiave "a/b"
    expect(resolveJsonPointer(doc, '/m~0n')).toBe(2); // chiave "m~n"
  });
  it('valore falsy 0/false è un match valido (non undefined)', () => {
    expect(resolveJsonPointer({ n: 0, f: false }, '/n')).toBe(0);
    expect(resolveJsonPointer({ n: 0, f: false }, '/f')).toBe(false);
  });
});

describe('parseMarkSeen', () => {
  it('returns the literal mode when valid', () => {
    expect(parseMarkSeen('on-success')).toBe('on-success');
    expect(parseMarkSeen('always')).toBe('always');
    expect(parseMarkSeen('never')).toBe('never');
  });

  it('maps legacy boolean=true to "always" (back-compat)', () => {
    expect(parseMarkSeen(true)).toBe('always');
    expect(parseMarkSeen('true')).toBe('always');
  });

  it('defaults to "on-success" for unknown / missing / falsy input', () => {
    expect(parseMarkSeen(undefined)).toBe('on-success');
    expect(parseMarkSeen(null)).toBe('on-success');
    expect(parseMarkSeen(false)).toBe('on-success');
    expect(parseMarkSeen('')).toBe('on-success');
    expect(parseMarkSeen('bogus')).toBe('on-success');
    expect(parseMarkSeen(42)).toBe('on-success');
  });
});

describe('parseAllowlist', () => {
  it('parses a JSON array string', () => {
    expect(parseAllowlist('["a@x.com","b@y.com"]')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('parses a comma-separated string', () => {
    expect(parseAllowlist('a@x.com, b@y.com,c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('parses a semicolon-separated string', () => {
    expect(parseAllowlist('a@x.com; b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('parses a newline-separated string', () => {
    expect(parseAllowlist('a@x.com\nb@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('accepts an already-parsed string array', () => {
    expect(parseAllowlist(['a@x.com', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns [] for null/undefined/empty', () => {
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });

  it('returns [] for non-string non-array input', () => {
    expect(parseAllowlist(42)).toEqual([]);
    expect(parseAllowlist({})).toEqual([]);
    expect(parseAllowlist(true)).toEqual([]);
  });

  it('falls back to literal string when JSON parsing fails on bracket-prefix', () => {
    // Defensive: a leading "[" that isn't valid JSON shouldn't crash.
    const r = parseAllowlist('[not-json');
    expect(Array.isArray(r)).toBe(true);
  });
});

// NB: i test di `buildImapAttachment` sono stati spostati (split 2026-06-12) nel
// modulo dedicato `trigger-watchers/imap-attachment.test.ts` (import diretto).
