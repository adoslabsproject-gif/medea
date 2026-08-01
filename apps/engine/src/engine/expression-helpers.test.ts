import { describe, it, expect } from 'vitest';
import { buildExpressionHelpers } from './expression-helpers.js';
import { evaluateExpression, type InterpreterScope, InterpreterError } from './interpreter.js';

const H = () => buildExpressionHelpers({});

describe('buildExpressionHelpers — accessor (parità n8n)', () => {
  it('$json = input; $items derivato da input (array passa, scalare wrappato, null→[])', () => {
    expect(buildExpressionHelpers({ input: { a: 1 } }).$json).toEqual({ a: 1 });
    expect(buildExpressionHelpers({ input: [1, 2, 3] }).$items).toEqual([1, 2, 3]);
    expect(buildExpressionHelpers({ input: { a: 1 } }).$items).toEqual([{ a: 1 }]);
    expect(buildExpressionHelpers({ input: null }).$items).toEqual([]);
  });

  it('$itemIndex/$runIndex/$first/$last/$itemCount dal loop; default fuori dal loop', () => {
    const noLoop = buildExpressionHelpers({ input: [1, 2] });
    expect(noLoop.$itemIndex).toBe(0);
    expect(noLoop.$first).toBe(true);
    expect(noLoop.$last).toBe(true);
    expect(noLoop.$itemCount).toBe(2);

    const inLoop = buildExpressionHelpers({
      loop: { item: 'x', index: 2, total: 5, first: false, last: false, loopId: 'l1', strategy: 'naive' },
    });
    expect(inLoop.$itemIndex).toBe(2);
    expect(inLoop.$runIndex).toBe(2);
    expect(inLoop.$first).toBe(false);
    expect(inLoop.$last).toBe(false);
    expect(inLoop.$itemCount).toBe(5);
  });

  it('$workflow/$execution: id presenti, default safe sui mancanti', () => {
    const h = buildExpressionHelpers({ workflow: { id: 'wf1' }, execution: { id: 'run1' } });
    expect(h.$workflow).toEqual({ id: 'wf1', name: '' });
    expect(h.$execution.id).toBe('run1');
    expect(h.$execution.mode).toBe('manual'); // default
    expect(H().$workflow.id).toBe('');         // nessun context → safe
  });
});

describe('buildExpressionHelpers — funzioni (superiorità: robuste su input invalido)', () => {
  const h = H();
  it('$if / $ifEmpty / $isEmpty', () => {
    expect(h.$if(true, 'a', 'b')).toBe('a');
    expect(h.$if(0, 'a', 'b')).toBe('b');
    expect(h.$ifEmpty('', 'fallback')).toBe('fallback');
    expect(h.$ifEmpty('x', 'fallback')).toBe('x');
    expect(h.$ifEmpty([], 'fb')).toBe('fb');
    expect(h.$isEmpty(null)).toBe(true);
    expect(h.$isEmpty('  ')).toBe(true);
    expect(h.$isEmpty({})).toBe(true);
    expect(h.$isEmpty(0)).toBe(false); // 0 NON è vuoto
  });

  it('$get — deep path safe con array index + fallback (mai throwa)', () => {
    const obj = { a: { b: [{ c: 42 }] } };
    expect(h.$get(obj, 'a.b[0].c')).toBe(42);
    expect(h.$get(obj, 'a.b.0.c')).toBe(42);
    expect(h.$get(obj, 'a.x.y', 'def')).toBe('def');
    expect(h.$get(null, 'a.b', 'def')).toBe('def');
    expect(h.$get(obj, '', 'def')).toBe('def');
  });

  it('$sum/$avg/$min/$max — NON crashano su non-array o vuoto (n8n throwa)', () => {
    expect(h.$sum([1, 2, '3', true])).toBe(7); // coercizione: '3'→3, true→1
    expect(h.$sum('not-array')).toBe(0);
    expect(h.$avg([2, 4])).toBe(3);
    expect(h.$avg([])).toBe(0);
    expect(h.$min([5, 2, 9])).toBe(2);
    expect(h.$max([5, 2, 9])).toBe(9);
    expect(h.$min([])).toBe(0);
  });

  it('$unique/$flatten/$keys/$values/$number/$string', () => {
    expect(h.$unique([1, 1, 2, 3, 3])).toEqual([1, 2, 3]);
    expect(h.$flatten([1, [2, [3, 4]]])).toEqual([1, 2, 3, 4]);
    expect(h.$keys({ a: 1, b: 2 })).toEqual(['a', 'b']);
    expect(h.$values({ a: 1, b: 2 })).toEqual([1, 2]);
    expect(h.$keys('not-obj')).toEqual([]);
    expect(h.$number('42')).toBe(42);
    expect(h.$number('abc')).toBe(0);
    expect(h.$string({ a: 1 })).toBe('{"a":1}');
    expect(h.$string(null)).toBe('');
  });
});

