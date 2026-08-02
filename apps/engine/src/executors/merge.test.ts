/**
 * Test 2026-grade — executors/merge.ts (multi-branch convergence).
 *
 * 🚨 4 STRATEGIE: all (default) / concat-arrays / any|first / last.
 *    Bug = merge sbagliato → output errato a tutto il flusso downstream.
 *
 * 🚨 SOURCE DISCOVERY: sourceNodeIds CSV esplicito OR fallback a tutti
 *    nodeOutputs keys (engine passa solo i upstream completed).
 *
 * 🚨 .json UNWRAP: l'engine wrappa output come { json: ... } → unwrap
 *    automatico (compatibility con il pattern n8n).
 *
 * 🚨 concat-arrays: configurabile arrayProperty (default "results"), gestisce
 *    sia { results: [...] } sia branch direttamente array.
 *
 * 🚨 EDGE: branch undefined → filtrato, branchCount aggiornato.
 */
import { describe, it, expect } from 'vitest';
import { logicMergeExecutor } from './merge.js';

const ctx = (nodeOutputs: Record<string, unknown> = {}) =>
  ({
    runId: 'r1',
    workflowId: 'w1',
    nodeId: 'merge-1',
    tenantId: 't1',
    defId: 'logic_merge',
    llmProviders: [],
    secrets: {},
    nodeOutputs,
  }) as never;

describe('🚨 strategy=all (default) — branches map', () => {
  it('🚨 ritorna mappa { branches: { nodeId: output } } + branchCount', async () => {
    const r = await logicMergeExecutor(
      {} as never,
      {} as never,
      ctx({
        node1: { json: { value: 'a' } },
        node2: { json: { value: 'b' } },
      }),
    );
    expect(r.output).toEqual({
      branches: { node1: { value: 'a' }, node2: { value: 'b' } },
      branchCount: 2,
    });
  });

  it('🚨 default strategy se config.strategy missing', async () => {
    const r = await logicMergeExecutor(
      {} as never,
      {} as never,
      ctx({
        n1: { json: 1 },
      }),
    );
    expect(r.output).toMatchObject({ branches: { n1: 1 }, branchCount: 1 });
  });

  it('🚨 case insensitive "ALL"', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'ALL' } as never,
      {} as never,
      ctx({
        n1: { json: 1 },
      }),
    );
    expect(r.output).toMatchObject({ branchCount: 1 });
  });

  it('🚨 zero branches → branches:{}, branchCount:0', async () => {
    const r = await logicMergeExecutor({} as never, {} as never, ctx({}));
    expect(r.output).toEqual({ branches: {}, branchCount: 0 });
  });

  it('🚨🚨 PROTOTYPE-POLLUTION: un nodo `__proto__` NON inquina Object.prototype', async () => {
    // nodeOutputs con own-key reale `__proto__` (il literal `{__proto__:x}` setterebbe il
    // prototype, non una own-key → costruita via defineProperty per essere fedele al rischio).
    const nodeOutputs: Record<string, unknown> = {};
    Object.defineProperty(nodeOutputs, '__proto__', {
      value: { json: { polluted: true } },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    nodeOutputs.normale = { json: { ok: 1 } };
    const r = await logicMergeExecutor(
      { sourceNodeIds: '__proto__,normale' } as never,
      {} as never,
      ctx(nodeOutputs),
    );
    const out = r.output as { branches: Record<string, unknown> };
    // own-property innocua sull'oggetto branches (prototype null), MAI sul prototype globale
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out.branches, '__proto__')).toBe(true);
    expect(out.branches.normale).toEqual({ ok: 1 });
  });
});

describe('🚨 strategy=concat-arrays — array concat', () => {
  it('🚨 3 branch con output.results[] → concatenati', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'concat-arrays' } as never,
      {} as never,
      ctx({
        s1: { json: { results: [1, 2, 3] } },
        s2: { json: { results: [4, 5] } },
        s3: { json: { results: [6] } },
      }),
    );
    expect(r.output).toMatchObject({ results: [1, 2, 3, 4, 5, 6], branchCount: 3, totalItems: 6 });
  });

  it('🚨 arrayProperty custom: "items" invece di "results"', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'concat-arrays', arrayProperty: 'items' } as never,
      {} as never,
      ctx({
        s1: { json: { items: ['a', 'b'] } },
        s2: { json: { items: ['c'] } },
      }),
    );
    expect(r.output).toMatchObject({ items: ['a', 'b', 'c'], totalItems: 3 });
  });

  it('🚨 branch è array DIRETTO (no property wrapping)', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'concat-arrays' } as never,
      {} as never,
      ctx({
        s1: { json: ['x', 'y'] },
        s2: { json: ['z'] },
      }),
    );
    expect(r.output).toMatchObject({ results: ['x', 'y', 'z'], totalItems: 3 });
  });

  it('🚨 branch non-array property → SKIP (no crash)', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'concat-arrays' } as never,
      {} as never,
      ctx({
        s1: { json: { results: [1, 2] } },
        s2: { json: { results: 'not-array' } }, // invalid
        s3: { json: { results: [3] } },
      }),
    );
    expect(r.output).toMatchObject({ results: [1, 2, 3], totalItems: 3 });
  });

  it('🚨 zero array data → output { results: [], totalItems: 0 }', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'concat-arrays' } as never,
      {} as never,
      ctx({
        s1: { json: { other: 'data' } },
        s2: { json: { other: 'data2' } },
      }),
    );
    expect(r.output).toMatchObject({ results: [], totalItems: 0 });
  });

  it('🚨 arrayProperty con whitespace trim → "results" (fallback)', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'concat-arrays', arrayProperty: '   ' } as never,
      {} as never,
      ctx({ s1: { json: { results: [1] } } }),
    );
    expect(r.output).toMatchObject({ results: [1] });
  });
});

