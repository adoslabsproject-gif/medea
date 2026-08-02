/**
 * Bug-bounty test — ExecutionItem schema/guard/helper (data-model array-of-items).
 *
 * Il contratto è condiviso tra engine ed executor: se accettasse item malformati
 * (json scalare, pairedItem con indice negativo, binary non-BinaryData) il
 * lineage e la risoluzione `$('node').item` si corromperebbero a valle. Questi
 * test PRETENDONO che lo schema Zod rifiuti l'invalido e che gli helper
 * normalizzino/costruiscano esattamente — niente greensmoke.
 */
import { describe, it, expect } from 'vitest';
import {
  ExecutionItemSchema,
  PairedItemRefSchema,
  isExecutionItem,
  isPairedItemRef,
  pairedRefs,
  normalizeToItems,
  lineage,
} from './item.js';
import { makeBinaryInline } from './binary.js';

describe('ExecutionItemSchema — validazione Zod', () => {
  it('accetta json oggetto + binary BinaryData + pairedItem singolo', () => {
    const bin = makeBinaryInline({
      mimeType: 'text/plain',
      data: Buffer.from('x').toString('base64'),
    });
    const r = ExecutionItemSchema.safeParse({
      json: { a: 1 },
      binary: { data: bin },
      pairedItem: { item: 0 },
    });
    expect(r.success).toBe(true);
  });

  it('accetta pairedItem ARRAY (merge N→1)', () => {
    expect(
      ExecutionItemSchema.safeParse({ json: {}, pairedItem: [{ item: 0 }, { item: 1 }] }).success,
    ).toBe(true);
  });

  it('🚨 RIFIUTA json scalare (gli item DEVONO essere oggetti)', () => {
    expect(ExecutionItemSchema.safeParse({ json: 42 }).success).toBe(false);
    expect(ExecutionItemSchema.safeParse({ json: 'str' }).success).toBe(false);
    expect(ExecutionItemSchema.safeParse({ json: null }).success).toBe(false);
  });

  it('🚨 RIFIUTA pairedItem con indice negativo o non intero', () => {
    expect(PairedItemRefSchema.safeParse({ item: -1 }).success).toBe(false);
    expect(PairedItemRefSchema.safeParse({ item: 1.5 }).success).toBe(false);
    expect(PairedItemRefSchema.safeParse({ item: 0 }).success).toBe(true);
  });

  it('🚨 RIFIUTA binary che non è un BinaryData', () => {
    expect(
      ExecutionItemSchema.safeParse({ json: {}, binary: { data: { foo: 'bar' } } }).success,
    ).toBe(false);
  });

  it('🚨 RIFIUTA sourceNodeId vuoto', () => {
    expect(PairedItemRefSchema.safeParse({ item: 0, sourceNodeId: '' }).success).toBe(false);
    expect(PairedItemRefSchema.safeParse({ item: 0, sourceNodeId: 'A' }).success).toBe(true);
  });
});

describe('isExecutionItem / isPairedItemRef', () => {
  it('isExecutionItem: true solo con json oggetto non-array', () => {
    expect(isExecutionItem({ json: { a: 1 } })).toBe(true);
    expect(isExecutionItem({ json: [] })).toBe(false);
    expect(isExecutionItem({ json: 1 })).toBe(false);
    expect(isExecutionItem({ notjson: {} })).toBe(false);
    expect(isExecutionItem(null)).toBe(false);
    expect(isExecutionItem([{ json: {} }])).toBe(false);
  });
  it('isPairedItemRef: richiede item intero >=0', () => {
    expect(isPairedItemRef({ item: 0 })).toBe(true);
    expect(isPairedItemRef({ item: -1 })).toBe(false);
    expect(isPairedItemRef({ item: 2.2 })).toBe(false);
    expect(isPairedItemRef({})).toBe(false);
  });
});

describe('normalizeToItems', () => {
  it('array oggetti → un item ciascuno', () => {
    expect(normalizeToItems([{ a: 1 }, { a: 2 }])).toEqual([
      { json: { a: 1 } },
      { json: { a: 2 } },
    ]);
  });
  it('oggetto singolo → un item', () => {
    expect(normalizeToItems({ a: 1 })).toEqual([{ json: { a: 1 } }]);
  });
  it('scalare → { json: { value } }', () => {
    expect(normalizeToItems(42)).toEqual([{ json: { value: 42 } }]);
  });
  it('array misto scalari → ogni elemento wrappato', () => {
    expect(normalizeToItems([1, { a: 2 }])).toEqual([{ json: { value: 1 } }, { json: { a: 2 } }]);
  });
  it('array vuoto → []', () => {
    expect(normalizeToItems([])).toEqual([]);
  });
  it('già ExecutionItem[] → invariato (preserva pairedItem)', () => {
    const src = [{ json: { a: 1 }, pairedItem: { item: 3 } }];
    expect(normalizeToItems(src)).toBe(src);
  });
  it('🚨 ogni output di normalizeToItems passa lo schema Zod (contract)', () => {
    for (const raw of [42, 'x', null, { a: 1 }, [{ b: 2 }], [1, 2]]) {
      for (const item of normalizeToItems(raw)) {
        expect(ExecutionItemSchema.safeParse(item).success, `raw=${JSON.stringify(raw)}`).toBe(
          true,
        );
      }
    }
  });
});

describe('lineage builders + pairedRefs', () => {
  it('oneToOne/from senza sourceNodeId → nessun campo sourceNodeId', () => {
    expect(lineage.oneToOne(2)).toEqual({ item: 2 });
    expect(lineage.from(5)).toEqual({ item: 5 });
  });
  it('con sourceNodeId → incluso', () => {
    expect(lineage.from(1, 'NodoA')).toEqual({ item: 1, sourceNodeId: 'NodoA' });
  });
  it('fromMany → array di ref', () => {
    expect(lineage.fromMany([0, 1, 2])).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
    expect(lineage.fromMany([0, 1], 'M')).toEqual([
      { item: 0, sourceNodeId: 'M' },
      { item: 1, sourceNodeId: 'M' },
    ]);
  });
  it('pairedRefs normalizza singolo|array|undefined', () => {
    expect(pairedRefs(undefined)).toEqual([]);
    expect(pairedRefs({ item: 1 })).toEqual([{ item: 1 }]);
    expect(pairedRefs([{ item: 1 }, { item: 2 }])).toEqual([{ item: 1 }, { item: 2 }]);
  });
  it('🚨 i ref costruiti da lineage passano lo schema', () => {
    expect(PairedItemRefSchema.safeParse(lineage.oneToOne(0)).success).toBe(true);
    expect(PairedItemRefSchema.safeParse(lineage.from(3, 'A')).success).toBe(true);
    for (const r of lineage.fromMany([0, 1]))
      expect(PairedItemRefSchema.safeParse(r).success).toBe(true);
  });
});
