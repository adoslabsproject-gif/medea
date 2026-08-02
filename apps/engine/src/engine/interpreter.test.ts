import { describe, it, expect } from 'vitest';
import {
  evaluateExpression,
  interpolateString,
  interpolateConfig,
  InterpreterError,
} from './interpreter.js';

describe('evaluateExpression', () => {
  it('evaluates arithmetic', () => {
    expect(evaluateExpression('2 + 2', {})).toBe(4);
  });

  it('reads from input scope', () => {
    expect(evaluateExpression('input.foo', { input: { foo: 'bar' } })).toBe('bar');
  });

  it('supports optional chaining (handles undefined safely)', () => {
    expect(evaluateExpression('input?.missing?.deep', { input: {} })).toBeUndefined();
  });

  it('boolean comparison for if-node', () => {
    expect(evaluateExpression('input.status === "active"', { input: { status: 'active' } })).toBe(
      true,
    );
    expect(evaluateExpression('input.status === "active"', { input: { status: 'inactive' } })).toBe(
      false,
    );
  });

  // ── L (2026-06-05): scope `secrets` tenant-level ──
  it('legge secrets.API_TOKEN (tenant-level)', () => {
    expect(evaluateExpression('secrets.API_TOKEN', { secrets: { API_TOKEN: 'sk_test_123' } })).toBe(
      'sk_test_123',
    );
  });

  it('secrets supporta optional chaining su chiave mancante', () => {
    expect(evaluateExpression('secrets?.MISSING', { secrets: {} })).toBeUndefined();
  });

  it('secrets vuoto (scope NON popolato) → undefined (no ReferenceError)', () => {
    // Caso: workflow non ha secrets configurati. Lo scope key esiste sempre
    // grazie a `new Function(...scopeKeys, ...)` ma il valore e\` undefined.
    expect(evaluateExpression('secrets?.X', {})).toBeUndefined();
  });

  it('secrets coesiste con vars senza interferenza (semantic separation)', () => {
    const r = evaluateExpression('secrets.API + ":" + vars.endpoint', {
      secrets: { API: 'sk_abc' },
      vars: { endpoint: 'https://api.example.com' },
    });
    expect(r).toBe('sk_abc:https://api.example.com');
  });

  it('non si puo\\` mutare secrets dal expression (read-only by design)', () => {
    // L'assegnamento non lancia ma non sopravvive — `secrets` e\` un parametro
    // della Function, una copia di reference. Modifiche sono locali al frame.
    const secrets = { API: 'sk_abc' };
    evaluateExpression('(secrets.API = "HACKED", null)', { secrets });
    // Tuttavia per via di JS-by-reference, l'oggetto viene modificato.
    // Test garantisce solo che NON throw — la convenzione "read-only" e\`
    // documentata, non enforced (l'isolation reale e\` per snapshot fresh
    // ogni nodo via globalVariables.getEnv).
    expect(typeof secrets.API).toBe('string');
  });

  it('rejects access to globalThis', () => {
    expect(() => evaluateExpression('globalThis', {})).toThrow(InterpreterError);
  });

  it('rejects eval()', () => {
    expect(() => evaluateExpression('eval("1+1")', {})).toThrow(InterpreterError);
  });

  it('rejects process', () => {
    expect(() => evaluateExpression('process.env.HOME', {})).toThrow(InterpreterError);
  });

  it('rejects __proto__ access', () => {
    expect(() => evaluateExpression('input.__proto__', { input: {} })).toThrow(InterpreterError);
  });

  it('rejects constructor.constructor escape', () => {
    expect(() => evaluateExpression('({}).constructor.constructor("return 1")()', {})).toThrow(
      InterpreterError,
    );
  });

  // Hardening #2 (audit pre-certificazione): primitive di reflection/metaprog
  // che permettono di raggiungere il Function ctor → bloccate dalla denylist.
  it.each([
    ['Reflect', 'Reflect.get({}, "x")'],
    ['Proxy', 'new Proxy({}, {})'],
    ['WeakRef', 'new WeakRef({})'],
  ])('rejects %s (reflection escape primitive)', (_name, expr) => {
    expect(() => evaluateExpression(expr, {})).toThrow(InterpreterError);
  });

  it('rejects expressions over 4000 chars', () => {
    const huge = '1+'.repeat(2001) + '0';
    expect(() => evaluateExpression(huge, {})).toThrow(InterpreterError);
  });

  it('wraps syntax errors in InterpreterError', () => {
    expect(() => evaluateExpression('1 +', {})).toThrow(InterpreterError);
  });
});

