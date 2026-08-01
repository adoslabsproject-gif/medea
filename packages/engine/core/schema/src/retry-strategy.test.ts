/**
 * Test resolveRetryOwner — UN SOLO owner del retry (mai doppio).
 * Bug-bounty: input garbage (undefined/null/number/maiuscole/spazi/valore ignoto),
 * + INVARIANTE: engineRetriesNode XOR nodeRetriesInternally (mutua esclusione totale).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRetryOwner,
  engineRetriesNode,
  nodeRetriesInternally,
} from './retry-strategy.js';

describe('resolveRetryOwner', () => {
  it('override esplicito vince (case/spazi-insensitive)', () => {
    expect(resolveRetryOwner('workflow', true)).toBe('workflow');
    expect(resolveRetryOwner('node', false)).toBe('node');
    expect(resolveRetryOwner('none', true)).toBe('none');
    expect(resolveRetryOwner('  WORKFLOW ', true)).toBe('workflow');
  });

  it('auto → la capability del nodo decide', () => {
    expect(resolveRetryOwner('auto', true)).toBe('node');   // self-managed → node
    expect(resolveRetryOwner('auto', false)).toBe('workflow');
    expect(resolveRetryOwner(undefined, true)).toBe('node');
    expect(resolveRetryOwner(undefined, false)).toBe('workflow');
  });

  it('🚨 input garbage → trattato come auto (no throw, fallback alla capability)', () => {
    for (const bad of [null, 123, {}, [], 'pippo', '', '  ', true]) {
      expect(resolveRetryOwner(bad, true)).toBe('node');
      expect(resolveRetryOwner(bad, false)).toBe('workflow');
    }
  });

  it('🚨 INVARIANTE mutua esclusione: engine XOR node, mai entrambi, su OGNI combinazione', () => {
    const strategies: unknown[] = ['auto', 'workflow', 'node', 'none', undefined, 'garbage'];
    for (const s of strategies) {
      for (const selfManaged of [true, false]) {
        const engine = engineRetriesNode(s, selfManaged);
        const node = nodeRetriesInternally(s, selfManaged);
        // MAI entrambi true (= doppio retry annidato, il bug che vogliamo impedire)
        expect(engine && node, `doppio retry per strategy=${String(s)} self=${String(selfManaged)}`).toBe(false);
        // coerenza col resolver
        const owner = resolveRetryOwner(s, selfManaged);
        expect(engine).toBe(owner === 'workflow');
        expect(node).toBe(owner === 'node');
      }
    }
  });

  it('🚨 none disabilita entrambi (zero retry ovunque)', () => {
    expect(engineRetriesNode('none', true)).toBe(false);
    expect(nodeRetriesInternally('none', true)).toBe(false);
    expect(engineRetriesNode('none', false)).toBe(false);
    expect(nodeRetriesInternally('none', false)).toBe(false);
  });
});
