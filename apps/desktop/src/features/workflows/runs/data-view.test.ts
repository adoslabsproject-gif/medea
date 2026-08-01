import { describe, expect, it } from 'vitest';

import { asTable, cell, childrenOf, summarize } from './data-view';

describe('i rami di un valore', () => {
  it('un oggetto dà un ramo per chiave, col percorso per raggiungerla', () => {
    const rami = childrenOf({ nome: 'Ada', eta: 36 }, '$node.x.json');
    expect(rami.map((r) => r.path)).toEqual(['$node.x.json.nome', '$node.x.json.eta']);
  });

  it('una lista dà un ramo per indice', () => {
    const rami = childrenOf(['a', 'b'], '$node.x.json.righe');
    expect(rami.map((r) => r.path)).toEqual(['$node.x.json.righe[0]', '$node.x.json.righe[1]']);
  });

  it('le chiavi che non sono identificatori vanno fra parentesi', () => {
    // `json.content-type` non si risolve; `json["content-type"]` sì. Copiare
    // la prima significherebbe consegnare un'espressione rotta.
    const rami = childrenOf({ 'content-type': 'application/json' }, '$node.x.json');
    expect(rami[0]?.path).toBe('$node.x.json["content-type"]');
  });

  it('riconosce di che tipo è ogni valore', () => {
    const rami = childrenOf({ o: {}, l: [], t: 'x', n: 1, b: true, v: null }, '$');
    expect(rami.map((r) => r.kind)).toEqual([
      'oggetto',
      'lista',
      'testo',
      'numero',
      'booleano',
      'vuoto',
    ]);
  });

  it('un valore che non ha figli non ne inventa', () => {
    expect(childrenOf('testo', '$')).toEqual([]);
    expect(childrenOf(42, '$')).toEqual([]);
  });
});

describe('come si riassume un valore in una riga', () => {
  it('i contenitori dicono quanto contengono, non cosa', () => {
    expect(summarize([1, 2, 3], 'lista', 3)).toBe('3 elementi');
    expect(summarize({ a: 1 }, 'oggetto', 1)).toBe('1 campo');
  });

  it('un testo lungo si tronca invece di sfondare la riga', () => {
    const lungo = 'x'.repeat(200);
    expect(summarize(lungo, 'testo').length).toBeLessThan(90);
  });

  it('distingue null da assente', () => {
    expect(summarize(null, 'vuoto')).toBe('null');
    expect(summarize(undefined, 'vuoto')).toBe('—');
  });
});

describe('quando una tabella ha senso', () => {
  it('un array di oggetti diventa righe e colonne', () => {
    const t = asTable([
      { id: 1, nome: 'Ada' },
      { id: 2, nome: 'Grace' },
    ]);
    expect(t?.columns).toEqual(['id', 'nome']);
    expect(t?.rows).toHaveLength(2);
  });

  it('le colonne sono l’unione delle chiavi', () => {
    // Un elemento a cui manca una chiave lascia la cella vuota, non fa
    // sparire la colonna dagli altri.
    const t = asTable([{ a: 1 }, { b: 2 }]);
    expect(t?.columns).toEqual(['a', 'b']);
  });

  it('una lista di numeri non è una tabella', () => {
    expect(asTable([1, 2, 3])).toBeNull();
  });

  it('una lista mista nemmeno: la tabella mentirebbe su cosa c’è dentro', () => {
    expect(asTable([{ a: 1 }, 'testo'])).toBeNull();
  });

  it('un oggetto solo non è una tabella', () => {
    expect(asTable({ a: 1 })).toBeNull();
  });
});

describe('le celle', () => {
  it('mostrano i valori semplici così come sono', () => {
    expect(cell('x')).toBe('x');
    expect(cell(42)).toBe('42');
  });

  it('e per i contenitori dicono che ci sono, senza srotolarli', () => {
    expect(cell([1, 2])).toBe('[2]');
    expect(cell({ a: 1 })).toBe('{…}');
    expect(cell(null)).toBe('');
  });
});