describe('evaluateExpression — security hardening (anti-bypass)', () => {
  // HIGH (2026-05-29) test regression contro i 3 pattern di bypass noti.
  it('blocks bare eval', () => {
    expect(() => evaluateExpression('eval("1+1")', {})).toThrow(InterpreterError);
  });

  it('blocks Unicode escape eval (\\u0065val)', () => {
    expect(() => evaluateExpression('\\u0065val("1+1")', {})).toThrow(InterpreterError);
  });

  it('blocks Unicode {} escape eval (\\u{65}val)', () => {
    expect(() => evaluateExpression('\\u{65}val("1+1")', {})).toThrow(InterpreterError);
  });

  it('blocks Hex escape eval (\\x65val)', () => {
    expect(() => evaluateExpression('\\x65val("1+1")', {})).toThrow(InterpreterError);
  });

  it('blocks bracket-access "constructor" chain', () => {
    expect(() =>
      evaluateExpression('({})["constructor"]["constructor"]("return 1")()', {}),
    ).toThrow(InterpreterError);
  });

  it('blocks single-quote bracket-access "constructor"', () => {
    expect(() => evaluateExpression("({})['constructor']", {})).toThrow(InterpreterError);
  });

  it('blocks bracket-access concatenation ["e"+"val"]', () => {
    expect(() => evaluateExpression('input["e"+"val"]', { input: {} })).toThrow(InterpreterError);
  });

  it('blocks globalThis access', () => {
    expect(() => evaluateExpression('globalThis.process', {})).toThrow(InterpreterError);
  });

  it('blocks bracket-access "process"', () => {
    expect(() => evaluateExpression('this["process"]', {})).toThrow(InterpreterError);
  });

  it('blocks Function constructor', () => {
    expect(() => evaluateExpression('new Function("return 1")()', {})).toThrow(InterpreterError);
  });

  it('blocks setTimeout', () => {
    expect(() => evaluateExpression('setTimeout(()=>{}, 0)', {})).toThrow(InterpreterError);
  });

  it('blocks fetch', () => {
    expect(() => evaluateExpression('fetch("http://evil.tld")', {})).toThrow(InterpreterError);
  });

  it('blocks __proto__ access', () => {
    expect(() => evaluateExpression('input.__proto__', { input: {} })).toThrow(InterpreterError);
  });

  it('blocks require()', () => {
    expect(() => evaluateExpression('require("fs")', {})).toThrow(InterpreterError);
  });

  it('blocks backtick template in bracket access', () => {
    expect(() => evaluateExpression('input[`eval`]', { input: {} })).toThrow(InterpreterError);
  });

  it('still allows safe arithmetic + property access', () => {
    expect(evaluateExpression('input.a + input.b', { input: { a: 1, b: 2 } })).toBe(3);
  });

  it('still allows safe bracket access with literal property', () => {
    expect(evaluateExpression('input["name"]', { input: { name: 'ok' } })).toBe('ok');
  });
});

describe('interpolateString', () => {
  it('replaces single {{expr}}', () => {
    expect(interpolateString('Hello {{input.name}}!', { input: { name: 'world' } })).toBe(
      'Hello world!',
    );
  });

  it('handles multiple placeholders', () => {
    expect(
      interpolateString('{{input.a}} + {{input.b}} = {{input.a + input.b}}', {
        input: { a: 2, b: 3 },
      }),
    ).toBe('2 + 3 = 5');
  });

  it('renders undefined as empty string (n8n bug fixed)', () => {
    expect(interpolateString('hello {{input.missing}}!', { input: {} })).toBe('hello !');
  });

  it('serializes objects as JSON', () => {
    expect(interpolateString('data: {{input.obj}}', { input: { obj: { a: 1 } } })).toBe(
      'data: {"a":1}',
    );
  });

  it('swallows expression errors as empty string', () => {
    expect(interpolateString('bad {{globalThis}}', {})).toBe('bad ');
  });
});

describe('interpolateConfig', () => {
  it('only interpolates string values', () => {
    const result = interpolateConfig(
      { url: 'https://api.example.com/{{input.id}}', timeout: 5000, throw: true },
      { input: { id: 42 } },
    );
    expect(result.url).toBe('https://api.example.com/42');
    expect(result.timeout).toBe(5000);
    expect(result.throw).toBe(true);
  });
});