describe('$date — date math pura (no luxon dep)', () => {
  const h = H();
  it('plus/minus giorni e ore (UTC, deterministico)', () => {
    expect(h.$date.plus('2026-01-01T00:00:00.000Z', { days: 7 })).toBe('2026-01-08T00:00:00.000Z');
    expect(h.$date.minus('2026-01-08T00:00:00.000Z', { days: 7 })).toBe('2026-01-01T00:00:00.000Z');
    expect(h.$date.plus('2026-01-01T00:00:00.000Z', { hours: 25 })).toBe('2026-01-02T01:00:00.000Z');
  });
  it('diff in unità', () => {
    expect(h.$date.diff('2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z', 'days')).toBe(7);
    expect(h.$date.diff('2026-01-01T02:00:00Z', '2026-01-01T00:00:00Z', 'hours')).toBe(2);
  });
  it('format con token', () => {
    expect(h.$date.format('2026-03-09T14:05:09Z', 'DD/MM/YYYY HH:mm:ss')).toBe('09/03/2026 14:05:09');
  });
  it('startOf', () => {
    expect(h.$date.startOf('2026-03-09T14:05:09Z', 'month')).toBe('2026-03-01T00:00:00.000Z');
    expect(h.$date.startOf('2026-03-09T14:05:09Z', 'year')).toBe('2026-01-01T00:00:00.000Z');
  });
  it('isWeekend + addBusinessDays (superiore: n8n non li ha out-of-box)', () => {
    expect(h.$date.isWeekend('2026-06-13T00:00:00Z')).toBe(true);  // sabato
    expect(h.$date.isWeekend('2026-06-15T00:00:00Z')).toBe(false); // lunedì
    // venerdì + 1 business day = lunedì (salta il weekend)
    expect(h.$date.addBusinessDays('2026-06-12T00:00:00Z', 1)).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('🔬 integrazione: evaluateExpression esegue gli helper end-to-end (sandbox reale)', () => {
  const evalExpr = (expr: string, scope: InterpreterScope = {}): unknown => evaluateExpression(expr, scope);

  it('$json.<field> e $if con condizione reale', () => {
    expect(evalExpr('$json.name', { input: { name: 'Ada' } })).toBe('Ada');
    expect(evalExpr('$if($json.age >= 18, "adult", "minor")', { input: { age: 20 } })).toBe('adult');
    expect(evalExpr('$if($json.age >= 18, "adult", "minor")', { input: { age: 12 } })).toBe('minor');
  });

  it('$sum/$avg su $items reali', () => {
    expect(evalExpr('$sum($items)', { input: [10, 20, 30] })).toBe(60);
    expect(evalExpr('$avg([1,2,3,4])')).toBe(2.5);
  });

  it('$get deep + $ifEmpty fallback in una sola espressione', () => {
    expect(evalExpr('$ifEmpty($get($json, "a.b.c"), "n/a")', { input: { a: {} } })).toBe('n/a');
    expect(evalExpr('$get($json, "items[1].sku")', { input: { items: [{ sku: 'A' }, { sku: 'B' }] } })).toBe('B');
  });

  it('$date math dentro espressione', () => {
    expect(evalExpr('$date.plus("2026-01-01T00:00:00Z", {days: 30})')).toBe('2026-01-31T00:00:00.000Z');
  });

  it('$workflow/$execution accessibili', () => {
    expect(evalExpr('$workflow.id', { workflow: { id: 'wf-9' } })).toBe('wf-9');
    expect(evalExpr('$execution.mode', { execution: { id: 'r', mode: 'webhook' } })).toBe('webhook');
  });

  it('$itemIndex riflette il loop', () => {
    const scope: InterpreterScope = { loop: { item: 'x', index: 3, total: 10, first: false, last: false, loopId: 'l', strategy: 'naive' } };
    expect(evalExpr('$itemIndex', scope)).toBe(3);
  });

  it('🔒 SICUREZZA: gli helper NON aprono buchi nella sandbox', () => {
    // constructor/Function restano vietati anche partendo da un helper → niente
    // escape al Function ctor / prototype pollution via $date o $json.
    expect(() => evalExpr('$date.constructor')).toThrow(InterpreterError);
    expect(() => evalExpr('$json.constructor', { input: {} })).toThrow(InterpreterError);
    expect(() => evalExpr('$date["constructor"]')).toThrow(InterpreterError);
    expect(() => evalExpr('$json.__proto__', { input: {} })).toThrow(InterpreterError);
    // `this` in strict-mode Function è undefined (no escape): l'espressione è
    // lecita e ritorna undefined, NON deve crashare il run.
    expect(evalExpr('$if(true, this, "x")')).toBeUndefined();
  });

  it('retro-compat: lo scope esistente (vars/secrets/input) continua a funzionare', () => {
    expect(evalExpr('vars["x"] + secrets["k"]', { vars: { x: 'a' }, secrets: { k: 'b' } })).toBe('ab');
    expect(evalExpr('input.v * 2', { input: { v: 21 } })).toBe(42);
  });
});

describe('🚨 FASE-2 — $jmespath (lib VERA, parità n8n)', () => {
  const evalExpr = (expr: string, scope: InterpreterScope = {}): unknown => evaluateExpression(expr, scope);
  const DATA = { items: [{ name: 'Anna', age: 41 }, { name: 'Bruno', age: 17 }, { name: 'Carla', age: 35 }] };

  it('🚨 query di filtro n8n-style: items[?age > `30`].name', () => {
    expect(evalExpr('$jmespath($json, "items[?age > `30`].name")', { input: DATA })).toEqual(['Anna', 'Carla']);
  });

  it('🚨 proiezioni + funzioni native jmespath (length, sort_by, max_by)', () => {
    expect(evalExpr('$jmespath($json, "length(items)")', { input: DATA })).toBe(3);
    expect(evalExpr('$jmespath($json, "max_by(items, &age).name")', { input: DATA })).toBe('Anna');
    expect(evalExpr('$jmespath($json, "sort_by(items, &age)[0].name")', { input: DATA })).toBe('Bruno');
  });

  it('🚨 FAIL-SOFT: query sintatticamente rotta → null, MAI crash del run', () => {
    expect(evalExpr('$jmespath($json, "items[?age >")', { input: DATA })).toBeNull();
    expect(evalExpr('$jmespath(null, "a.b")')).toBeNull();
  });
});

describe('🚨 FASE-2 — Luxon DateTime/Duration (parità n8n, timezone VERE)', () => {
  const evalExpr = (expr: string, scope: InterpreterScope = {}): unknown => evaluateExpression(expr, scope);

  it('🚨 l\'espressione n8n canonica gira IDENTICA: DateTime con setZone', () => {
    // 12:00 UTC di un giorno fisso → 14:00 a Roma (CEST, estate)
    const out = evalExpr('DateTime.fromISO("2026-06-12T12:00:00Z").setZone("Europe/Rome").toFormat("HH:mm")');
    expect(out).toBe('14:00');
  });

  it('🚨 Duration: fromObject + as (conversioni unità)', () => {
    expect(evalExpr('Duration.fromObject({days: 3}).as("hours")')).toBe(72);
  });

  it('🚨 DateTime math: plus/diff con oggetti durata (sintassi n8n)', () => {
    const out = evalExpr('DateTime.fromISO("2026-01-31T00:00:00Z", {zone:"utc"}).plus({months: 1}).toISODate()');
    expect(out).toBe('2026-02-28'); // fine-mese gestito da Luxon, non a mano
  });

  it('🚨 locale: formato italiano out-of-the-box', () => {
    const out = evalExpr('DateTime.fromISO("2026-06-12T00:00:00Z", {zone:"utc"}).setLocale("it").toFormat("cccc d LLLL")');
    expect(String(out).toLowerCase()).toContain('giugno');
  });

  it('🔒 SICUREZZA: le superfici Luxon NON aprono la sandbox (constructor bloccato)', () => {
    expect(() => evalExpr('DateTime.constructor')).toThrow(InterpreterError);
    expect(() => evalExpr('DateTime["constructor"]')).toThrow(InterpreterError);
    expect(() => evalExpr('Duration.constructor("return process")()')).toThrow(InterpreterError);
    expect(() => evalExpr('DateTime.now().constructor')).toThrow(InterpreterError);
  });
});
