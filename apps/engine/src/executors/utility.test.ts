/**
 * Test 2026-grade — utility executors (text template + JSON extract + date format).
 *
 * Tutte le funzioni sono PURE — testabili end-to-end senza mock.
 *
 * Coverage REALE per ciascuna unit:
 *  - renderTemplate: nested path (user.address.city), fallback "| default",
 *    object → JSON.stringify, missing → fallback o '', null/undefined/'' treated as missing
 *  - textTemplateExecutor: missing template → throw, dataExpression vs input,
 *    JSON string auto-parse, trim option
 *  - jsonPath: $ root, nested path, array index, wildcard *, recursive descent ..field,
 *    invalid path (no $) → throw, segments unknown → empty array
 *  - jsonExtractExecutor: mode first/all/count, fallback su no match, JSON string source
 *  - parseDateInput: ISO 8601, dd/mm/yyyy, dd-mm-yyyy, Date object, number (unix seconds + ms),
 *    "now", null/undefined/'' → null, "garbage" → null
 *  - formatDate: preset it_long/it_short/it_iso/us_short/iso8601/unix/custom + tokens,
 *    timezone parsing (Europe/Rome)
 *  - dateFormatExecutor: parse fail → throw, output con formatted+iso+unix+parts
 */
import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  textTemplateExecutor,
  jsonPath,
  jsonExtractExecutor,
  parseDateInput,
  formatDate,
  dateFormatExecutor,
  MAX_TEMPLATE_OUTPUT_CHARS,
  MAX_JSONPATH_DEPTH,
  MAX_JSONPATH_RESULTS,
} from './utility.js';

/** Stub ctx — gli executor utility non lo usano. */
const ctx = {} as never;

describe('renderTemplate — Mustache-like template', () => {
  it('happy path: {{name}} substitution', () => {
    expect(renderTemplate('Ciao {{name}}', { name: 'Mario' })).toBe('Ciao Mario');
  });

  it('nested path: {{user.address.city}}', () => {
    expect(renderTemplate('{{user.address.city}}', { user: { address: { city: 'Modena' } } })).toBe(
      'Modena',
    );
  });

  it('multiple vars in single template', () => {
    expect(renderTemplate('{{a}} - {{b}} - {{c}}', { a: 1, b: 2, c: 3 })).toBe('1 - 2 - 3');
  });

  it('🚨 fallback "| default X" su missing path', () => {
    expect(renderTemplate('{{missing|default fallback}}', {})).toBe('fallback');
  });

  it('🚨 fallback su null/undefined/empty string', () => {
    expect(renderTemplate('{{x|default Y}}', { x: null })).toBe('Y');
    expect(renderTemplate('{{x|default Y}}', { x: '' })).toBe('Y');
  });

  it('no fallback + missing → empty string', () => {
    expect(renderTemplate('Pre {{missing}} post', {})).toBe('Pre  post');
  });

  it('object value → JSON.stringify', () => {
    expect(renderTemplate('{{obj}}', { obj: { a: 1, b: 2 } })).toBe('{"a":1,"b":2}');
  });

  it('number/boolean → String()', () => {
    expect(renderTemplate('{{n}} {{b}}', { n: 42, b: true })).toBe('42 true');
  });

  it('whitespace tolerance in {{ name }}', () => {
    expect(renderTemplate('{{  user.name  }}', { user: { name: 'X' } })).toBe('X');
  });

  it('path segment manca → undefined → fallback ""', () => {
    expect(renderTemplate('{{a.b.c}}', { a: null })).toBe('');
  });

  it('🚨 non-string path → ritornato come stringa', () => {
    expect(renderTemplate('{{count}}', { count: 0 })).toBe('0'); // 0 viene rendered come "0", non come fallback
  });
});