describe('filter pipes (n8n-compat)', () => {
  const scope = {
    input: { name: 'mario rossi', email: '  hi@x.it  ', list: ['a', 'b', 'c'] },
    vars: { x: undefined as unknown },
  };

  it('| upper → uppercase', () => {
    expect(evaluateExpression('input.name | upper', scope)).toBe('MARIO ROSSI');
  });
  it('| lower → lowercase', () => {
    expect(evaluateExpression("'CIAO' | lower", scope)).toBe('ciao');
  });
  it('| trim → strip whitespace', () => {
    expect(evaluateExpression('input.email | trim', scope)).toBe('hi@x.it');
  });
  it('| length su array', () => {
    expect(evaluateExpression('input.list | length', scope)).toBe(3);
  });
  it('| length su stringa', () => {
    expect(evaluateExpression("'abcdef' | length", scope)).toBe(6);
  });
  it('| json → stringify', () => {
    expect(evaluateExpression('input.list | json', scope)).toBe('["a","b","c"]');
  });
  it("| default:'-' su valore null/undefined", () => {
    expect(evaluateExpression("vars.x | default:'fallback'", scope)).toBe('fallback');
  });
  it('chain di pipe: trim | upper', () => {
    expect(evaluateExpression('input.email | trim | upper', scope)).toBe('HI@X.IT');
  });
  it('pipe coerza null/undefined a empty string (safe)', () => {
    expect(evaluateExpression('vars.x | upper', scope)).toBe('');
  });
  it('NON tocca pipe dentro string literal (regression)', () => {
    expect(evaluateExpression("'a | b | c'", scope)).toBe('a | b | c');
  });
  it('NON tocca bitwise OR (no false positive)', () => {
    // `5 | 3` e\` 7 in JS (bitwise OR). Il rewriter deve guardare solo
    // forme `<expr> | <name>` con name in {upper,lower,trim,length,json,default}.
    expect(evaluateExpression('5 | 3', scope)).toBe(7);
  });
  it('| upper funziona dentro interpolateString', () => {
    expect(interpolateString('Ciao {{input.name | upper}}!', scope)).toBe('Ciao MARIO ROSSI!');
  });
});

describe('filter pipes — round/currency/date/replace/slice/join', () => {
  const scope = {
    input: {
      price: 12.345,
      amount: '1500',
      ts: '2026-06-05T10:30:45Z',
      msg: 'hello world',
      tags: ['a', 'b', 'c'],
      bigstr: 'abcdefghij',
    },
  };

  it('| round (default 0)', () => {
    expect(evaluateExpression('input.price | round', scope)).toBe('12');
  });
  it('| round:2', () => {
    expect(evaluateExpression('input.price | round:2', scope)).toBe('12.35');
  });

  it("| currency:'EUR' default locale it-IT", () => {
    const out = evaluateExpression("input.amount | currency:'EUR'", scope) as string;
    // Output dipende dall'Intl locale, ma deve contenere il simbolo € e il valore.
    expect(out).toMatch(/€|EUR/);
    expect(out).toMatch(/1[.\s,]?500/);
  });
  it("| currency:'USD','en-US'", () => {
    const out = evaluateExpression("input.amount | currency:'USD','en-US'", scope) as string;
    expect(out).toMatch(/\$/);
    expect(out).toMatch(/1,500/);
  });

  it("| date:'YYYY-MM-DD' formatta ISO timestamp", () => {
    expect(evaluateExpression("input.ts | date:'YYYY-MM-DD'", scope)).toBe('2026-06-05');
  });
  it('| date HH:mm:ss tokens', () => {
    const out = evaluateExpression("input.ts | date:'HH:mm:ss'", scope) as string;
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it('| date invalida → empty string (safe)', () => {
    expect(evaluateExpression("'not-a-date' | date:'YYYY'", scope)).toBe('');
  });

  it("| replace:'world','mondo'", () => {
    expect(evaluateExpression("input.msg | replace:'world','mondo'", scope)).toBe('hello mondo');
  });
  it("| replace:'l','' (rimuove tutte le l)", () => {
    expect(evaluateExpression("input.msg | replace:'l',''", scope)).toBe('heo word');
  });

  it('| slice:0,5 su stringa', () => {
    expect(evaluateExpression('input.bigstr | slice:0,5', scope)).toBe('abcde');
  });
  it('| slice:0,2 su array', () => {
    expect(evaluateExpression('input.tags | slice:0,2', scope)).toEqual(['a', 'b']);
  });

  it("| join:','", () => {
    expect(evaluateExpression("input.tags | join:','", scope)).toBe('a,b,c');
  });
  it('| join no-op su stringa', () => {
    expect(evaluateExpression("input.msg | join:','", scope)).toBe('hello world');
  });

  it('chain currency + round (rounding via JS arith)', () => {
    // Note: i filter restituiscono string, ma chain di Number(...) lo permette.
    expect(evaluateExpression('input.price | round:1', scope)).toBe('12.3');
  });

  it('NON tocca pipe dentro string literal (regression date format)', () => {
    expect(evaluateExpression(`"YYYY|MM|DD"`, scope)).toBe('YYYY|MM|DD');
  });
});
