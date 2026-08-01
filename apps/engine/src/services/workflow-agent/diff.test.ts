/**
 * Test diff — snapshot before/after → AssistantPatch. Bug-bounty su ogni classe
 * di cambiamento (add/remove/update nodo, defId cambiato, add/remove edge, config
 * riordinata = no-op) + determinismo dell'ordine. Ogni asserzione è scritta per
 * FALLIRE su una mutazione del diff (vedi commenti `mut:`).
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshots, edgeId, deepEqual, patchHasOps, type WorkflowPatch } from './diff.js';
import type { WorkflowSnapshot } from './state.js';

const snap = (
  nodes: { id: string; defId: string; config?: Record<string, unknown> }[],
  edges: { from: string; to: string; fromPort?: string }[] = [],
): WorkflowSnapshot => ({
  nodes: nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config ?? {} })),
  edges: edges.map((e) => ({ from: e.from, to: e.to, ...(e.fromPort ? { fromPort: e.fromPort } : {}) })),
});

describe('diffSnapshots — nodi', () => {
  it('workflow identico → patch vuoto (nessuna op)', () => {
    const s = snap([{ id: 'a', defId: 'trigger_webhook' }], []);
    const p = diffSnapshots(s, s);
    expect(p).toEqual({});
    expect(patchHasOps(p)).toBe(false); // mut: se diff emette op spurie, fallisce
  });

  it('nodo nuovo → addNodes con id/defId/config', () => {
    const before = snap([{ id: 'a', defId: 'trigger_webhook' }]);
    const after = snap([
      { id: 'a', defId: 'trigger_webhook' },
      { id: 'http', defId: 'action_http_request', config: { url: 'https://x' } },
    ]);
    const p = diffSnapshots(before, after);
    expect(p.addNodes).toEqual([{ id: 'http', defId: 'action_http_request', config: { url: 'https://x' } }]);
    expect(p.removeNodeIds).toBeUndefined(); // mut: nessun remove
    expect(p.updateNodes).toBeUndefined();
  });

  it('nodo sparito → removeNodeIds', () => {
    const before = snap([{ id: 'a', defId: 'trigger_webhook' }, { id: 'b', defId: 'db_insert' }]);
    const after = snap([{ id: 'a', defId: 'trigger_webhook' }]);
    const p = diffSnapshots(before, after);
    expect(p.removeNodeIds).toEqual(['b']);
    expect(p.addNodes).toBeUndefined();
  });

  it('config cambiata (stesso id+defId) → updateNodes con config COMPLETA (replace)', () => {
    const before = snap([{ id: 'h', defId: 'action_http_request', config: { url: 'https://old', method: 'GET' } }]);
    const after = snap([{ id: 'h', defId: 'action_http_request', config: { url: 'https://new', method: 'GET' } }]);
    const p = diffSnapshots(before, after);
    expect(p.updateNodes).toEqual([{ id: 'h', patch: { config: { url: 'https://new', method: 'GET' } } }]);
    expect(p.addNodes).toBeUndefined(); // mut: non deve diventare add
    expect(p.removeNodeIds).toBeUndefined();
  });

  it('🚨 config riordinata (stesse coppie) → NESSUN update (deepEqual canonico)', () => {
    const before = snap([{ id: 'h', defId: 'action_http_request', config: { url: 'https://x', method: 'GET' } }]);
    const after = snap([{ id: 'h', defId: 'action_http_request', config: { method: 'GET', url: 'https://x' } }]);
    const p = diffSnapshots(before, after);
    expect(patchHasOps(p)).toBe(false); // mut: se deepEqual diventa ===, fallisce
  });

  it('🚨 stesso id ma defId DIVERSO → remove + add (l\'editor non patcha il tipo)', () => {
    const before = snap([{ id: 'n', defId: 'action_http_request', config: { url: 'https://x' } }]);
    const after = snap([{ id: 'n', defId: 'db_insert', config: { table: 'orders' } }]);
    const p = diffSnapshots(before, after);
    expect(p.removeNodeIds).toEqual(['n']);
    expect(p.addNodes).toEqual([{ id: 'n', defId: 'db_insert', config: { table: 'orders' } }]);
    expect(p.updateNodes).toBeUndefined(); // mut: NON deve essere un update
  });
});

describe('diffSnapshots — edge', () => {
  it('edge nuovo → addEdges con id from->to#', () => {
    const before = snap([{ id: 'a', defId: 'trigger_webhook' }, { id: 'b', defId: 'db_insert' }], []);
    const after = snap([{ id: 'a', defId: 'trigger_webhook' }, { id: 'b', defId: 'db_insert' }], [{ from: 'a', to: 'b' }]);
    const p = diffSnapshots(before, after);
    expect(p.addEdges).toEqual([{ id: 'a->b#', from: 'a', to: 'b' }]);
    expect(p.removeEdgeIds).toBeUndefined();
  });

  it('edge sparito → removeEdgeIds (id parsabile dall\'editor)', () => {
    const before = snap([{ id: 'a', defId: 'x' }, { id: 'b', defId: 'y' }], [{ from: 'a', to: 'b' }]);
    const after = snap([{ id: 'a', defId: 'x' }, { id: 'b', defId: 'y' }], []);
    const p = diffSnapshots(before, after);
    expect(p.removeEdgeIds).toEqual(['a->b#']);
    // l'id deve matchare la regex dell'editor ^([^>]+)->([^#]+)#
    expect(/^([^>]+)->([^#]+)#/u.test(p.removeEdgeIds![0]!)).toBe(true);
  });

  it('🚨 fromPort diverso = edge DIVERSO (if/switch a rami)', () => {
    const before = snap([{ id: 'if', defId: 'x' }, { id: 'b', defId: 'y' }], [{ from: 'if', to: 'b', fromPort: 'true' }]);
    const after = snap([{ id: 'if', defId: 'x' }, { id: 'b', defId: 'y' }], [{ from: 'if', to: 'b', fromPort: 'false' }]);
    const p = diffSnapshots(before, after);
    expect(p.addEdges).toEqual([{ id: 'if->b#false', from: 'if', to: 'b', fromPort: 'false' }]);
    expect(p.removeEdgeIds).toEqual(['if->b#true']); // mut: se fromPort ignorato, niente diff
  });

  it('edge fromPort preservato in addEdges', () => {
    const before = snap([{ id: 'if', defId: 'x' }, { id: 'b', defId: 'y' }], []);
    const after = snap([{ id: 'if', defId: 'x' }, { id: 'b', defId: 'y' }], [{ from: 'if', to: 'b', fromPort: 'true' }]);
    const p = diffSnapshots(before, after);
    expect(p.addEdges?.[0]?.fromPort).toBe('true');
  });
});

describe('diffSnapshots — determinismo', () => {
  it('addNodes/removeNodeIds ordinati per id (output stabile)', () => {
    const before = snap([{ id: 'z', defId: 'x' }, { id: 'a', defId: 'y' }]);
    const after = snap([{ id: 'm', defId: 'p' }, { id: 'c', defId: 'q' }]);
    const p = diffSnapshots(before, after);
    expect(p.addNodes?.map((n) => n.id)).toEqual(['c', 'm']);
    expect(p.removeNodeIds).toEqual(['a', 'z']);
  });
});

describe('edgeId', () => {
  it('senza fromPort → suffisso #vuoto', () => {
    expect(edgeId({ from: 'a', to: 'b' })).toBe('a->b#');
  });
  it('con fromPort → incluso dopo #', () => {
    expect(edgeId({ from: 'a', to: 'b', fromPort: 'err' })).toBe('a->b#err');
  });
});

describe('deepEqual', () => {
  it('primitivi e null', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('x', 'x')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false); // mut: null/undefined distinti
    expect(deepEqual(1, '1')).toBe(false);
  });
  it('array: ordine significativo', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
  });
  it('oggetti annidati: ordine chiavi irrilevante', () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
  it('🚨 chiave presente in a ma con valore undefined ≠ chiave assente in b', () => {
    // {a:undefined} ha 1 chiave, {} ne ha 0 → diverse per lunghezza
    expect(deepEqual({ a: undefined }, {})).toBe(false);
  });
});

describe('patchHasOps', () => {
  it('ogni singola op rende true', () => {
    const cases: WorkflowPatch[] = [
      { addNodes: [{ id: 'a', defId: 'x', config: {} }] },
      { removeNodeIds: ['a'] },
      { addEdges: [{ id: 'a->b#', from: 'a', to: 'b' }] },
      { removeEdgeIds: ['a->b#'] },
      { updateNodes: [{ id: 'a', patch: { config: {} } }] },
    ];
    for (const c of cases) expect(patchHasOps(c)).toBe(true);
    expect(patchHasOps({})).toBe(false);
  });
});
