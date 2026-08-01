/**
 * Bug-bounty test — paired-item lineage resolver (GAP #2 fondazione).
 *
 * Il resolver è il cuore del data-model n8n-grade: deve risolvere l'item
 * accoppiato GIUSTO attraverso ogni topologia reale (passthrough, multi-hop,
 * filter che droppa item, map 1→N, aggregate N→1 con pairedItem-array,
 * branch+merge con sourceNodeId), e degradare in modo sicuro su lineage rotto
 * o ciclico. I test costruiscono grafi a mano e pretendono l'item esatto —
 * niente greensmoke: se l'algoritmo sbagliasse anche solo l'indice, falliscono.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeToItems,
  resolvePairedItem,
  deriveOutputItems,
  deriveFanOutItems,
  lineage,
  type ExecutionItem,
  type RunItemGraph,
} from './item-model.js';

function items(...jsons: Record<string, unknown>[]): ExecutionItem[] {
  return jsons.map((json) => ({ json }));
}

/** Catena lineare A→B→C: predecessorOf banale. */
function linearPredecessor(map: Record<string, string>): (n: string) => string | undefined {
  return (n) => map[n];
}

describe('normalizeToItems', () => {
  it('array di oggetti → un item per elemento', () => {
    const r = normalizeToItems([{ a: 1 }, { a: 2 }]);
    expect(r).toEqual([{ json: { a: 1 } }, { json: { a: 2 } }]);
  });
  it('oggetto singolo → un item', () => {
    expect(normalizeToItems({ a: 1 })).toEqual([{ json: { a: 1 } }]);
  });
  it('scalare → wrappato in { json: { value } }', () => {
    expect(normalizeToItems(42)).toEqual([{ json: { value: 42 } }]);
  });
  it('array vuoto → []', () => {
    expect(normalizeToItems([])).toEqual([]);
  });
  it('già ExecutionItem[] → invariato (idempotente, preserva pairedItem)', () => {
    const src: ExecutionItem[] = [{ json: { a: 1 }, pairedItem: { item: 3 } }];
    expect(normalizeToItems(src)).toBe(src);
  });
  it('null/undefined → singolo item value', () => {
    expect(normalizeToItems(null)).toEqual([{ json: { value: null } }]);
    expect(normalizeToItems(undefined)).toEqual([{ json: { value: undefined } }]);
  });
});

describe('resolvePairedItem — casi base', () => {
  it('stesso nodo → ritorna il proprio item', () => {
    const g: RunItemGraph = new Map([['A', items({ x: 1 }, { x: 2 })]]);
    expect(resolvePairedItem(g, 'A', 1, 'A', () => undefined)?.json).toEqual({ x: 2 });
  });

  it('passthrough 1→1 single-hop: B.item[1] → A.item[1]', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ x: 'a0' }, { x: 'a1' })],
      ['B', [
        { json: { y: 'b0' }, pairedItem: lineage.oneToOne(0) },
        { json: { y: 'b1' }, pairedItem: lineage.oneToOne(1) },
      ]],
    ]);
    const r = resolvePairedItem(g, 'B', 1, 'A', linearPredecessor({ B: 'A' }));
    expect(r?.json).toEqual({ x: 'a1' });
  });

  it('lineage interrotto (nessun pairedItem) → undefined', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ x: 1 })],
      ['B', items({ y: 1 })], // nessun pairedItem
    ]);
    expect(resolvePairedItem(g, 'B', 0, 'A', linearPredecessor({ B: 'A' }))).toBeUndefined();
  });
});

describe('resolvePairedItem — filter che droppa item (re-indicizzazione)', () => {
  it('B tiene solo gli item dispari di A → B.item[0] punta ad A.item[1]', () => {
    // A: [a0,a1,a2,a3]; filtro tiene a1,a3 → B:[{from a1},{from a3}]
    const g: RunItemGraph = new Map([
      ['A', items({ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 })],
      ['B', [
        { json: { n: 1 }, pairedItem: lineage.from(1) },
        { json: { n: 3 }, pairedItem: lineage.from(3) },
      ]],
    ]);
    expect(resolvePairedItem(g, 'B', 0, 'A', linearPredecessor({ B: 'A' }))?.json).toEqual({ n: 1 });
    expect(resolvePairedItem(g, 'B', 1, 'A', linearPredecessor({ B: 'A' }))?.json).toEqual({ n: 3 });
  });
});

