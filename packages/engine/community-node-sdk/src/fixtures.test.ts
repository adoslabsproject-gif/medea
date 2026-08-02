import { describe, it, expect } from 'vitest';
import { deepEqual, runNodeFixture, runNodeFixtures, type NodeFixture } from './fixtures.js';
import type { CommunityNodeDefinition } from './index.js';

function makeNode(): CommunityNodeDefinition {
  return {
    manifest: {
      id: 'demo',
      vendor: 'acme',
      version: '1.0.0',
      displayName: 'Demo',
      description: 'x',
      license: 'MIT',
    },
    def: { type: 'action', icon: 'box', color: '#000' },
    actions: [
      {
        id: 'sum',
        label: 'Sum',
        execute: async (config, input) => {
          const a = Number((input as { a: number }).a);
          const b = Number(config.b);
          if (Number.isNaN(b)) throw new Error('config.b mancante o non numerico');
          return { result: a + b };
        },
      },
      {
        id: 'echo',
        label: 'Echo',
        execute: async (_c, input) => input,
      },
    ],
  };
}

describe('deepEqual', () => {
  it('primitivi, oggetti, array annidati, key order indifferente', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(false); // chiavi diverse
  });
});

describe('runNodeFixture', () => {
  it('output atteso (deep-equal) → pass', async () => {
    const r = await runNodeFixture(makeNode(), {
      name: 'sum 2+3',
      action: 'sum',
      config: { b: '3' },
      input: { a: 2 },
      expect: { output: { result: 5 } },
    });
    expect(r.passed).toBe(true);
  });

  it('output diverso → fail con dettaglio atteso/ricevuto', async () => {
    const r = await runNodeFixture(makeNode(), {
      name: 'sum wrong',
      action: 'sum',
      config: { b: '3' },
      input: { a: 2 },
      expect: { output: { result: 99 } },
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/atteso/u);
    expect(r.detail).toMatch(/ricevuto/u);
  });

  it("errorMatch → pass se l'azione fallisce col messaggio atteso", async () => {
    const r = await runNodeFixture(makeNode(), {
      name: 'sum no config',
      action: 'sum',
      input: { a: 2 },
      expect: { errorMatch: 'config.b mancante' },
    });
    expect(r.passed).toBe(true);
  });

  it("errorMatch atteso ma l'azione riesce → fail", async () => {
    const r = await runNodeFixture(makeNode(), {
      name: 'expects error',
      action: 'echo',
      input: { x: 1 },
      expect: { errorMatch: 'boom' },
    });
    expect(r.passed).toBe(false);
  });

  it('action di default = la prima quando non specificata', async () => {
    const r = await runNodeFixture(makeNode(), {
      name: 'default action',
      config: { b: '1' },
      input: { a: 1 },
      expect: { output: { result: 2 } },
    });
    expect(r.passed).toBe(true);
  });

  it('action inesistente → fail con messaggio chiaro', async () => {
    const r = await runNodeFixture(makeNode(), {
      name: 'bad action',
      action: 'nope',
      input: {},
      expect: { output: {} },
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/non trovata/u);
  });
});

describe('runNodeFixtures (summary)', () => {
  it('aggrega pass/fail su più fixture', async () => {
    const fixtures: NodeFixture[] = [
      {
        name: 'ok1',
        action: 'sum',
        config: { b: '3' },
        input: { a: 2 },
        expect: { output: { result: 5 } },
      },
      {
        name: 'ko1',
        action: 'sum',
        config: { b: '3' },
        input: { a: 2 },
        expect: { output: { result: 6 } },
      },
      { name: 'ok2', action: 'echo', input: { hi: true }, expect: { output: { hi: true } } },
    ];
    const s = await runNodeFixtures(makeNode(), fixtures);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
  });
});
