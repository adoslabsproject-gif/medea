/**
 * condition-rules evaluator — golden coverage of operator + type matrix.
 * Pins the contract that IF v2.0 and Switch v2.0 rely on.
 */

import { describe, it, expect } from 'vitest';
import { parseRuleset, evaluateRule, evaluateRuleset, type EvalContext } from './condition-rules.js';

const baseCtx: EvalContext = {
  input: {
    status: 'active',
    age: 30,
    tags: ['vip', 'gold'],
    email: 'alice@example.com',
    score: 87.5,
    createdAt: '2026-01-15T10:00:00Z',
    flagged: true,
  },
  vars: { region: 'eu-west' },
};

describe('parseRuleset', () => {
  it('parses JSON string', () => {
    const r = parseRuleset('{"combinator":"OR","rules":[{"left":"input.x","op":"equals","right":"y"}]}');
    expect(r?.combinator).toBe('OR');
    expect(r?.rules.length).toBe(1);
  });

  it('parses object directly', () => {
    const r = parseRuleset({ combinator: 'AND', rules: [{ left: 'a', op: 'equals' }] });
    expect(r?.combinator).toBe('AND');
  });

  it('returns null for empty rules', () => {
    expect(parseRuleset({ combinator: 'AND', rules: [] })).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseRuleset('{bad json')).toBeNull();
  });

  it('returns null for empty/undefined', () => {
    expect(parseRuleset('')).toBeNull();
    expect(parseRuleset(undefined)).toBeNull();
    expect(parseRuleset(null)).toBeNull();
  });
});

describe('evaluateRule — string operators', () => {
  const t = (op: string, left = 'input.status', right = 'active', extra: Record<string, unknown> = {}): boolean =>
    evaluateRule({ left, op, right, type: 'string', ...extra }, baseCtx);

  it('equals', () => { expect(t('equals')).toBe(true); expect(t('equals', 'input.status', 'inactive')).toBe(false); });
  it('not-equals', () => { expect(t('not-equals', 'input.status', 'inactive')).toBe(true); });
  it('contains', () => { expect(t('contains', 'input.email', 'example')).toBe(true); });
  it('not-contains', () => { expect(t('not-contains', 'input.email', 'foo')).toBe(true); });
  it('starts-with', () => { expect(t('starts-with', 'input.email', 'alice')).toBe(true); });
  it('ends-with', () => { expect(t('ends-with', 'input.email', '.com')).toBe(true); });
  it('matches-regex', () => { expect(t('matches-regex', 'input.email', '^[a-z]+@')).toBe(true); });
  it('is-empty / is-not-empty', () => {
    expect(evaluateRule({ left: 'input.missing', op: 'is-empty', type: 'string' }, baseCtx)).toBe(true);
    expect(evaluateRule({ left: 'input.status', op: 'is-not-empty', type: 'string' }, baseCtx)).toBe(true);
  });
  it('case-insensitive by default', () => { expect(t('equals', 'input.status', 'ACTIVE')).toBe(true); });
  it('case-sensitive when toggled', () => {
    expect(evaluateRule({ left: 'input.status', op: 'equals', right: 'ACTIVE', type: 'string', caseSensitive: true }, baseCtx)).toBe(false);
  });
});

describe('evaluateRule — number operators', () => {
  const t = (op: string, right: string, left = 'input.age'): boolean =>
    evaluateRule({ left, op, right, type: 'number' }, baseCtx);

  it('gt / gte / lt / lte', () => {
    expect(t('gt', '20')).toBe(true);
    expect(t('gt', '30')).toBe(false);
    expect(t('gte', '30')).toBe(true);
    expect(t('lt', '40')).toBe(true);
    expect(t('lte', '30')).toBe(true);
  });

  it('eq / ne', () => {
    expect(t('eq', '30')).toBe(true);
    expect(t('ne', '40')).toBe(true);
  });

  it('between (uses rightMax)', () => {
    expect(evaluateRule({ left: 'input.age', op: 'between', right: '25', rightMax: '35', type: 'number' }, baseCtx)).toBe(true);
    expect(evaluateRule({ left: 'input.age', op: 'between', right: '40', rightMax: '50', type: 'number' }, baseCtx)).toBe(false);
  });

  it('handles floats', () => {
    expect(evaluateRule({ left: 'input.score', op: 'gte', right: '87.0', type: 'number' }, baseCtx)).toBe(true);
  });
});

