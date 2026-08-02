/**
 * Test 2026-grade — engine/strategies/logic-switch.strategy.ts.
 *
 * 🚨 ROUTING: subject expression → matched case → chosenBranch.
 *    Bug = flusso routato a branch sbagliato = workflow corrotto downstream.
 *
 * 🚨 PARSER cases: array OR JSON string OR malformed → fallback [].
 *    Bug = JSON malformato crash workflow.
 *
 * 🚨 FALLBACK BRANCH: nessun match → "default" OR custom fallbackBranch.
 *
 * 🚨 CASE SENSITIVITY: caseSensitive=true (default) vs false (lowercase compare).
 *
 * 🚨 NORMALIZE: null/undefined → "", object → JSON.stringify (deep compare).
 */
import { describe, it, expect, vi } from 'vitest';

const evalMock = vi.hoisted(() => vi.fn());
vi.mock('@/engine/interpreter.js', () => ({
  evaluateExpression: evalMock,
}));

const { LogicSwitchStrategy } = await import('./logic-switch.strategy.js');

function mkCtx(
  over: {
    expression?: string;
    cases?: unknown;
    caseSensitive?: unknown;
    fallbackBranch?: unknown;
  } = {},
) {
  return {
    module: { def: { id: 'logic_switch' } },
    interpolatedConfig: {
      expression: over.expression ?? '$node.x.json.value',
      ...(over.cases !== undefined ? { cases: over.cases } : {}),
      ...(over.caseSensitive !== undefined ? { caseSensitive: over.caseSensitive } : {}),
      ...(over.fallbackBranch !== undefined ? { fallbackBranch: over.fallbackBranch } : {}),
    },
    scope: { vars: {}, secrets: {} },
    node: { id: 'n1', defId: 'logic_switch', config: {} },
  } as never;
}

const strat = new LogicSwitchStrategy();

describe('🚨 match — strategy selector', () => {
  it('🚨 defId="logic_switch" → match true', () => {
    expect(strat.match(mkCtx())).toBe(true);
  });

  it('🚨 defId diverso → match false', () => {
    const c = mkCtx();
    (c as { module: { def: { id: string } } }).module.def.id = 'other';
    expect(strat.match(c)).toBe(false);
  });

  it('🚨 strategy name = "logic-switch"', () => {
    expect(strat.name).toBe('logic-switch');
  });
});

describe('🚨 routing — match diretto', () => {
  it('🚨 string match → chosenBranch corretto + matched=true', async () => {
    evalMock.mockReturnValueOnce('approved');
    const r = await strat.execute(
      mkCtx({
        cases: [
          { match: 'pending', branch: 'wait' },
          { match: 'approved', branch: 'process' },
          { match: 'rejected', branch: 'notify' },
        ],
      }),
    );
    expect(r.chosenBranch).toBe('process');
    expect(r.output).toMatchObject({
      subject: 'approved',
      chosenBranch: 'process',
      matched: true,
      matchedCase: 'approved',
    });
  });

  it('🚨 number match (JSON.stringify equal)', async () => {
    evalMock.mockReturnValueOnce(42);
    const r = await strat.execute(
      mkCtx({
        cases: [
          { match: 42, branch: 'forty-two' },
          { match: 0, branch: 'zero' },
        ],
      }),
    );
    expect(r.chosenBranch).toBe('forty-two');
  });

  it('🚨 boolean match', async () => {
    evalMock.mockReturnValueOnce(true);
    const r = await strat.execute(
      mkCtx({
        cases: [
          { match: true, branch: 'yes' },
          { match: false, branch: 'no' },
        ],
      }),
    );
    expect(r.chosenBranch).toBe('yes');
  });

  it('🚨 primo match vince (no fall-through)', async () => {
    evalMock.mockReturnValueOnce('x');
    const r = await strat.execute(
      mkCtx({
        cases: [
          { match: 'x', branch: 'first' },
          { match: 'x', branch: 'duplicate' }, // mai raggiunto
        ],
      }),
    );
    expect(r.chosenBranch).toBe('first');
  });
});