describe('resolvePairedItem — multi-hop (C→B→A) sopravvive alla catena', () => {
  it('da C.item[0], dopo un filtro in B, risolve l\'item corretto di A', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ id: 'a0' }, { id: 'a1' }, { id: 'a2' })],
      // B filtra: tiene a2 → B[0] ← A[2]
      ['B', [{ json: { id: 'a2' }, pairedItem: lineage.from(2) }]],
      // C mappa 1:1 su B → C[0] ← B[0]
      ['C', [{ json: { id: 'a2', enriched: true }, pairedItem: lineage.oneToOne(0) }]],
    ]);
    const pred = linearPredecessor({ C: 'B', B: 'A' });
    // $('A').item da C deve risalire C→B→A e dare A[2]
    expect(resolvePairedItem(g, 'C', 0, 'A', pred)?.json).toEqual({ id: 'a2' });
    // $('B').item da C deve dare B[0]
    expect(resolvePairedItem(g, 'C', 0, 'B', pred)?.json).toEqual({ id: 'a2' });
  });
});

describe('resolvePairedItem — map 1→N (un input genera più output)', () => {
  it('B esplode A[0] in 3 item: tutti risalgono ad A[0]', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ csv: 'r0' }, { csv: 'r1' })],
      ['B', [
        { json: { row: 0 }, pairedItem: lineage.from(0) },
        { json: { row: 1 }, pairedItem: lineage.from(0) },
        { json: { row: 2 }, pairedItem: lineage.from(0) },
        { json: { row: 3 }, pairedItem: lineage.from(1) },
      ]],
    ]);
    const pred = linearPredecessor({ B: 'A' });
    expect(resolvePairedItem(g, 'B', 0, 'A', pred)?.json).toEqual({ csv: 'r0' });
    expect(resolvePairedItem(g, 'B', 2, 'A', pred)?.json).toEqual({ csv: 'r0' });
    expect(resolvePairedItem(g, 'B', 3, 'A', pred)?.json).toEqual({ csv: 'r1' });
  });
});

describe('resolvePairedItem — aggregate N→1 (pairedItem array)', () => {
  it('B aggrega A[0..2] in 1 item: risolve il PRIMO percorso (A[0])', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ v: 10 }, { v: 20 }, { v: 30 })],
      ['B', [{ json: { sum: 60 }, pairedItem: lineage.fromMany([0, 1, 2]) }]],
    ]);
    const r = resolvePairedItem(g, 'B', 0, 'A', linearPredecessor({ B: 'A' }));
    expect(r?.json).toEqual({ v: 10 }); // primo ref dell'array
  });
});

describe('resolvePairedItem — branch + merge con sourceNodeId', () => {
  it('un merge multi-input disambigua il ramo via sourceNodeId', () => {
    // A e B confluiscono in M. M[0] viene da A[1], M[1] viene da B[0].
    const g: RunItemGraph = new Map([
      ['A', items({ src: 'A', i: 0 }, { src: 'A', i: 1 })],
      ['B', items({ src: 'B', i: 0 })],
      ['M', [
        { json: { merged: 'a' }, pairedItem: { item: 1, sourceNodeId: 'A' } },
        { json: { merged: 'b' }, pairedItem: { item: 0, sourceNodeId: 'B' } },
      ]],
    ]);
    // predecessorOf NON è univoco per M (2 input) → DEVE usare sourceNodeId.
    const pred = (_n: string): string | undefined => undefined;
    expect(resolvePairedItem(g, 'M', 0, 'A', pred)?.json).toEqual({ src: 'A', i: 1 });
    expect(resolvePairedItem(g, 'M', 1, 'B', pred)?.json).toEqual({ src: 'B', i: 0 });
    // chiedere A dall'item che viene da B → non risolvibile
    expect(resolvePairedItem(g, 'M', 1, 'A', pred)).toBeUndefined();
  });
});

