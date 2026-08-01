/**
 * Test REALI di action_filter — executor vero su dati veri.
 *
 * Focus GAP #2 (paired items): un filtro SCARTA item, quindi è il caso
 * paradigmatico in cui l'engine NON può dedurre il lineage e l'executor lo
 * DICHIARA (result.items con l'indice ORIGINALE di input). I test pretendono
 * gli indici esatti — se la dichiarazione slittasse di uno o sparisse,
 * falliscono. Coperto anche il contratto storico dell'output (shape blob
 * invariata) e i casi in cui dichiarare sarebbe SBAGLIATO (config.items
 * espressione, input stringa JSON) → niente dichiarazione, onesto.
 */
import { describe, it, expect } from 'vitest';
import { filterNode } from './filter.js';

const filter = filterNode.executor!;
const ctx = {} as never;

const people = [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }];
const dropA2 = JSON.stringify({ combinator: 'AND', rules: [{ field: 'name', op: 'not_equals', value: 'a2' }] });
const keepNone = JSON.stringify({ combinator: 'AND', rules: [{ field: 'name', op: 'equals', value: 'zzz' }] });

describe('action_filter — contratto storico dell\'output (invariato)', () => {
  it('separa kept/removed con conteggi e branch', async () => {
    const r = await filter({ conditions: dropA2 }, people, ctx);
    const o = r.output as { kept: unknown[]; removed: unknown[]; keptCount: number; removedCount: number; total: number };
    expect(o.kept).toEqual([{ name: 'a1' }, { name: 'a3' }]);
    expect(o.removed).toEqual([{ name: 'a2' }]);
    expect(o.keptCount).toBe(2);
    expect(o.removedCount).toBe(1);
    expect(o.total).toBe(3);
    expect(r.branch).toBe('kept');
  });
});

describe('🚨 action_filter — dichiarazione lineage (GAP #2)', () => {
  it('kept [a1,a3] da [a1,a2,a3] → items con indici ORIGINALI {0} e {2} (non {0},{1})', async () => {
    const r = await filter({ conditions: dropA2 }, people, ctx);
    const items = r.items!;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ json: { name: 'a1' }, pairedItem: { item: 0 } });
    // L'indice 2 è LA prova: un pairing posizionale ricalcolato direbbe 1.
    expect(items[1]).toEqual({ json: { name: 'a3' }, pairedItem: { item: 2 } });
  });

  it('nessun kept → branch "removed" e dichiara i REMOVED (sono loro a proseguire)', async () => {
    const r = await filter({ conditions: keepNone }, people, ctx);
    expect(r.branch).toBe('removed');
    const items = r.items!;
    expect(items.map((it) => it.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('elementi scalari → wrappati {json:{value}} col loro indice', async () => {
    const rules = JSON.stringify({ rules: [{ field: '', op: 'not_equals', value: 'b' }] });
    const r = await filter({ conditions: rules }, ['a', 'b', 'c'], ctx);
    const items = r.items!;
    expect(items).toEqual([
      { json: { value: 'a' }, pairedItem: { item: 0 } },
      { json: { value: 'c' }, pairedItem: { item: 2 } },
    ]);
  });

  it('🚨 input già ExecutionItem[] con pairedItem TRASCINATO → SOVRASCRITTO con l\'indice del filtro (review 4.2)', async () => {
    // Il pairedItem sugli item di input riferisce l'input della SORGENTE
    // (un hop più su): se il filtro lo preservasse, l'engine lo
    // reinterpreterebbe contro la sorgente sbagliata. Il filtro è
    // autoritativo sul mapping del PROPRIO input.
    const itemsIn = [
      { json: { name: 'a1' }, pairedItem: { item: 999 } },
      { json: { name: 'a2' }, pairedItem: { item: 888 } },
      { json: { name: 'a3' }, pairedItem: { item: 777 } },
    ];
    const dropA2Nested = JSON.stringify({ combinator: 'AND', rules: [{ field: 'json.name', op: 'not_equals', value: 'a2' }] });
    const r = await filter({ conditions: dropA2Nested }, itemsIn, ctx);
    const items = r.items!;
    expect(items.map((it) => it.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
  });

  it('🚨 config.items (espressione) → NESSUNA dichiarazione: gli indici non riferiscono alla sorgente', async () => {
    const r = await filter({ items: [{ name: 'x' }], conditions: dropA2 }, people, ctx);
    expect(r.items).toBeUndefined();
  });

  it('🚨 input stringa JSON → NESSUNA dichiarazione (la vista item della sorgente è 1 item, non N)', async () => {
    const r = await filter({ conditions: dropA2 }, JSON.stringify(people), ctx);
    expect(r.items).toBeUndefined();
    // ma il filtro funziona comunque
    const o = r.output as { keptCount: number };
    expect(o.keptCount).toBe(2);
  });
});

describe('action_filter — anti-ReDoS (H2)', () => {
  // L'op `regex` confronta il pattern (config) contro i dati item (attacker-controlled).
  // Pre-fix: `new RegExp` di V8 → ReDoS. Post-fix: safeUserRegex (RE2 lineare).
  it('🚨 un pattern regex evil su item lungo NON blocca (< 1s)', async () => {
    const rules = JSON.stringify({ combinator: 'AND', rules: [{ field: '', op: 'regex', value: '(a+)+$' }] });
    const items = ['a'.repeat(70) + '!']; // forza il backtracking massimo su V8
    const t0 = performance.now();
    const r = await filter({ conditions: rules }, items, ctx);
    const elapsed = performance.now() - t0;
    const o = r.output as { keptCount: number };
    expect(o.keptCount).toBe(0); // no match → item scartato
    expect(elapsed).toBeLessThan(1000); // RE2 ~ms; col vecchio new RegExp >3000ms
  });

  it('anti-regressione: l\'op regex valido continua a filtrare correttamente', async () => {
    const rules = JSON.stringify({ combinator: 'AND', rules: [{ field: '', op: 'regex', value: '^a[0-9]$' }] });
    const r = await filter({ conditions: rules }, ['a1', 'b2', 'a3'], ctx);
    const o = r.output as { keptCount: number };
    expect(o.keptCount).toBe(2); // a1, a3
  });
});