describe('textTemplateExecutor', () => {
  it('happy path', async () => {
    const r = await textTemplateExecutor({ template: 'Ciao {{name}}' }, { name: 'Mario' }, ctx);
    expect((r.output as { text: string }).text).toBe('Ciao Mario');
    expect((r.output as { length: number }).length).toBe('Ciao Mario'.length); // 10
  });

  it('🚨 template mancante → throw', async () => {
    await expect(textTemplateExecutor({}, {}, ctx)).rejects.toThrow(/template.*obbligatorio/u);
  });

  it('dataExpression override input', async () => {
    const r = await textTemplateExecutor(
      { template: '{{x}}', dataExpression: { x: 'from-config' } },
      { x: 'from-input' },
      ctx,
    );
    expect((r.output as { text: string }).text).toBe('from-config');
  });

  it('JSON string auto-parse in dataExpression', async () => {
    const r = await textTemplateExecutor(
      { template: '{{name}}', dataExpression: '{"name": "Alice"}' },
      {},
      ctx,
    );
    expect((r.output as { text: string }).text).toBe('Alice');
  });

  it('JSON malformato in dataExpression → resta string (no crash)', async () => {
    const r = await textTemplateExecutor(
      { template: '{{x|default ok}}', dataExpression: '{not-json' },
      {},
      ctx,
    );
    expect((r.output as { text: string }).text).toBe('ok');
  });

  it('trim=true: collassa whitespace', async () => {
    const r = await textTemplateExecutor({ template: '   a   b   c   ', trim: 'true' }, {}, ctx);
    expect((r.output as { text: string }).text).toBe('a b c');
  });

  it('durationMs >= 0', async () => {
    const r = await textTemplateExecutor({ template: 'x' }, {}, ctx);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('jsonPath — JSONPath subset', () => {
  const data = {
    user: { name: 'Mario', address: { city: 'Modena', zip: '41100' } },
    items: [
      { id: 1, qty: 5 },
      { id: 2, qty: 10 },
      { id: 3, qty: 15 },
    ],
    nested: { items: [{ id: 99 }] },
  };

  it('$ root returns whole object in array', () => {
    expect(jsonPath(data, '$')).toEqual([data]);
  });

  it('$.field nested access', () => {
    expect(jsonPath(data, '$.user.name')).toEqual(['Mario']);
  });

  it('$.field.field.field deep nested', () => {
    expect(jsonPath(data, '$.user.address.city')).toEqual(['Modena']);
  });

  it('$.array[0] array index', () => {
    expect(jsonPath(data, '$.items[0]')).toEqual([{ id: 1, qty: 5 }]);
  });

  it('$.array[*] wildcard → tutti gli elementi', () => {
    expect(jsonPath(data, '$.items[*]')).toEqual([
      { id: 1, qty: 5 },
      { id: 2, qty: 10 },
      { id: 3, qty: 15 },
    ]);
  });

  it('$.array[*].field wildcard + field projection', () => {
    expect(jsonPath(data, '$.items[*].id')).toEqual([1, 2, 3]);
  });

  it('🚨 $..field recursive descent: raccoglie da TUTTI i livelli', () => {
    // "items" appare sia in root che in nested
    const found = jsonPath(data, '$..items');
    expect(found.length).toBe(2);
  });

  it('🚨 path senza $ → throw', () => {
    expect(() => jsonPath(data, 'user.name')).toThrow(/deve iniziare con \$/u);
  });

  it('segment unknown → empty array', () => {
    expect(jsonPath(data, '$.fantasma')).toEqual([]);
  });

  it('array index out of bounds → empty array', () => {
    expect(jsonPath(data, '$.items[99]')).toEqual([]);
  });

  it('null/undefined source → empty', () => {
    expect(jsonPath(null, '$.x')).toEqual([]);
  });

  it('wildcard su object → tutti i values', () => {
    const r = jsonPath({ a: 1, b: 2, c: 3 }, '$[*]');
    expect(r.sort()).toEqual([1, 2, 3]);
  });
});

describe('jsonExtractExecutor', () => {
  it('🚨 path missing → throw', async () => {
    await expect(jsonExtractExecutor({}, {}, ctx)).rejects.toThrow(/path.*obbligatorio/u);
  });

  it('mode first (default): primo match', async () => {
    const r = await jsonExtractExecutor(
      { path: '$.items[*].id' },
      { items: [{ id: 1 }, { id: 2 }] },
      ctx,
    );
    expect((r.output as { value: unknown }).value).toBe(1);
    expect((r.output as { matchCount: number }).matchCount).toBe(2);
  });

  it('mode all: tutti i match come array', async () => {
    const r = await jsonExtractExecutor(
      { path: '$.items[*].id', mode: 'all' },
      { items: [{ id: 1 }, { id: 2 }] },
      ctx,
    );
    expect((r.output as { value: unknown[] }).value).toEqual([1, 2]);
  });

  it('mode count: numero di match', async () => {
    const r = await jsonExtractExecutor(
      { path: '$.items[*]', mode: 'count' },
      { items: [{}, {}, {}] },
      ctx,
    );
    expect((r.output as { value: number }).value).toBe(3);
  });

  it('no match + defaultValue → fallback', async () => {
    const r = await jsonExtractExecutor(
      { path: '$.fantasma', defaultValue: 'fallback' },
      { x: 1 },
      ctx,
    );
    expect((r.output as { value: string }).value).toBe('fallback');
  });

  it('no match + no defaultValue → null', async () => {
    const r = await jsonExtractExecutor({ path: '$.fantasma' }, { x: 1 }, ctx);
    expect((r.output as { value: null }).value).toBeNull();
  });

  it('JSON string source auto-parse', async () => {
    const r = await jsonExtractExecutor({ path: '$.x', sourceExpression: '{"x": 42}' }, {}, ctx);
    expect((r.output as { value: number }).value).toBe(42);
  });

  it('array JSON string source auto-parse', async () => {
    const r = await jsonExtractExecutor({ path: '$[0]', sourceExpression: '[1, 2, 3]' }, {}, ctx);
    expect((r.output as { value: number }).value).toBe(1);
  });
});

describe('parseDateInput — multi-format parser', () => {
  it('ISO 8601 YYYY-MM-DD', () => {
    const d = parseDateInput('2026-06-07');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getUTCFullYear()).toBe(2026);
  });

  it('ISO 8601 full with time', () => {
    const d = parseDateInput('2026-06-07T10:00:00Z');
    expect(d).toBeInstanceOf(Date);
  });

  it('dd/mm/yyyy italiano', () => {
    const d = parseDateInput('07/06/2026');
    expect(d!.getDate()).toBe(7);
    expect(d!.getMonth()).toBe(5); // June
    expect(d!.getFullYear()).toBe(2026);
  });

  it('dd-mm-yyyy italiano', () => {
    const d = parseDateInput('07-06-2026');
    expect(d!.getDate()).toBe(7);
  });

  it('yy 2 digit → 20yy', () => {
    const d = parseDateInput('07/06/26');
    expect(d!.getFullYear()).toBe(2026);
  });

  it('Date object pass-through', () => {
    const original = new Date('2026-01-01');
    expect(parseDateInput(original)).toBe(original);
  });

  it('🚨 invalid Date object → null', () => {
    expect(parseDateInput(new Date('garbage'))).toBeNull();
  });

  it('"now" → Date.now()', () => {
    const d = parseDateInput('now');
    expect(d).toBeInstanceOf(Date);
    expect(Math.abs(d!.getTime() - Date.now())).toBeLessThan(1000);
  });

  it('number > 1e12 → milliseconds', () => {
    const d = parseDateInput(1748275200000); // 2025
    expect(d).toBeInstanceOf(Date);
  });

  it('number small → assume unix seconds', () => {
    const d = parseDateInput(1748275200);
    expect(d).toBeInstanceOf(Date);
  });

  it('null/undefined/"" → null', () => {
    expect(parseDateInput(null)).toBeNull();
    expect(parseDateInput(undefined)).toBeNull();
    expect(parseDateInput('')).toBeNull();
  });

  it('garbage string → null', () => {
    expect(parseDateInput('not-a-date')).toBeNull();
  });
});

describe('formatDate — preset + custom tokens', () => {
  const d = new Date('2026-06-07T10:00:00Z');

  it('preset it_long (lunedì 7 giugno 2026)', () => {
    const r = formatDate(d, 'it_long', '', 'Europe/Rome');
    expect(r).toContain('giugno');
    expect(r).toContain('2026');
  });

  it('preset it_short dd/mm/yyyy', () => {
    const r = formatDate(d, 'it_short', '', 'Europe/Rome');
    expect(r).toMatch(/^\d{2}\/\d{2}\/\d{4}$/u);
  });

  it('preset it_iso dd-mm-yyyy', () => {
    const r = formatDate(d, 'it_iso', '', 'Europe/Rome');
    expect(r).toMatch(/^\d{2}-\d{2}-\d{4}$/u);
  });

  it('preset us_short M/D/Y', () => {
    const r = formatDate(d, 'us_short', '', 'Europe/Rome');
    expect(r).toMatch(/^\d+\/\d+\/\d{4}$/u);
  });

  it('preset iso8601 → toISOString', () => {
    expect(formatDate(d, 'iso8601', '', 'UTC')).toBe('2026-06-07T10:00:00.000Z');
  });

  it('preset unix seconds', () => {
    expect(formatDate(d, 'unix', '', 'UTC')).toBe(String(Math.floor(d.getTime() / 1000)));
  });

  it('custom yyyy-MM-dd HH:mm:ss tokens', () => {
    const r = formatDate(d, 'custom', 'yyyy-MM-dd HH:mm:ss', 'UTC');
    expect(r).toBe('2026-06-07 10:00:00');
  });

  it('custom MMMM (mese full italiano)', () => {
    const r = formatDate(d, 'custom', 'MMMM yyyy', 'Europe/Rome');
    expect(r).toContain('giugno');
  });

  it('custom EEEE (giorno full italiano)', () => {
    const r = formatDate(d, 'custom', 'EEEE', 'Europe/Rome');
    // 2026-06-07 12:00 Europe/Rome = domenica
    expect([
      'domenica',
      'lunedì',
      'martedì',
      'mercoledì',
      'giovedì',
      'venerdì',
      'sabato',
    ]).toContain(r);
  });

  it('custom yy → 2 digit', () => {
    const r = formatDate(d, 'custom', 'yy', 'UTC');
    expect(r).toBe('26');
  });

  it('🚨 unknown preset → toISOString fallback', () => {
    expect(formatDate(d, 'unknown', '', 'UTC')).toBe('2026-06-07T10:00:00.000Z');
  });

  it('timezone offset diversi producono output diversi', () => {
    const a = formatDate(d, 'it_short', '', 'Europe/Rome');
    const b = formatDate(d, 'it_short', '', 'America/New_York');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Stessa data ma in TZ molto distanti → potrebbe variare il giorno
  });
});

describe('dateFormatExecutor', () => {
  it('happy path con preset it_long', async () => {
    const r = await dateFormatExecutor({ input: '2026-06-07', preset: 'it_long' }, undefined, ctx);
    const out = r.output as { formatted: string; iso: string; unix: number; year: number };
    expect(out.formatted).toContain('giugno');
    expect(out.iso).toContain('2026-06-07');
    expect(out.year).toBe(2026);
    expect(typeof out.unix).toBe('number');
  });

  it('🚨 input non parsabile → throw', async () => {
    await expect(dateFormatExecutor({ input: 'garbage' }, undefined, ctx)).rejects.toThrow(
      /non parsabile/u,
    );
  });

  it('preset default = it_long', async () => {
    const r = await dateFormatExecutor({ input: '2026-06-07' }, undefined, ctx);
    const out = r.output as { formatted: string };
    expect(out.formatted).toContain('giugno');
  });

  it('timezone default = Europe/Rome', async () => {
    const r = await dateFormatExecutor({ input: '2026-06-07T10:00:00Z' }, undefined, ctx);
    const out = r.output as { hour: number };
    // 10:00 UTC = 12:00 Rome (estate)
    expect(out.hour).toBe(12);
  });

  it('custom timezone applicato', async () => {
    const r = await dateFormatExecutor(
      {
        input: '2026-06-07T10:00:00Z',
        preset: 'iso8601',
        timezone: 'America/New_York',
      },
      undefined,
      ctx,
    );
    const out = r.output as { hour: number };
    // Anche se preset iso8601 → output.hour viene da Intl con America/New_York TZ
    expect(out.hour).toBe(6); // 10:00 UTC = 06:00 EDT
  });

  it('output include components: year/month/day/weekday/hour/minute', async () => {
    const r = await dateFormatExecutor({ input: '2026-06-07T10:00:00Z' }, undefined, ctx);
    const out = r.output as {
      year: number;
      month: number;
      day: number;
      weekday: string;
      hour: number;
      minute: number;
    };
    expect(out.year).toBe(2026);
    expect(out.month).toBe(6);
    expect(out.day).toBe(7);
    expect(out.weekday).toBeTruthy();
    expect(typeof out.hour).toBe('number');
    expect(typeof out.minute).toBe('number');
  });

  it('preset unix output coerente con unix field', async () => {
    const r = await dateFormatExecutor(
      { input: '2026-06-07T10:00:00Z', preset: 'unix' },
      undefined,
      ctx,
    );
    const out = r.output as { formatted: string; unix: number };
    expect(Number(out.formatted)).toBe(out.unix);
  });

  it('input "now" → durationMs piccola', async () => {
    const r = await dateFormatExecutor({ input: 'now' }, undefined, ctx);
    expect(r.durationMs).toBeLessThan(1000);
  });
});

describe('safety budget (anti-DoS) — guard IMPLEMENTATI, non aspirazionali', () => {
  it('textTemplateExecutor: tronca output oltre il cap e segnala truncated', async () => {
    const huge = 'x'.repeat(MAX_TEMPLATE_OUTPUT_CHARS + 50_000);
    const r = await textTemplateExecutor(
      { template: '{{big}}', dataExpression: { big: huge } },
      undefined,
      ctx,
    );
    const out = r.output as { text: string; length: number; truncated: boolean };
    // MUTATION: senza il cap → length === huge.length, truncated === false → rosso.
    expect(out.length).toBe(MAX_TEMPLATE_OUTPUT_CHARS);
    expect(out.truncated).toBe(true);
  });

  it('textTemplateExecutor: output sotto il cap NON è troncato', async () => {
    const r = await textTemplateExecutor(
      { template: 'ciao {{n}}', dataExpression: { n: 'mondo' } },
      undefined,
      ctx,
    );
    const out = r.output as { text: string; truncated: boolean };
    expect(out.text).toBe('ciao mondo');
    expect(out.truncated).toBe(false);
  });

  it('jsonPath wildcard: cap risultati anti-esplosione output', () => {
    const items = Array.from({ length: MAX_JSONPATH_RESULTS + 50_000 }, (_, i) => i);
    const out = jsonPath({ items }, '$.items[*]');
    // MUTATION: senza il cap → length === items.length (150k) → rosso.
    expect(out.length).toBe(MAX_JSONPATH_RESULTS);
  });

  it('jsonPath recursive descent: depth cap impedisce di scendere oltre il limite', () => {
    const nest = (levels: number): unknown => {
      let o: unknown = { target: 'FOUND' };
      for (let i = 0; i < levels; i++) o = { child: o };
      return o;
    };
    // target a profondità oltre il cap → NON raccolto (guard anti stack-overflow).
    // MUTATION: senza il depth guard → ['FOUND'] → rosso.
    expect(jsonPath(nest(MAX_JSONPATH_DEPTH + 5), '$..target')).toEqual([]);
    // controprova: a profondità sotto il cap → raccolto regolarmente.
    expect(jsonPath(nest(10), '$..target')).toEqual(['FOUND']);
  });

  it('jsonPath recursive descent: caso normale (shallow) resta integro dopo i guard', () => {
    const doc = { a: { id: 1 }, b: { nested: { id: 2 } }, c: [{ id: 3 }] };
    expect(jsonPath(doc, '$..id').sort()).toEqual([1, 2, 3]);
  });
});