describe('🚨 strategy=any|first|last', () => {
  it('🚨 "any" → primo branch', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'any' } as never,
      {} as never,
      ctx({
        a: { json: { v: 'first' } },
        b: { json: { v: 'second' } },
      }),
    );
    expect(r.output).toEqual({ v: 'first' });
  });

  it('🚨 "first" → alias di any', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'first' } as never,
      {} as never,
      ctx({ x: { json: 1 }, y: { json: 2 } }),
    );
    expect(r.output).toBe(1);
  });

  it('🚨 "last" → ultimo branch', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'last' } as never,
      {} as never,
      ctx({ a: { json: 'a' }, b: { json: 'b' }, c: { json: 'c' } }),
    );
    expect(r.output).toBe('c');
  });

  it('🚨 any/first/last + zero branches → null', async () => {
    for (const strat of ['any', 'first', 'last']) {
      const r = await logicMergeExecutor({ strategy: strat } as never, {} as never, ctx({}));
      expect(r.output, `strategy=${strat}`).toBeNull();
    }
  });
});

describe('🚨 sourceNodeIds — explicit selection', () => {
  it('🚨 CSV explicit → solo quei branch', async () => {
    const r = await logicMergeExecutor(
      { sourceNodeIds: 'a,c' } as never,
      {} as never,
      ctx({
        a: { json: 'A' },
        b: { json: 'B' }, // NOT in source list
        c: { json: 'C' },
      }),
    );
    expect(r.output).toEqual({
      branches: { a: 'A', c: 'C' },
      branchCount: 2,
    });
  });

  it('🚨 sourceNodeIds vuoto → fallback a tutti nodeOutputs', async () => {
    const r = await logicMergeExecutor(
      { sourceNodeIds: '' } as never,
      {} as never,
      ctx({ a: { json: 'A' }, b: { json: 'B' } }),
    );
    expect((r.output as { branchCount: number }).branchCount).toBe(2);
  });

  it('🚨 CSV con spazi → trim', async () => {
    const r = await logicMergeExecutor(
      { sourceNodeIds: ' a , b ' } as never,
      {} as never,
      ctx({ a: { json: 1 }, b: { json: 2 } }),
    );
    expect((r.output as { branchCount: number }).branchCount).toBe(2);
  });

  it('🚨 sourceNode ID inesistente → output undefined filtrato (no crash)', async () => {
    const r = await logicMergeExecutor(
      { sourceNodeIds: 'ghost' } as never,
      {} as never,
      ctx({ ghost: undefined }),
    );
    expect((r.output as { branchCount: number }).branchCount).toBe(0);
  });
});

describe('🚨 .json unwrap (n8n pattern)', () => {
  it('🚨 output wrappato { json: ... } → unwrap', async () => {
    const r = await logicMergeExecutor(
      {} as never,
      {} as never,
      ctx({
        n1: { json: { user: 'alice' } },
      }),
    );
    expect((r.output as { branches: { n1: unknown } }).branches.n1).toEqual({ user: 'alice' });
  });

  it('🚨 output PLAIN (no { json: }) → preservato', async () => {
    const r = await logicMergeExecutor(
      {} as never,
      {} as never,
      ctx({
        n1: 42 as unknown, // raw, not wrapped
      }),
    );
    expect((r.output as { branches: { n1: unknown } }).branches.n1).toBe(42);
  });
});

describe('🚨 strategia sconosciuta → default "all"', () => {
  it('🚨 strategy=garbage → fallback all', async () => {
    const r = await logicMergeExecutor(
      { strategy: 'unknown-strategy-xyz' } as never,
      {} as never,
      ctx({ a: { json: 1 } }),
    );
    expect(r.output).toMatchObject({ branches: { a: 1 }, branchCount: 1 });
  });
});

describe('🚨 durationMs reporting', () => {
  it('🚨 ritorna durationMs >= 0', async () => {
    const r = await logicMergeExecutor({} as never, {} as never, ctx({ a: { json: 1 } }));
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.durationMs).toBeLessThan(1000); // merge è sincrono → < 1s
  });
});
