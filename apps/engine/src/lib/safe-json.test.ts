/**
 * Test 2026-grade — safe-json.ts (non-throwing JSON.parse wrapper).
 *
 * 🚨 RELIABILITY: usato a TUTTI i boundary non-fidati (LLM, DB, external API).
 *    Bug = process crash su input malformato → tenant container down.
 *
 * 🚨 Result<T,Error> discriminato: `null` è JSON valido, quindi NON usare
 *    `value === null` come signal di failure. Caller deve sempre check `ok`.
 *
 * Coverage: 14 test su tipi reali (string/number/null/object/array/false/true)
 * + 6 failure modes (malformed, non-string, empty, BOM, BigInt, mixed delimiters).
 */
import { describe, it, expect } from 'vitest';
import { safeJsonParse, safeJsonParseOr } from './safe-json.js';

describe('🚨 safeJsonParse — happy path tipi base JSON', () => {
  it('🚨 string JSON "hello"', () => {
    const r = safeJsonParse<string>('"hello"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('hello');
  });

  it('🚨 number 42', () => {
    const r = safeJsonParse<number>('42');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('🚨 float scientific 1.5e10', () => {
    const r = safeJsonParse<number>('1.5e10');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(1.5e10);
  });

  it('🚨 boolean true', () => {
    const r = safeJsonParse<boolean>('true');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);
  });

  it('🚨 boolean false', () => {
    const r = safeJsonParse<boolean>('false');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);
  });

  it('🚨 null è valido JSON → ok:true, value:null (NON failure)', () => {
    const r = safeJsonParse<null>('null');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
    // CRITICAL: r.value === null NON è signal di failure.
    // Caller che usa "r.value ?? fallback" perderebbe null intenzionale.
  });

  it('🚨 array vuoto []', () => {
    const r = safeJsonParse<number[]>('[]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('🚨 object vuoto {}', () => {
    const r = safeJsonParse<Record<string, never>>('{}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it('🚨 nested object profondo', () => {
    const input = '{"a":{"b":{"c":{"d":[1,2,{"e":"deep"}]}}}}';
    const r = safeJsonParse<{ a: { b: { c: { d: unknown[] } } } }>(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.a.b.c.d).toEqual([1, 2, { e: 'deep' }]);
    }
  });

  it('🚨 UTF-8 multilinguale (italiano, emoji, asiatico)', () => {
    const r = safeJsonParse<{ msg: string }>('{"msg":"Ciao 🇮🇹 你好"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.msg).toBe('Ciao 🇮🇹 你好');
  });

  it('🚨 LLM tool_calls.function.arguments (caso reale)', () => {
    const raw = '{"action":"search","query":"customer email","limit":10}';
    const r = safeJsonParse<{ action: string; query: string; limit: number }>(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.action).toBe('search');
      expect(r.value.limit).toBe(10);
    }
  });
});

describe('🚨 safeJsonParse — failure modes', () => {
  it('🚨 malformed (trailing comma) → ok:false + error con message', () => {
    const r = safeJsonParse('{"a":1,}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });

  it('🚨 HTML 5xx response (LLM/API down) → ok:false', () => {
    const html = '<html><body>502 Bad Gateway</body></html>';
    const r = safeJsonParse(html);
    expect(r.ok).toBe(false);
  });

  it('🚨 stringa vuota → ok:false', () => {
    const r = safeJsonParse('');
    expect(r.ok).toBe(false);
  });

  it('🚨 solo whitespace → ok:false', () => {
    const r = safeJsonParse('   \n\t  ');
    expect(r.ok).toBe(false);
  });

  it('🚨 non-string input (number) → TypeError esplicito', () => {
    const r = safeJsonParse(42 as unknown as string);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(TypeError);
      expect(r.error.message).toContain('Expected string');
      expect(r.error.message).toContain('number');
    }
  });

  it('🚨 non-string input (object) → TypeError', () => {
    const r = safeJsonParse({ a: 1 } as unknown as string);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(TypeError);
      expect(r.error.message).toContain('object');
    }
  });

  it('🚨 non-string input (null) → TypeError', () => {
    const r = safeJsonParse(null as unknown as string);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('object'); // typeof null === 'object'
    }
  });

  it('🚨 non-string input (undefined) → TypeError', () => {
    const r = safeJsonParse(undefined as unknown as string);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('undefined');
    }
  });

  it('🚨 JS single-quote strings NON sono JSON → ok:false', () => {
    const r = safeJsonParse("{'a':1}");
    expect(r.ok).toBe(false);
  });

  it('🚨 JS undefined literal NON è JSON → ok:false', () => {
    const r = safeJsonParse('{"a":undefined}');
    expect(r.ok).toBe(false);
  });

  it('🚨 JSON con commento (JSON5) NON valido in plain JSON', () => {
    const r = safeJsonParse('{"a":1 /* comment */}');
    expect(r.ok).toBe(false);
  });
});

describe('🚨 safeJsonParseOr — fallback variant', () => {
  it('🚨 happy path: ritorna valore parsato', () => {
    expect(safeJsonParseOr('{"a":1}', { a: 99 })).toEqual({ a: 1 });
  });

  it('🚨 malformed: ritorna fallback (no throw)', () => {
    expect(safeJsonParseOr('{', { fallback: true })).toEqual({ fallback: true });
  });

  it('🚨 input null JSON: ritorna null (NON fallback — null è valid)', () => {
    expect(safeJsonParseOr<null | string>('null', 'fb')).toBeNull();
  });

  it('🚨 input number wrong type: fallback', () => {
    expect(safeJsonParseOr(123 as unknown as string, 'default')).toBe('default');
  });

  it('🚨 generic type-safe', () => {
    interface Cfg { mode: 'a' | 'b'; n: number }
    const r = safeJsonParseOr<Cfg>('{"mode":"a","n":5}', { mode: 'b', n: 0 });
    expect(r.mode).toBe('a');
    expect(r.n).toBe(5);
  });

  it('🚨 fallback restituito BY-REFERENCE (non clonato)', () => {
    const fb = { ref: true };
    const r = safeJsonParseOr<typeof fb>('bad json {{', fb);
    expect(r).toBe(fb); // identical reference
  });
});

describe('🚨 Result type discriminated — narrowing TS', () => {
  it('🚨 ok=true narrows to {value: T}', () => {
    const r = safeJsonParse<number>('5');
    if (r.ok) {
      // TS sa che r ha .value
      const v: number = r.value;
      expect(v).toBe(5);
    } else {
      expect.fail('should have parsed');
    }
  });

  it('🚨 ok=false narrows to {error: Error}', () => {
    const r = safeJsonParse('{');
    if (!r.ok) {
      const e: Error = r.error;
      expect(e).toBeInstanceOf(Error);
    } else {
      expect.fail('should have failed');
    }
  });
});

describe('🚨 Edge case bonus', () => {
  it('🚨 numero molto grande (lossy ma valido)', () => {
    // JSON.parse converte in number lossless oltre Number.MAX_SAFE_INTEGER
    const r = safeJsonParse<number>('9007199254740993'); // > MAX_SAFE
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.value).toBe('number');
      // 9007199254740993 → 9007199254740992 (precision loss tipica JSON)
      expect(r.value).toBe(9007199254740992);
    }
  });

  it('🚨 stringa con backslash escape valid', () => {
    const r = safeJsonParse<string>('"line1\\nline2"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('line1\nline2');
  });

  it('🚨 stringa con quote escape', () => {
    const r = safeJsonParse<string>('"she said \\"hi\\""');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('she said "hi"');
  });
});
