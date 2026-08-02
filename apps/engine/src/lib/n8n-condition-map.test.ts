/**
 * Bug-bounty + CONTRACT test — mapping condizioni IF n8n → FlowForge.
 *
 * Il pezzo forte: il conditionRules generato viene parsato e VALUTATO dal motore
 * REALE di FlowForge (parseRuleset + evaluateRuleset di @medea/engine-nodes-stdlib) su
 * input campione → prova che l'IF importato FUNZIONA, non solo "sembra giusto".
 */
import { describe, it, expect } from 'vitest';
import { mapN8nIfConditions } from './n8n-condition-map.js';
import { parseRuleset, evaluateRuleset } from '@medea/engine-nodes-stdlib';

function rules(config: Record<string, string>): {
  combinator: string;
  rules: { left: string; op: string; right?: string; type: string }[];
} {
  return JSON.parse(config.conditionRules ?? '{}') as never;
}

describe('mapN8nIfConditions — n8n v2 (combinator + conditions[])', () => {
  it('equals stringa + gt numero → conditionRules { combinator, rules }', () => {
    const r = mapN8nIfConditions({
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.status }}',
            rightValue: 'active',
            operator: { type: 'string', operation: 'equals' },
          },
          {
            leftValue: '={{ $json.age }}',
            rightValue: 18,
            operator: { type: 'number', operation: 'gt' },
          },
        ],
      },
    });
    const parsed = rules(r.config);
    expect(parsed.combinator).toBe('AND');
    expect(parsed.rules[0]).toEqual({
      left: 'input.status',
      op: 'equals',
      type: 'string',
      right: 'active',
    });
    expect(parsed.rules[1]).toEqual({ left: 'input.age', op: 'gt', type: 'number', right: '18' });
  });

  it('combinator OR rispettato', () => {
    const r = mapN8nIfConditions({
      conditions: {
        combinator: 'or',
        conditions: [
          { leftValue: '={{ $json.a }}', rightValue: '1', operator: { operation: 'equals' } },
        ],
      },
    });
    expect(rules(r.config).combinator).toBe('OR');
  });

  it('operatore UNARIO (isEmpty) → niente right', () => {
    const r = mapN8nIfConditions({
      conditions: {
        conditions: [
          { leftValue: '={{ $json.note }}', operator: { type: 'string', operation: 'isEmpty' } },
        ],
      },
    });
    expect(rules(r.config).rules[0]).toEqual({
      left: 'input.note',
      op: 'is-empty',
      type: 'string',
    });
  });

  it('operatore SCONOSCIUTO → warning, regola saltata', () => {
    const r = mapN8nIfConditions({
      conditions: {
        conditions: [{ leftValue: '={{ $json.x }}', operator: { operation: 'quantumEntangles' } }],
      },
    });
    expect(r.warnings.some((w) => w.includes('non mappato'))).toBe(true);
  });
});

describe('mapN8nIfConditions — n8n v1 (string/number/boolean[])', () => {
  it('legacy {string:[{value1,operation,value2}]} → rules', () => {
    const r = mapN8nIfConditions({
      conditions: {
        string: [{ value1: '={{ $json.role }}', operation: 'contains', value2: 'admin' }],
      },
    });
    expect(rules(r.config).rules[0]).toEqual({
      left: 'input.role',
      op: 'contains',
      type: 'string',
      right: 'admin',
    });
  });

  it('legacy number "larger"/"smaller" → gt/lt', () => {
    const r = mapN8nIfConditions({
      conditions: { number: [{ value1: '={{ $json.n }}', operation: 'larger', value2: 5 }] },
    });
    expect(rules(r.config).rules[0]!.op).toBe('gt');
  });
});

describe('mapN8nIfConditions — operandi', () => {
  it('$json["key"] → input.key; letterale invariato', () => {
    const r = mapN8nIfConditions({
      conditions: {
        conditions: [
          {
            leftValue: '={{ $json["userId"] }}',
            rightValue: 'abc',
            operator: { operation: 'equals' },
          },
        ],
      },
    });
    expect(rules(r.config).rules[0]!.left).toBe('input.userId');
    expect(rules(r.config).rules[0]!.right).toBe('abc');
  });

  it('riferimento ad altro nodo ($node) → warning', () => {
    const r = mapN8nIfConditions({
      conditions: {
        conditions: [
          {
            leftValue: '={{ $node["Prev"].json.x }}',
            rightValue: '1',
            operator: { operation: 'equals' },
          },
        ],
      },
    });
    expect(r.warnings.some((w) => w.includes('$node'))).toBe(true);
  });

  it('condizioni vuote/non riconosciute → config vuoto + warning', () => {
    expect(mapN8nIfConditions({}).config).toEqual({});
    expect(mapN8nIfConditions({}).warnings).toHaveLength(1);
  });
});

describe("🚨 CONTRATTO: l'IF importato VALUTA col motore REALE di FlowForge", () => {
  it('AND: status==active && age>18 → valutazione corretta su 3 input', () => {
    const { config } = mapN8nIfConditions({
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.status }}',
            rightValue: 'active',
            operator: { type: 'string', operation: 'equals' },
          },
          {
            leftValue: '={{ $json.age }}',
            rightValue: '18',
            operator: { type: 'number', operation: 'gt' },
          },
        ],
      },
    });
    const rs = parseRuleset(config.conditionRules);
    expect(rs).not.toBeNull();
    expect(evaluateRuleset(rs!, { input: { status: 'active', age: 25 } })).toBe(true);
    expect(evaluateRuleset(rs!, { input: { status: 'active', age: 10 } })).toBe(false); // age fallisce
    expect(evaluateRuleset(rs!, { input: { status: 'banned', age: 25 } })).toBe(false); // status fallisce
  });

  it('OR: role contains admin OPPURE level>=5 → valutazione corretta', () => {
    const { config } = mapN8nIfConditions({
      conditions: {
        combinator: 'or',
        conditions: [
          {
            leftValue: '={{ $json.role }}',
            rightValue: 'admin',
            operator: { type: 'string', operation: 'contains' },
          },
          {
            leftValue: '={{ $json.level }}',
            rightValue: '5',
            operator: { type: 'number', operation: 'gte' },
          },
        ],
      },
    });
    const rs = parseRuleset(config.conditionRules)!;
    expect(evaluateRuleset(rs, { input: { role: 'superadmin', level: 1 } })).toBe(true); // role ok
    expect(evaluateRuleset(rs, { input: { role: 'user', level: 9 } })).toBe(true); // level ok
    expect(evaluateRuleset(rs, { input: { role: 'user', level: 1 } })).toBe(false); // nessuno
  });

  it('UNARIO is-empty → valutazione corretta', () => {
    const { config } = mapN8nIfConditions({
      conditions: {
        conditions: [
          { leftValue: '={{ $json.note }}', operator: { type: 'string', operation: 'isEmpty' } },
        ],
      },
    });
    const rs = parseRuleset(config.conditionRules)!;
    expect(evaluateRuleset(rs, { input: { note: '' } })).toBe(true);
    expect(evaluateRuleset(rs, { input: { note: 'qualcosa' } })).toBe(false);
  });
});