describe('🚨 fallback branch', () => {
  it('🚨 nessun match + no fallbackBranch → "default"', async () => {
    evalMock.mockReturnValueOnce('unknown');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'a', branch: 'alpha' }],
      }),
    );
    expect(r.chosenBranch).toBe('default');
    expect(r.output).toMatchObject({ matched: false });
    expect((r.output as { matchedCase?: unknown }).matchedCase).toBeUndefined();
  });

  it('🚨 fallbackBranch custom', async () => {
    evalMock.mockReturnValueOnce('unknown');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'a', branch: 'alpha' }],
        fallbackBranch: 'no-match-path',
      }),
    );
    expect(r.chosenBranch).toBe('no-match-path');
  });

  it('🚨 fallbackBranch empty string → fallback "default"', async () => {
    evalMock.mockReturnValueOnce('unknown');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'a', branch: 'alpha' }],
        fallbackBranch: '   ',
      }),
    );
    expect(r.chosenBranch).toBe('default');
  });

  it('🚨 fallbackBranch non-string → fallback "default"', async () => {
    evalMock.mockReturnValueOnce('unknown');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'a', branch: 'alpha' }],
        fallbackBranch: 42 as never,
      }),
    );
    expect(r.chosenBranch).toBe('default');
  });

  it('🚨 zero cases → fallback "default"', async () => {
    evalMock.mockReturnValueOnce('anything');
    const r = await strat.execute(mkCtx({ cases: [] }));
    expect(r.chosenBranch).toBe('default');
  });
});

describe('🚨 parseCases — input formats', () => {
  it('🚨 array nativo accettato', async () => {
    evalMock.mockReturnValueOnce('a');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'a', branch: 'A' }],
      }),
    );
    expect(r.chosenBranch).toBe('A');
  });

  it('🚨 JSON string parsed', async () => {
    evalMock.mockReturnValueOnce('b');
    const r = await strat.execute(
      mkCtx({
        cases: '[{"match":"b","branch":"B"}]',
      }),
    );
    expect(r.chosenBranch).toBe('B');
  });

  it('🚨 JSON string malformato → fallback [] (default branch)', async () => {
    evalMock.mockReturnValueOnce('x');
    const r = await strat.execute(
      mkCtx({
        cases: 'NOT-JSON{',
      }),
    );
    expect(r.chosenBranch).toBe('default');
  });

  it('🚨 JSON valido ma NOT array → fallback []', async () => {
    evalMock.mockReturnValueOnce('x');
    const r = await strat.execute(
      mkCtx({
        cases: '{"match":"x","branch":"X"}', // object, not array
      }),
    );
    expect(r.chosenBranch).toBe('default');
  });

  it('🚨 SECURITY: case missing branch field → filtered out', async () => {
    evalMock.mockReturnValueOnce('a');
    const r = await strat.execute(
      mkCtx({
        cases: [
          { match: 'a' }, // no branch — INVALID
          { match: 'a', branch: 'B' },
        ],
      }),
    );
    expect(r.chosenBranch).toBe('B'); // primo invalid skip, secondo match
  });

  it('🚨 string vuota → cases []', async () => {
    evalMock.mockReturnValueOnce('x');
    const r = await strat.execute(mkCtx({ cases: '   ' }));
    expect(r.chosenBranch).toBe('default');
  });
});

describe('🚨 caseSensitive', () => {
  it('🚨 default true → "Hello" != "hello"', async () => {
    evalMock.mockReturnValueOnce('HELLO');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'hello', branch: 'lower' }],
      }),
    );
    expect(r.chosenBranch).toBe('default');
  });

  it('🚨 caseSensitive=false → "HELLO" === "hello" (lowercase compare)', async () => {
    evalMock.mockReturnValueOnce('HELLO');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'hello', branch: 'lower' }],
        caseSensitive: false,
      }),
    );
    expect(r.chosenBranch).toBe('lower');
  });

  it('🚨 caseSensitive="false" string → false (asBool)', async () => {
    evalMock.mockReturnValueOnce('ABC');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'abc', branch: 'X' }],
        caseSensitive: 'false',
      }),
    );
    expect(r.chosenBranch).toBe('X');
  });

  it('🚨 caseSensitive=undefined → default true', async () => {
    evalMock.mockReturnValueOnce('ABC');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'abc', branch: 'X' }],
        // caseSensitive omitted
      }),
    );
    expect(r.chosenBranch).toBe('default'); // strict matching default
  });
});

