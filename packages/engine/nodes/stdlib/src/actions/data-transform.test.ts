/**
 * Test REALI dei data-transformation nodes — eseguono gli executor veri su dati
 * reali, niente stub. Coprono i casi-limite che rompono i parser ingenui (CSV
 * quote/newline), il dot-path annidato, l'immutabilità del SET e i guard di errore.
 */
import { describe, it, expect } from 'vitest';
import { csvNode, arrayNode, jsonNode } from './data-transform.js';

const csv = csvNode.executor!;
const array = arrayNode.executor!;
const json = jsonNode.executor!;
const ctx = {} as never;

describe('action_csv', () => {
  it('parse con header → array di oggetti', async () => {
    const r = await csv({ operation: 'parse', text: 'nome,età\nAnna,30\nLuca,25' }, undefined, ctx);
    const o = r.output as { rows: Record<string, string>[]; headers: string[]; count: number };
    expect(o.count).toBe(2);
    expect(o.headers).toEqual(['nome', 'età']);
    expect(o.rows[0]).toEqual({ nome: 'Anna', età: '30' });
  });
  it('parse gestisce virgolette, delimitatore interno e newline dentro campo', async () => {
    const text = 'desc,prezzo\n"Mela, rossa",1.50\n"Riga\ncon a-capo",2';
    const r = await csv({ operation: 'parse', text }, undefined, ctx);
    const o = r.output as { rows: Record<string, string>[] };
    expect(o.rows[0]!.desc).toBe('Mela, rossa');
    expect(o.rows[1]!.desc).toBe('Riga\ncon a-capo');
  });
  it('parse gestisce virgolette escapate ("")', async () => {
    const r = await csv({ operation: 'parse', text: 'q\n"dice ""ciao"""' }, undefined, ctx);
    expect((r.output as { rows: { q: string }[] }).rows[0]!.q).toBe('dice "ciao"');
  });
  it('parse delimitatore punto e virgola (Excel IT)', async () => {
    const r = await csv({ operation: 'parse', text: 'a;b\n1;2', delimiter: ';' }, undefined, ctx);
    expect((r.output as { rows: Record<string, string>[] }).rows[0]).toEqual({ a: '1', b: '2' });
  });
  it("stringify deduce header dall'unione delle chiavi e quota quando serve", async () => {
    const items = [
      { a: '1', b: 'x,y' },
      { a: '2', c: '3' },
    ];
    const r = await csv({ operation: 'stringify', items: JSON.stringify(items) }, undefined, ctx);
    const out = (r.output as { csv: string }).csv;
    expect(out.split('\n')[0]).toBe('a,b,c');
    expect(out).toContain('"x,y"');
    expect(out).toContain('2,,3'); // b mancante → cella vuota
  });
  it('round-trip parse→stringify preserva i dati', async () => {
    const original = 'nome,note\nAnna,"a, b"\nLuca,semplice';
    const parsed = (await csv({ operation: 'parse', text: original }, undefined, ctx)).output as {
      rows: unknown[];
    };
    const back = (
      await csv({ operation: 'stringify', items: JSON.stringify(parsed.rows) }, undefined, ctx)
    ).output as { csv: string };
    expect(back.csv).toBe(original);
  });
  it.each(['=HYPERLINK("http://evil")', '+1+1', '-cmd', '@SUM(A1)'])(
    '🚨 SECURITY: cella stringa formula "%s" → neutralizzata con apex (CWE-1236)',
    async (payload) => {
      // MUTATION: senza il prefisso apex, la formula resterebbe attiva in Excel → rosso.
      const r = await csv(
        { operation: 'stringify', items: JSON.stringify([{ f: payload }]) },
        undefined,
        ctx,
      );
      const out = (r.output as { csv: string }).csv;
      const dataLine = out.split('\n')[1]!;
      expect(dataLine.replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    },
  );
  it('🚨 i NUMERI negativi NON vengono neutralizzati (resta "-5", non "\'-5")', async () => {
    const r = await csv(
      { operation: 'stringify', items: JSON.stringify([{ n: -5 }]) },
      undefined,
      ctx,
    );
    const out = (r.output as { csv: string }).csv;
    expect(out.split('\n')[1]).toBe('-5');
  });
});

describe('action_json — prototype pollution (CWE-1321)', () => {
  it('set con path __proto__.x NON contamina Object.prototype', async () => {
    await json(
      { operation: 'set', path: '__proto__.polluted', value: '"yes"', source: '{}' },
      undefined,
      ctx,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    delete (Object.prototype as Record<string, unknown>).polluted;
  });
  it('merge con {"__proto__":{...}} NON contamina Object.prototype', async () => {
    // MUTATION: senza il guard, deepMerge propagherebbe __proto__ → rosso.
    await json(
      { operation: 'merge', source: '{"a":1}', value: '{"__proto__":{"polluted":"yes"}}' },
      undefined,
      ctx,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    delete (Object.prototype as Record<string, unknown>).polluted;
  });
});

describe('action_array', () => {
  const people = [
    { id: 1, name: 'Anna', city: 'Roma' },
    { id: 2, name: 'Luca', city: 'Milano' },
    { id: 3, name: 'Anna', city: 'Roma' },
  ];
  it('unique by key deduplica', async () => {
    const r = await array(
      { operation: 'unique', key: 'name', items: JSON.stringify(people) },
      undefined,
      ctx,
    );
    expect((r.output as { count: number }).count).toBe(2);
  });
  it('sort numeric-aware desc', async () => {
    const r = await array(
      { operation: 'sort', key: 'id', direction: 'desc', items: JSON.stringify(people) },
      undefined,
      ctx,
    );
    const res = (r.output as { result: { id: number }[] }).result;
    expect(res.map((p) => p.id)).toEqual([3, 2, 1]);
  });
  it('sort stringhe è numeric-aware (10 dopo 9)', async () => {
    const r = await array(
      { operation: 'sort', items: JSON.stringify(['item9', 'item10', 'item2']) },
      undefined,
      ctx,
    );
    expect((r.output as { result: string[] }).result).toEqual(['item2', 'item9', 'item10']);
  });
  it('group per campo → { valore: [items] }', async () => {
    const r = await array(
      { operation: 'group', key: 'city', items: JSON.stringify(people) },
      undefined,
      ctx,
    );
    const g = (r.output as { result: Record<string, unknown[]> }).result;
    expect(g.Roma).toHaveLength(2);
    expect(g.Milano).toHaveLength(1);
  });
  it('chunk spezza in blocchi', async () => {
    const r = await array(
      { operation: 'chunk', size: '2', items: JSON.stringify([1, 2, 3, 4, 5]) },
      undefined,
      ctx,
    );
    expect((r.output as { result: number[][] }).result).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('flatten profondità 1', async () => {
    const r = await array(
      {
        operation: 'flatten',
        items: JSON.stringify([
          [1, 2],
          [3, [4]],
        ]),
      },
      undefined,
      ctx,
    );
    expect((r.output as { result: unknown[] }).result).toEqual([1, 2, 3, [4]]);
  });
  it('pick proietta i campi dot-path', async () => {
    const r = await array(
      { operation: 'pick', fields: 'name', items: JSON.stringify(people) },
      undefined,
      ctx,
    );
    expect((r.output as { result: Record<string, unknown>[] }).result[0]).toEqual({ name: 'Anna' });
  });
  it('slice con indici negativi (ultimi N)', async () => {
    const r = await array(
      { operation: 'slice', start: '-2', items: JSON.stringify([1, 2, 3, 4]) },
      undefined,
      ctx,
    );
    expect((r.output as { result: number[] }).result).toEqual([3, 4]);
  });
  it('input come array nativo (non stringa)', async () => {
    const r = await array({ operation: 'reverse' }, [1, 2, 3], ctx);
    expect((r.output as { result: number[] }).result).toEqual([3, 2, 1]);
  });
  it('operazione sconosciuta → throw', async () => {
    await expect(array({ operation: 'nope' }, [], ctx)).rejects.toThrow(/sconosciuta/);
  });
});

describe('action_json', () => {
  const obj = { data: { user: { email: 'a@b.it', name: 'Anna' }, role: 'admin' }, token: 'secret' };
  it('get dot-path annidato', async () => {
    const r = await json(
      { operation: 'get', path: 'data.user.email', source: JSON.stringify(obj) },
      undefined,
      ctx,
    );
    expect((r.output as { result: unknown }).result).toBe('a@b.it');
  });
  it('get percorso inesistente → undefined (no crash)', async () => {
    const r = await json(
      { operation: 'get', path: 'data.x.y.z', source: JSON.stringify(obj) },
      undefined,
      ctx,
    );
    expect((r.output as { result: unknown }).result).toBeUndefined();
  });
  it('set è immutabile e crea gli intermedi', async () => {
    const base = { a: 1 };
    const r = await json(
      { operation: 'set', path: 'b.c', value: '42', source: JSON.stringify(base) },
      undefined,
      ctx,
    );
    const res = (r.output as { result: Record<string, unknown> }).result;
    expect(res).toEqual({ a: 1, b: { c: 42 } });
    expect(base).toEqual({ a: 1 }); // originale non mutato
  });
  it('omit rimuove i campi sensibili', async () => {
    const r = await json(
      { operation: 'omit', paths: 'token', source: JSON.stringify(obj) },
      undefined,
      ctx,
    );
    expect((r.output as { result: Record<string, unknown> }).result).not.toHaveProperty('token');
  });
  it('pick whitelist', async () => {
    const r = await json(
      { operation: 'pick', paths: 'data.role, token', source: JSON.stringify(obj) },
      undefined,
      ctx,
    );
    expect((r.output as { result: Record<string, unknown> }).result).toEqual({
      role: 'admin',
      token: 'secret',
    });
  });
  it('merge in profondità', async () => {
    const r = await json(
      {
        operation: 'merge',
        value: '{"data":{"role":"user"},"extra":1}',
        source: JSON.stringify(obj),
      },
      undefined,
      ctx,
    );
    const res = (r.output as { result: { data: { role: string; user: unknown }; extra: number } })
      .result;
    expect(res.data.role).toBe('user'); // sovrascritto
    expect(res.data.user).toBeDefined(); // preservato (merge profondo)
    expect(res.extra).toBe(1);
  });
  it('merge con JSON non valido → throw', async () => {
    await expect(
      json({ operation: 'merge', value: '{bad', source: '{}' }, undefined, ctx),
    ).rejects.toThrow(/JSON/);
  });
  it('flatten oggetto annidato → chiavi dot', async () => {
    const r = await json(
      { operation: 'flatten', source: JSON.stringify({ a: { b: { c: 1 } }, d: 2 }) },
      undefined,
      ctx,
    );
    expect((r.output as { result: Record<string, unknown> }).result).toEqual({ 'a.b.c': 1, d: 2 });
  });
  it('keys di primo livello', async () => {
    const r = await json(
      { operation: 'keys', source: JSON.stringify({ x: 1, y: 2 }) },
      undefined,
      ctx,
    );
    expect((r.output as { result: string[] }).result).toEqual(['x', 'y']);
  });
  it('source come oggetto nativo', async () => {
    const r = await json({ operation: 'get', path: 'name' }, { name: 'diretto' }, ctx);
    expect((r.output as { result: unknown }).result).toBe('diretto');
  });
});

// ════════════════════════════════════════════════════════════════════════
// GAP #2 (paired items) — action_array dichiara il lineage per le operazioni
// che SCARTANO/RIORDINANO. I test pretendono gli INDICI ORIGINALI esatti:
// un mapping ricalcolato posizionalmente (0,1,2,…) li fa fallire.
// ════════════════════════════════════════════════════════════════════════
describe('🚨 action_array — dichiarazione lineage (GAP #2)', () => {
  type Declared = { json: Record<string, unknown>; pairedItem?: unknown }[];

  it('sort: result riordinato + pairedItem con gli indici ORIGINALI (non posizionali)', async () => {
    const input = [{ v: 3 }, { v: 1 }, { v: 2 }];
    const r = await array({ operation: 'sort', key: 'v', direction: 'asc' }, input, ctx);
    expect((r.output as { result: unknown[] }).result).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
    const items = r.items as Declared;
    expect(items.map((it) => it.pairedItem)).toEqual([{ item: 1 }, { item: 2 }, { item: 0 }]);
  });

  it('unique: i duplicati scartati NON slittano gli indici dei sopravvissuti', async () => {
    const r = await array({ operation: 'unique' }, ['a', 'b', 'a', 'c'], ctx);
    expect((r.output as { result: unknown[] }).result).toEqual(['a', 'b', 'c']);
    const items = r.items as Declared;
    expect(items.map((it) => it.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 3 }]);
  });

  it('slice: offset preservato (anche con indici negativi, semantica JS identica)', async () => {
    const input = ['x0', 'x1', 'x2', 'x3'];
    const r1 = await array({ operation: 'slice', start: '1', end: '3' }, input, ctx);
    expect((r1.items as Declared).map((it) => it.pairedItem)).toEqual([{ item: 1 }, { item: 2 }]);
    const r2 = await array({ operation: 'slice', start: '-2' }, input, ctx);
    expect((r2.output as { result: unknown[] }).result).toEqual(['x2', 'x3']);
    expect((r2.items as Declared).map((it) => it.pairedItem)).toEqual([{ item: 2 }, { item: 3 }]);
  });

  it('reverse: mapping speculare N-1-i', async () => {
    const r = await array({ operation: 'reverse' }, ['a', 'b', 'c'], ctx);
    expect((r.items as Declared).map((it) => it.pairedItem)).toEqual([
      { item: 2 },
      { item: 1 },
      { item: 0 },
    ]);
  });

  it('chunk: ogni chunk deriva fromMany dai SUOI indici originali', async () => {
    const r = await array({ operation: 'chunk', size: '2' }, ['a', 'b', 'c', 'd', 'e'], ctx);
    const items = r.items as Declared;
    expect(items.map((it) => it.pairedItem)).toEqual([
      [{ item: 0 }, { item: 1 }],
      [{ item: 2 }, { item: 3 }],
      [{ item: 4 }],
    ]);
    expect(items[0]?.json).toEqual({ value: ['a', 'b'] });
  });

  it('🚨 config.items (espressione) → NESSUNA dichiarazione (indici non riferiti alla sorgente)', async () => {
    const r = await array({ operation: 'sort', items: [{ v: 2 }, { v: 1 }] }, [{ v: 9 }], ctx);
    expect(r.items).toBeUndefined();
  });

  it('🚨 input stringa JSON → NESSUNA dichiarazione, output intatto', async () => {
    const r = await array({ operation: 'reverse' }, JSON.stringify(['a', 'b']), ctx);
    expect(r.items).toBeUndefined();
    expect((r.output as { result: unknown[] }).result).toEqual(['b', 'a']);
  });

  it('pairedItem trascinato dagli item di input → SOVRASCRITTO (autorità sul proprio mapping)', async () => {
    const input = [
      { json: { v: 2 }, pairedItem: { item: 999 } },
      { json: { v: 1 }, pairedItem: { item: 888 } },
    ];
    const r = await array({ operation: 'sort', key: 'json.v', direction: 'asc' }, input, ctx);
    expect((r.items as Declared).map((it) => it.pairedItem)).toEqual([{ item: 1 }, { item: 0 }]);
  });

  it('contratto storico output invariato: { result, count, operation }', async () => {
    const r = await array({ operation: 'sort' }, ['b', 'a'], ctx);
    expect(r.output).toEqual({ result: ['a', 'b'], count: 2, operation: 'sort' });
  });
});
