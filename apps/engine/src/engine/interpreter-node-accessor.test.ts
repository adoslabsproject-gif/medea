/**
 * Bug-bounty test — accessor cross-nodo `$('NodeName')` nell'interprete (GAP #2).
 *
 * Verifica il contratto di `$('Node').all()/.first()/.last()/.itemAt()` (questi
 * CORRETTI senza lineage; il paired .item/itemMatching n8n arriva in fase 4) SIA
 * end-to-end dentro evaluateExpression (che non deve bloccarlo come "unsafe").
 * Niente greensmoke: assertiamo gli item esatti, la normalizzazione blob/array,
 * il nodo mancante, e che il security scan NON rompa la sintassi `$(...)`.
 */
import { describe, it, expect } from 'vitest';
import { makeNodeAccessor, evaluateExpression, type InterpreterScope, type LineageContext } from './interpreter.js';
import { lineage, type RunItemGraph, type ExecutionItem } from './item-model.js';

describe('makeNodeAccessor — funzione pura', () => {
  const vars = {
    Http: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }], // array → 3 item
    Single: { ok: true },                                                      // oggetto → 1 item
    Scalar: 42,                                                                 // scalare → wrap
  };
  const $ = makeNodeAccessor(vars);

  it('all() ritorna tutti gli item normalizzati', () => {
    expect($('Http').all().map((i) => i.json)).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);
  });
  it('first()/last() ritornano il primo/ultimo item', () => {
    expect($('Http').first().json).toEqual({ id: 1, name: 'a' });
    expect($('Http').last().json).toEqual({ id: 3, name: 'c' });
  });
  it('itemAt(i) = accesso POSIZIONALE per indice, undefined se fuori range', () => {
    expect($('Http').itemAt(1)?.json).toEqual({ id: 2, name: 'b' });
    expect($('Http').itemAt(9)).toBeUndefined();
  });

  it('itemAt è POSIZIONALE (NON paired): itemAt(0) è sempre il primo item', () => {
    expect($('Http').itemAt(0)?.json).toEqual({ id: 1, name: 'a' });
  });

  it('🚨 senza LineageContext, .item / itemMatching ritornano undefined (no crash)', () => {
    expect($('Http').item).toBeUndefined();
    expect($('Http').itemMatching(0)).toBeUndefined();
  });
  it('oggetto singolo → 1 item', () => {
    expect($('Single').all().map((i) => i.json)).toEqual([{ ok: true }]);
    expect($('Single').first().json).toEqual({ ok: true });
  });
  it('scalare → wrappato in { value }', () => {
    expect($('Scalar').first().json).toEqual({ value: 42 });
  });
  it('🚨 nodo inesistente → nessun item, first() = item vuoto (no crash)', () => {
    expect($('Ghost').all()).toEqual([]);
    expect($('Ghost').first().json).toEqual({});
    expect($('Ghost').itemAt(0)).toBeUndefined();
  });
});

describe('$(\'Node\') end-to-end in evaluateExpression', () => {
  const scope: InterpreterScope = {
    vars: {
      Http: [{ price: 10 }, { price: 20 }, { price: 30 }],
      User: { email: 'a@b.it' },
    },
  };

  it('🚨 $(\'Http\').first().json.price → 10 (non bloccato dal security scan)', () => {
    expect(evaluateExpression("$('Http').first().json.price", scope)).toBe(10);
  });
  it('$(\'Http\').last().json.price → 30', () => {
    expect(evaluateExpression("$('Http').last().json.price", scope)).toBe(30);
  });
  it('$(\'Http\').all().length → 3', () => {
    expect(evaluateExpression("$('Http').all().length", scope)).toBe(3);
  });
  it('$(\'Http\').itemAt(1).json.price → 20 (posizionale)', () => {
    expect(evaluateExpression("$('Http').itemAt(1).json.price", scope)).toBe(20);
  });
  it('$(\'User\').first().json.email → a@b.it', () => {
    expect(evaluateExpression("$('User').first().json.email", scope)).toBe('a@b.it');
  });
  it('somma cross-item: $(\'Http\').all().reduce((s,i)=>s+i.json.price,0) → 60', () => {
    expect(evaluateExpression("$('Http').all().reduce((s, i) => s + i.json.price, 0)", scope)).toBe(60);
  });
  it('🚨 nodo inesistente in expression → item vuoto, undefined field (no throw)', () => {
    expect(evaluateExpression("$('Nope').first().json.x", scope)).toBeUndefined();
  });
});

describe('$(\'Node\').item / itemMatching — semantica PAIRED via lineage', () => {
  // Topologia: A → (filter B tiene a1,a3) → C(map 1:1). Da C l'item corrente
  // deve risolvere l'item ACCOPPIATO di A, non quello posizionale.
  const graph: RunItemGraph = new Map<string, ExecutionItem[]>([
    ['A', [{ json: { n: 0 } }, { json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]],
    ['B', [
      { json: { n: 1 }, pairedItem: lineage.from(1) },
      { json: { n: 3 }, pairedItem: lineage.from(3) },
    ]],
    ['C', [
      { json: { n: 1, x: true }, pairedItem: lineage.oneToOne(0) },
      { json: { n: 3, x: true }, pairedItem: lineage.oneToOne(1) },
    ]],
  ]);
  const predecessorOf = (n: string): string | undefined => ({ C: 'B', B: 'A' } as Record<string, string>)[n];

  function ctxAt(itemIndex: number): LineageContext {
    return { graph, nodeId: 'C', itemIndex, predecessorOf };
  }

  it('🚨 .item dall\'item C[0] risolve A[1] (paired, NON posizionale A[0])', () => {
    // vars contiene l'output di A (per itemAt) + lineage ctx (per .item).
    const $ = makeNodeAccessor({ A: graph.get('A')!.map((i) => i.json) }, ctxAt(0));
    expect($('A').item?.json).toEqual({ n: 1 });
    // contrasto: itemAt(0) posizionale (legge i vars) darebbe A[0]={n:0}, NON l'accoppiato
    expect($('A').itemAt(0)?.json).toEqual({ n: 0 });
  });

  it('🚨 .item dall\'item C[1] risolve A[3]', () => {
    const $ = makeNodeAccessor({}, ctxAt(1));
    expect($('A').item?.json).toEqual({ n: 3 });
  });

  it('🚨 itemMatching(inputIndex) risolve dal dato input item del nodo corrente', () => {
    const $ = makeNodeAccessor({}, ctxAt(0));
    // itemMatching(1) = paired con l'input item 1 di C → C[1]→B[1]→A[3]
    expect($('A').itemMatching(1)?.json).toEqual({ n: 3 });
    expect($('B').itemMatching(0)?.json).toEqual({ n: 1 });
  });

  it('🚨 end-to-end in evaluateExpression: $(\'A\').item.json.n → 3', () => {
    const scope: InterpreterScope = { vars: {}, lineage: ctxAt(1) };
    expect(evaluateExpression("$('A').item.json.n", scope)).toBe(3);
  });
});
