/**
 * Test bug-bounty — action_diff. Era SENZA test (gap gate). Copre deep-diff oggetti
 * (added/removed/changed con dot-path), branch equal/different, diff testo, input JSON
 * string, e l'array trattato come valore atomico (limite documentato).
 */
import { describe, it, expect } from 'vitest';
import { diffNode } from './compare.js';

const diff = diffNode.executor!;
const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const run = async (cfg: Record<string, unknown>, input?: unknown) => {
  const r = await diff(cfg, input, ctx);
  return { out: r.output as Record<string, unknown>, branch: r.branch };
};

describe('action_diff — object mode', () => {
  it('🚨 added/removed/changed con dot-path annidato', async () => {
    const a = { nome: 'X', addr: { city: 'Roma' }, tmp: 1 };
    const b = { nome: 'Y', addr: { city: 'Roma', cap: '00184' } };
    const { out, branch } = await run({ mode: 'object', a, b });
    expect(out.changed).toMatchObject({ nome: { from: 'X', to: 'Y' } });
    expect(out.added).toMatchObject({ 'addr.cap': '00184' });
    expect(out.removed).toMatchObject({ tmp: 1 });
    expect(out.equal).toBe(false);
    expect(branch).toBe('different');
  });

  it('🚨 oggetti identici → equal + branch equal + changeCount 0', async () => {
    const { out, branch } = await run({ mode: 'object', a: { x: 1 }, b: { x: 1 } });
    expect(out.equal).toBe(true);
    expect(out.changeCount).toBe(0);
    expect(branch).toBe('equal');
  });

  it('accetta stringhe JSON come input', async () => {
    const { out } = await run({ mode: 'object', a: '{"x":1}', b: '{"x":2}' });
    expect(out.changed).toMatchObject({ x: { from: 1, to: 2 } });
  });

  it('array trattato come valore atomico (limite documentato)', async () => {
    const { out } = await run({ mode: 'object', a: { tags: [1, 2] }, b: { tags: [1, 3] } });
    expect(out.changed).toHaveProperty('tags');
  });

  it('usa input come A quando a vuoto', async () => {
    const { out } = await run({ mode: 'object', b: { x: 2 } }, { x: 1 });
    expect(out.changed).toMatchObject({ x: { from: 1, to: 2 } });
  });
});

describe('action_diff — text mode', () => {
  it('marca add/remove/equal per riga', async () => {
    const { out } = await run({ mode: 'text', a: 'riga1\nriga2', b: 'riga1\nriga3' });
    const changes = out.changes as { type: string; line: string }[];
    expect(changes).toContainEqual({ type: 'remove', line: 'riga2' });
    expect(changes).toContainEqual({ type: 'equal', line: 'riga1' });
    expect(changes).toContainEqual({ type: 'add', line: 'riga3' });
    expect(out.added).toBe(1);
    expect(out.removed).toBe(1);
  });

  it('testi identici → equal true', async () => {
    const { out } = await run({ mode: 'text', a: 'uguale', b: 'uguale' });
    expect(out.equal).toBe(true);
  });
});

describe('action_diff — 🛡️ DoS: cap di profondità della ricorsione (anti stack-overflow)', () => {
  // Costruisce due oggetti identici per i primi 64 livelli, divergenti oltre il cap.
  const deep = (depth: number, leaf: unknown): unknown => {
    let o: unknown = leaf;
    for (let i = 0; i < depth; i += 1) o = { n: o };
    return o;
  };

  it('🚨 MUTATION: oltre MAX_DIFF_DEPTH il diff confronta per valore (path troncato, non profondo 70)', async () => {
    const { out } = await run({ mode: 'object', a: deep(70, 'X'), b: deep(70, 'Y') });
    expect(out.equal).toBe(false);
    const changedPaths = Object.keys(out.changed as Record<string, unknown>);
    expect(changedPaths).toHaveLength(1);
    // Col cap (64) il path ha ESATTAMENTE 64 segmenti "n"; senza cap ne avrebbe 70.
    const segments = (changedPaths[0]!.match(/n/gu) ?? []).length;
    expect(segments).toBe(64);
  });

  it('oggetti annidati identici e profondi → equal true (no falso positivo dal cap)', async () => {
    const { out } = await run({ mode: 'object', a: deep(70, 'same'), b: deep(70, 'same') });
    expect(out.equal).toBe(true);
  });
});