describe('evaluateRule — date operators', () => {
  it('before / after', () => {
    expect(evaluateRule({ left: 'input.createdAt', op: 'after', right: '2026-01-01', type: 'date' }, baseCtx)).toBe(true);
    expect(evaluateRule({ left: 'input.createdAt', op: 'before', right: '2025-12-01', type: 'date' }, baseCtx)).toBe(false);
  });

  it('returns false for invalid dates', () => {
    expect(evaluateRule({ left: 'input.status', op: 'before', right: 'invalid', type: 'date' }, baseCtx)).toBe(false);
  });
});

describe('evaluateRule — boolean / existence', () => {
  it('is-true / is-false', () => {
    expect(evaluateRule({ left: 'input.flagged', op: 'is-true', type: 'boolean' }, baseCtx)).toBe(true);
    expect(evaluateRule({ left: 'input.flagged', op: 'is-false', type: 'boolean' }, baseCtx)).toBe(false);
  });

  it('exists / not-exists', () => {
    expect(evaluateRule({ left: 'input.status', op: 'exists', type: 'any' }, baseCtx)).toBe(true);
    expect(evaluateRule({ left: 'input.missing', op: 'exists', type: 'any' }, baseCtx)).toBe(false);
    expect(evaluateRule({ left: 'input.missing', op: 'not-exists', type: 'any' }, baseCtx)).toBe(true);
  });
});

describe('evaluateRuleset — combinators', () => {
  it('AND requires every rule to pass', () => {
    const rs = {
      combinator: 'AND' as const,
      rules: [
        { left: 'input.status', op: 'equals', right: 'active', type: 'string' as const },
        { left: 'input.age', op: 'gte', right: '18', type: 'number' as const },
      ],
    };
    expect(evaluateRuleset(rs, baseCtx)).toBe(true);
  });

  it('AND fails if one rule fails', () => {
    const rs = {
      combinator: 'AND' as const,
      rules: [
        { left: 'input.status', op: 'equals', right: 'inactive', type: 'string' as const },
        { left: 'input.age', op: 'gte', right: '18', type: 'number' as const },
      ],
    };
    expect(evaluateRuleset(rs, baseCtx)).toBe(false);
  });

  it('OR passes if any rule passes', () => {
    const rs = {
      combinator: 'OR' as const,
      rules: [
        { left: 'input.status', op: 'equals', right: 'inactive', type: 'string' as const },
        { left: 'input.age', op: 'gte', right: '18', type: 'number' as const },
      ],
    };
    expect(evaluateRuleset(rs, baseCtx)).toBe(true);
  });
});

describe('evalPath — literals and dotted paths', () => {
  it('resolves vars.region', () => {
    const r = evaluateRule({ left: 'vars.region', op: 'equals', right: 'eu-west', type: 'string' }, baseCtx);
    expect(r).toBe(true);
  });
});

describe('matches-regex — anti-ReDoS (H2)', () => {
  // Il pattern `right` è attacker-controlled (output nodi upstream). Pre-fix usava
  // `new RegExp` di V8 → backtracking catastrofico. Post-fix: safeUserRegex (RE2 lineare).
  it('un pattern evil su input lungo NON blocca (RE2 lineare, < 1s vs >3s con V8)', () => {
    const evil = '(a+)+$'; // classico ReDoS exponential su V8
    const input = 'a'.repeat(60) + '!'; // forza il fallimento → backtracking massimo su V8
    const t0 = performance.now();
    const r = evaluateRule(
      { left: 'input', op: 'matches-regex', right: evil, type: 'string' },
      { input },
    );
    const elapsed = performance.now() - t0;
    expect(r).toBe(false); // '!' finale → no match
    expect(elapsed).toBeLessThan(1000); // RE2 ~ms; col vecchio new RegExp sarebbe >3000ms
  });

  it('anti-regressione: un pattern valido continua a matchare correttamente', () => {
    expect(
      evaluateRule({ left: 'input', op: 'matches-regex', right: '^ab+c$', type: 'string' }, { input: 'abbbc' }),
    ).toBe(true);
    expect(
      evaluateRule({ left: 'input', op: 'matches-regex', right: '^ab+c$', type: 'string' }, { input: 'axc' }),
    ).toBe(false);
  });

  it('un pattern non-RE2 (backreference) → false, mai crash (UnsafeRegexError gestita)', () => {
    // RE2 rifiuta le backreference → safeUserRegex lancia → catch ritorna false.
    expect(
      evaluateRule({ left: 'input', op: 'matches-regex', right: '(\\w)\\1', type: 'string' }, { input: 'aa' }),
    ).toBe(false);
  });
});