describe('resolvePairedItem — robustezza (no crash, no loop infinito)', () => {
  it('ref a indice fuori range → undefined', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ x: 1 })],
      ['B', [{ json: { y: 1 }, pairedItem: lineage.from(99) }]],
    ]);
    expect(resolvePairedItem(g, 'B', 0, 'A', linearPredecessor({ B: 'A' }))).toBeUndefined();
  });

  it('ciclo nel lineage (A↔B) → termina con undefined, niente stack overflow', () => {
    const g: RunItemGraph = new Map([
      ['A', [{ json: { x: 1 }, pairedItem: { item: 0, sourceNodeId: 'B' } }]],
      ['B', [{ json: { y: 1 }, pairedItem: { item: 0, sourceNodeId: 'A' } }]],
    ]);
    // target irraggiungibile 'Z' → il walk cicla A→B→A… ma la guardia hops/visited ferma.
    expect(resolvePairedItem(g, 'A', 0, 'Z', () => undefined)).toBeUndefined();
  });

  it('nodo target assente dal grafo → undefined', () => {
    const g: RunItemGraph = new Map([
      ['B', [{ json: { y: 1 }, pairedItem: lineage.from(0) }]],
    ]);
    expect(resolvePairedItem(g, 'B', 0, 'A', linearPredecessor({ B: 'A' }))).toBeUndefined();
  });

  it('predecessorOf assente E sourceNodeId assente → undefined (no resolve cieco)', () => {
    const g: RunItemGraph = new Map([
      ['A', items({ x: 1 })],
      ['B', [{ json: { y: 1 }, pairedItem: { item: 0 } }]], // no sourceNodeId
    ]);
    expect(resolvePairedItem(g, 'B', 0, 'A', () => undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// deriveOutputItems — fase 4.2: come l'engine costruisce il grafo
// ─────────────────────────────────────────────────────────────────

describe('deriveOutputItems — items DICHIARATI dall\'executor (precedenza 1)', () => {
  it('declared usati as-is, con ENRICHMENT del sourceNodeId runtime sui ref che non lo dichiarano', () => {
    const declared: ExecutionItem[] = [
      { json: { v: 'a3' }, pairedItem: { item: 2 } },
      { json: { v: 'x' }, pairedItem: { item: 0, sourceNodeId: 'OTHER' } }, // già esplicito → intatto
    ];
    const r = deriveOutputItems({ output: { blob: true }, declared, sourceNodeId: 'A', sourceItemCount: 4 });
    expect(r[0]?.pairedItem).toEqual({ item: 2, sourceNodeId: 'A' });
    expect(r[1]?.pairedItem).toEqual({ item: 0, sourceNodeId: 'OTHER' });
  });

  it('enrichment copre anche i pairedItem ARRAY (fromMany)', () => {
    const declared: ExecutionItem[] = [
      { json: { sum: 1 }, pairedItem: [{ item: 0 }, { item: 2, sourceNodeId: 'B' }] },
    ];
    const r = deriveOutputItems({ output: {}, declared, sourceNodeId: 'A', sourceItemCount: 3 });
    expect(r[0]?.pairedItem).toEqual([
      { item: 0, sourceNodeId: 'A' },
      { item: 2, sourceNodeId: 'B' },
    ]);
  });

  it('declared SENZA sorgente runtime (root) → as-is, nessun enrichment', () => {
    const declared: ExecutionItem[] = [{ json: { v: 1 }, pairedItem: { item: 1 } }];
    const r = deriveOutputItems({ output: {}, declared });
    expect(r[0]?.pairedItem).toEqual({ item: 1 });
  });

  it('declared vince sull\'euristica: 1 output da 3 input NON diventa fromMany', () => {
    const declared: ExecutionItem[] = [{ json: { v: 'a2' }, pairedItem: { item: 2 } }];
    const r = deriveOutputItems({ output: { blob: 1 }, declared, sourceNodeId: 'A', sourceItemCount: 3 });
    expect(r).toHaveLength(1);
    expect(r[0]?.pairedItem).toEqual({ item: 2, sourceNodeId: 'A' });
  });
});

describe('deriveOutputItems — euristica conservativa (parità n8n item-linking)', () => {
  it('sorgente con 1 item → OGNI output deriva da {item:0}', () => {
    const r = deriveOutputItems({ output: [{ a: 1 }, { a: 2 }, { a: 3 }], sourceNodeId: 'S', sourceItemCount: 1 });
    expect(r).toHaveLength(3);
    for (const it of r) expect(it.pairedItem).toEqual({ item: 0, sourceNodeId: 'S' });
  });

  it('stessa cardinalità → pairing posizionale 1:1 (indici REALI, non 0 fisso)', () => {
    const r = deriveOutputItems({ output: [{ a: 1 }, { a: 2 }, { a: 3 }], sourceNodeId: 'S', sourceItemCount: 3 });
    expect(r.map((it) => it.pairedItem)).toEqual([
      { item: 0, sourceNodeId: 'S' },
      { item: 1, sourceNodeId: 'S' },
      { item: 2, sourceNodeId: 'S' },
    ]);
  });

  it('N→1 (aggregazione) → l\'unico output deriva da TUTTI gli input (fromMany)', () => {
    const r = deriveOutputItems({ output: { sum: 6 }, sourceNodeId: 'S', sourceItemCount: 3 });
    expect(r).toHaveLength(1);
    expect(r[0]?.pairedItem).toEqual([
      { item: 0, sourceNodeId: 'S' },
      { item: 1, sourceNodeId: 'S' },
      { item: 2, sourceNodeId: 'S' },
    ]);
  });

  it('🚨 cardinalità non deducibile (3→2) → NESSUN pairing: mai lineage inventato', () => {
    const r = deriveOutputItems({ output: [{ a: 1 }, { a: 2 }], sourceNodeId: 'S', sourceItemCount: 3 });
    expect(r).toHaveLength(2);
    for (const it of r) expect(it.pairedItem).toBeUndefined();
  });

  it('item che dichiara già il PROPRIO pairedItem → MAI sovrascritto dall\'euristica', () => {
    const out: ExecutionItem[] = [
      { json: { v: 1 }, pairedItem: { item: 5 } },
      { json: { v: 2 } },
    ];
    const r = deriveOutputItems({ output: out, sourceNodeId: 'S', sourceItemCount: 2 });
    expect(r[0]?.pairedItem).toEqual({ item: 5 }); // intatto
    expect(r[1]?.pairedItem).toEqual({ item: 1, sourceNodeId: 'S' }); // euristica 1:1
  });

  it('sorgente assente (root/trigger) o vuota → item senza lineage', () => {
    expect(deriveOutputItems({ output: [{ a: 1 }] })[0]?.pairedItem).toBeUndefined();
    expect(deriveOutputItems({ output: [{ a: 1 }], sourceNodeId: 'S', sourceItemCount: 0 })[0]?.pairedItem).toBeUndefined();
  });

  it('non muta l\'output reale: il pairedItem vive solo sulla copia nel grafo', () => {
    const out = [{ a: 1 }];
    deriveOutputItems({ output: out, sourceNodeId: 'S', sourceItemCount: 1 });
    expect(out[0]).toEqual({ a: 1 }); // il dato che viaggia resta pulito
  });
});

describe('deriveFanOutItems — lineage by-construction del fan-out (GAP 1 × GAP 2)', () => {
  it('results[i] → pairedItem {item:i, sourceNodeId:S} con indici REALI', () => {
    const r = deriveFanOutItems([{ p: 'a' }, { p: 'b' }, { p: 'c' }], 'src');
    expect(r.map((it) => it.pairedItem)).toEqual([
      { item: 0, sourceNodeId: 'src' },
      { item: 1, sourceNodeId: 'src' },
      { item: 2, sourceNodeId: 'src' },
    ]);
    expect(r[1]?.json).toEqual({ p: 'b' });
  });

  it('sorgente assente (fan-out su trigger input) → nessun lineage', () => {
    const r = deriveFanOutItems([{ p: 'a' }], undefined);
    expect(r[0]?.pairedItem).toBeUndefined();
  });

  it('un result ARRAY resta UN item (non viene splittato)', () => {
    const r = deriveFanOutItems([['x', 'y']], 'src');
    expect(r).toHaveLength(1);
    expect(r[0]?.json).toEqual({ value: ['x', 'y'] });
    expect(r[0]?.pairedItem).toEqual({ item: 0, sourceNodeId: 'src' });
  });

  it('result già ExecutionItem con pairedItem proprio → preservato', () => {
    const r = deriveFanOutItems([{ json: { v: 1 }, pairedItem: { item: 7 } }], 'src');
    expect(r[0]?.pairedItem).toEqual({ item: 7 });
  });

  it('error-item soft-failed occupa la SUA posizione col SUO lineage', () => {
    const r = deriveFanOutItems([
      { ok: 1 },
      { error: { message: 'boom', index: 1 } },
      { ok: 3 },
    ], 'src');
    expect(r[1]?.pairedItem).toEqual({ item: 1, sourceNodeId: 'src' });
  });
});