describe('🚨 normalize edge cases', () => {
  it('🚨 subject null → "" comparison', async () => {
    evalMock.mockReturnValueOnce(null);
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: '', branch: 'empty' }],
      }),
    );
    expect(r.chosenBranch).toBe('empty');
  });

  it('🚨 subject undefined (no expression) → "" comparison', async () => {
    const r = await strat.execute(
      mkCtx({
        expression: '',
        cases: [{ match: '', branch: 'empty' }],
      }),
    );
    expect(r.chosenBranch).toBe('empty');
  });

  it('🚨 subject object → JSON.stringify normalized', async () => {
    evalMock.mockReturnValueOnce({ a: 1 });
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: '{"a":1}' as never, branch: 'obj-match' }],
      }),
    );
    // match field type string → JSON.stringify del subject combina
    expect(r.chosenBranch).toBe('obj-match');
  });

  it('🚨 output.subject = subject originale (no normalize)', async () => {
    evalMock.mockReturnValueOnce({ x: 'value' });
    const r = await strat.execute(
      mkCtx({
        cases: [],
      }),
    );
    expect(r.output).toMatchObject({ subject: { x: 'value' } });
  });

  it('🚨 output.subject null (fallback) se subject undefined', async () => {
    const r = await strat.execute(mkCtx({ expression: '', cases: [] }));
    expect((r.output as { subject: unknown }).subject).toBeNull();
  });
});

describe('🚨 retries field', () => {
  it('🚨 retries=0 fisso (no retry per logic node)', async () => {
    evalMock.mockReturnValueOnce('a');
    const r = await strat.execute(
      mkCtx({
        cases: [{ match: 'a', branch: 'A' }],
      }),
    );
    expect(r.retries).toBe(0);
  });
});

describe('🔬 strictMode (ondata 8d)', () => {
  it('🚨 nessun match + strictMode → THROW (no fallthrough silenzioso)', async () => {
    evalMock.mockReturnValueOnce('sconosciuto');
    const c = mkCtx({ cases: [{ match: 'a', branch: 'alpha' }] });
    (c as { interpolatedConfig: Record<string, unknown> }).interpolatedConfig.strictMode = true;
    await expect(strat.execute(c)).rejects.toThrow(/strictMode/);
  });

  it('match presente + strictMode → nessun errore', async () => {
    evalMock.mockReturnValueOnce('a');
    const c = mkCtx({ cases: [{ match: 'a', branch: 'alpha' }] });
    (c as { interpolatedConfig: Record<string, unknown> }).interpolatedConfig.strictMode = true;
    const r = await strat.execute(c);
    expect(r.chosenBranch).toBe('alpha');
  });
});

describe('🔬 condition-rules per-case (ondata 8d)', () => {
  it('🚨 ruleset true → match (OVERRIDE del literal match)', async () => {
    evalMock.mockReturnValueOnce('irrilevante-per-il-case-con-rules');
    const c = mkCtx({
      cases: [
        {
          match: 'mai',
          branch: 'big-order',
          rules: {
            combinator: 'AND',
            rules: [{ left: 'input.amount', op: 'gt', right: '1000', type: 'number' }],
          },
        },
      ],
    });
    (c as { scope: Record<string, unknown> }).scope.input = { amount: 5000 };
    const r = await strat.execute(c);
    expect(r.chosenBranch).toBe('big-order');
  });

  it('ruleset false → no match → fallback default', async () => {
    evalMock.mockReturnValueOnce('x');
    const c = mkCtx({
      cases: [
        {
          match: 'mai',
          branch: 'big-order',
          rules: {
            combinator: 'AND',
            rules: [{ left: 'input.amount', op: 'gt', right: '1000', type: 'number' }],
          },
        },
      ],
    });
    (c as { scope: Record<string, unknown> }).scope.input = { amount: 10 };
    const r = await strat.execute(c);
    expect(r.chosenBranch).toBe('default');
  });
});
