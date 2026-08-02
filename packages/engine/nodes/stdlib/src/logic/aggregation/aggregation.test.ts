import { describe, it, expect } from 'vitest';
import { groupByNode } from './group-by.js';
import { aggregateNode } from './aggregate.js';
import { distinctNode } from './distinct.js';
import { windowNode } from './window.js';
import {
  normalizeItems,
  getField,
  toNumber,
  toNumberOrNull,
  capItems,
  resolveMaxItems,
  DEFAULT_MAX_ITEMS,
  HARD_MAX_ITEMS,
} from './helpers.js';

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;

describe('helpers', () => {
  describe('normalizeItems', () => {
    it('passa array direttamente', () => {
      expect(normalizeItems([1, 2, 3])).toEqual([1, 2, 3]);
    });
    it('estrae .records da oggetto', () => {
      expect(normalizeItems({ records: ['a', 'b'] })).toEqual(['a', 'b']);
    });
    it('null/undefined/primitives → []', () => {
      expect(normalizeItems(null)).toEqual([]);
      expect(normalizeItems(undefined)).toEqual([]);
      expect(normalizeItems(42)).toEqual([]);
      expect(normalizeItems('str')).toEqual([]);
    });
    it('oggetto senza .records → []', () => {
      expect(normalizeItems({ foo: 'bar' })).toEqual([]);
    });
  });

  describe('getField', () => {
    it('estrae campo da oggetto', () => {
      expect(getField({ a: 1 }, 'a')).toBe(1);
    });
    it('field vuoto → ritorna item', () => {
      expect(getField({ a: 1 }, '')).toEqual({ a: 1 });
    });
    it('primitive → ritorna item (gracef)', () => {
      expect(getField(42, 'a')).toBe(42);
    });
  });

  describe('toNumber', () => {
    it('numero finito → se stesso', () => {
      expect(toNumber(42)).toBe(42);
      expect(toNumber(0)).toBe(0);
      expect(toNumber(-3.14)).toBe(-3.14);
    });
    it('string numerica → coerced', () => {
      expect(toNumber('42')).toBe(42);
    });
    it('non-numeric → 0', () => {
      expect(toNumber('abc')).toBe(0);
      expect(toNumber(NaN)).toBe(0);
      expect(toNumber(null)).toBe(0);
    });
  });
});

describe('groupByNode', () => {
  const exec = groupByNode.executor!;

  // 🚨 La group-key è attacker-controlled. Con `{}` una key `__proto__` faceva `.push`
  // sull'accessor di Object.prototype → TypeError (crash deterministico). Object.create(null) lo chiude.
  it('🚨 group-key "__proto__"/"constructor" → NESSUN crash, raggruppata come chiave normale', async () => {
    const items = [
      { id: 1, k: '__proto__' },
      { id: 2, k: '__proto__' },
      { id: 3, k: 'constructor' },
      { id: 4, k: 'normal' },
    ];
    const r = await exec({ groupKey: 'k' }, items, ctx);
    const out = r.output as { groups: Record<string, unknown[]>; groupCount: number };
    expect(out.groupCount).toBe(3);
    expect(out.groups.__proto__).toHaveLength(2);
    expect(out.groups.constructor).toHaveLength(1);
    // Object.prototype NON inquinato.
    expect(({} as Record<string, unknown>).id).toBeUndefined();
  });

  it('raggruppa per campo', async () => {
    const items = [
      { id: 1, customer: 'A' },
      { id: 2, customer: 'B' },
      { id: 3, customer: 'A' },
    ];
    const r = await exec({ groupKey: 'customer' }, items, ctx);
    const out = r.output as {
      groups: Record<string, unknown[]>;
      groupCount: number;
      totalItems: number;
    };
    expect(out.groupCount).toBe(2);
    expect(out.totalItems).toBe(3);
    expect(out.groups.A).toHaveLength(2);
    expect(out.groups.B).toHaveLength(1);
  });

  it('item con campo missing finisce in __missing__', async () => {
    const r = await exec({ groupKey: 'customer' }, [{ id: 1 }, { id: 2, customer: 'A' }], ctx);
    const out = r.output as { groups: Record<string, unknown[]> };
    expect(out.groups.__missing__).toHaveLength(1);
    expect(out.groups.A).toHaveLength(1);
  });

  it('accetta input .records (auto-normalize)', async () => {
    const r = await exec({ groupKey: 'k' }, { records: [{ k: 1 }, { k: 2 }] }, ctx);
    const out = r.output as { groupCount: number };
    expect(out.groupCount).toBe(2);
  });

  it('input non-array → 0 groups', async () => {
    const r = await exec({ groupKey: 'x' }, null, ctx);
    const out = r.output as { groupCount: number };
    expect(out.groupCount).toBe(0);
  });
});

describe('aggregateNode', () => {
  const exec = aggregateNode.executor!;

  it('🚨 groupBy field con valore "__proto__" → NESSUN crash (Object.create(null))', async () => {
    const r = await exec(
      { reducer: 'sum', field: 'amount', groupBy: 'k' },
      [
        { k: '__proto__', amount: 10 },
        { k: '__proto__', amount: 5 },
        { k: 'normal', amount: 1 },
      ],
      ctx,
    );
    const out = r.output as { reduced: Record<string, unknown>; groupCount: number };
    expect(out.groupCount).toBe(2);
    expect(out.reduced.__proto__).toBe(15);
    expect(({} as Record<string, unknown>).amount).toBeUndefined();
  });

  it('count senza group-by', async () => {
    const r = await exec({ reducer: 'count' }, [1, 2, 3], ctx);
    expect((r.output as { value: number }).value).toBe(3);
  });

  it('sum su field', async () => {
    const r = await exec(
      { reducer: 'sum', field: 'amount' },
      [{ amount: 10 }, { amount: 20 }, { amount: 30 }],
      ctx,
    );
    expect((r.output as { value: number }).value).toBe(60);
  });

  it('🚨 [REGRESSION] min/max su 200k item NON crasha (no spread-args RangeError)', async () => {
    // Sul codice vecchio `Math.max(...arr.map())` lo spread di 200k argomenti supera lo
    // stack → RangeError "Maximum call stack size". reduce single-pass regge qualsiasi size.
    // maxItems alzato a 200k: il cap difensivo (default 100k) è configurabile per carichi
    // legittimi grandi → processa l'intero array, NESSUN troncamento, nessun crash.
    const big = Array.from({ length: 200_000 }, (_, i) => ({ v: i }));
    const rMax = await exec({ reducer: 'max', field: 'v', maxItems: 200_000 }, big, ctx);
    expect((rMax.output as { value: number }).value).toBe(199_999);
    expect(rMax.warnings).toBeUndefined();
    const rMin = await exec({ reducer: 'min', field: 'v', maxItems: 200_000 }, big, ctx);
    expect((rMin.output as { value: number }).value).toBe(0);
  });

  it('min/max corretti (caso base + tutti negativi)', async () => {
    const data = [{ v: -5 }, { v: -1 }, { v: -9 }];
    expect(
      ((await exec({ reducer: 'min', field: 'v' }, data, ctx)).output as { value: number }).value,
    ).toBe(-9);
    expect(
      ((await exec({ reducer: 'max', field: 'v' }, data, ctx)).output as { value: number }).value,
    ).toBe(-1);
  });

  it('avg corretto', async () => {
    const r = await exec({ reducer: 'avg', field: 'v' }, [{ v: 10 }, { v: 20 }, { v: 30 }], ctx);
    expect((r.output as { value: number }).value).toBe(20);
  });

  it('avg su array vuoto → 0 (no divide by zero)', async () => {
    const r = await exec({ reducer: 'avg', field: 'v' }, [], ctx);
    expect((r.output as { value: number }).value).toBe(0);
  });

  it('min/max', async () => {
    const items = [{ v: 5 }, { v: 1 }, { v: 9 }];
    expect(
      ((await exec({ reducer: 'min', field: 'v' }, items, ctx)).output as { value: number }).value,
    ).toBe(1);
    expect(
      ((await exec({ reducer: 'max', field: 'v' }, items, ctx)).output as { value: number }).value,
    ).toBe(9);
  });

  it('concat join CSV', async () => {
    const r = await exec(
      { reducer: 'concat', field: 'name' },
      [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }],
      ctx,
    );
    expect((r.output as { value: string }).value).toBe('alice,bob,carol');
  });

  it('group-by + sum per gruppo', async () => {
    const r = await exec(
      { reducer: 'sum', field: 'amount', groupBy: 'customer' },
      [
        { customer: 'A', amount: 10 },
        { customer: 'B', amount: 20 },
        { customer: 'A', amount: 5 },
      ],
      ctx,
    );
    const out = r.output as { reduced: Record<string, number>; groupCount: number };
    expect(out.reduced.A).toBe(15);
    expect(out.reduced.B).toBe(20);
    expect(out.groupCount).toBe(2);
  });

  it('reducer sconosciuto → fallback count', async () => {
    const r = await exec({ reducer: 'unknown' }, [1, 2, 3], ctx);
    expect((r.output as { value: number }).value).toBe(3);
  });
});

describe('distinctNode', () => {
  const exec = distinctNode.executor!;

  it('dedup intero item (no field)', async () => {
    const r = await exec({}, [1, 2, 1, 3, 2], ctx);
    const out = r.output as { items: number[]; distinct: number; removed: number };
    expect(out.items).toEqual([1, 2, 3]);
    expect(out.distinct).toBe(3);
    expect(out.removed).toBe(2);
  });

  it('dedup per campo (preserva primo match)', async () => {
    const r = await exec(
      { field: 'email' },
      [
        { email: 'a@x', name: 'first' },
        { email: 'b@x', name: 'other' },
        { email: 'a@x', name: 'second' },
      ],
      ctx,
    );
    const out = r.output as { items: { name: string }[]; distinct: number };
    expect(out.distinct).toBe(2);
    expect(out.items[0]?.name).toBe('first');
  });

  it('array vuoto → distinct 0', async () => {
    const r = await exec({}, [], ctx);
    expect((r.output as { distinct: number }).distinct).toBe(0);
  });
});

describe('windowNode', () => {
  const exec = windowNode.executor!;

  it('raggruppa per finestra oraria (default 3600s)', async () => {
    const items = [
      { ts: '2026-05-20T12:30:00Z', v: 'a' },
      { ts: '2026-05-20T12:45:00Z', v: 'b' },
      { ts: '2026-05-20T13:05:00Z', v: 'c' },
    ];
    const r = await exec({ timestampField: 'ts', windowSeconds: 3600 }, items, ctx);
    const out = r.output as { windows: Record<string, unknown[]>; windowCount: number };
    expect(out.windowCount).toBe(2);
    expect(out.windows['2026-05-20T12:00:00.000Z']).toHaveLength(2);
    expect(out.windows['2026-05-20T13:00:00.000Z']).toHaveLength(1);
  });

  it('finestra 1 minuto', async () => {
    const items = [
      { ts: '2026-05-20T12:30:10Z' },
      { ts: '2026-05-20T12:30:50Z' },
      { ts: '2026-05-20T12:31:05Z' },
    ];
    const r = await exec({ timestampField: 'ts', windowSeconds: 60 }, items, ctx);
    expect((r.output as { windowCount: number }).windowCount).toBe(2);
  });

  it('timestamp Unix epoch ms', async () => {
    const ts = Date.UTC(2026, 4, 20, 12, 30, 0);
    const r = await exec({ timestampField: 'ts', windowSeconds: 3600 }, [{ ts }], ctx);
    expect((r.output as { windowCount: number }).windowCount).toBe(1);
  });

  it('🚨 timestamp invalido → tracciato in undated (NON perso in silenzio)', async () => {
    const r = await exec(
      { timestampField: 'ts', windowSeconds: 3600 },
      [{ ts: 'not a date' }, { ts: '2026-05-20T12:00:00Z' }],
      ctx,
    );
    const out = r.output as {
      totalItems: number;
      windowCount: number;
      undated: unknown[];
      undatedCount: number;
    };
    expect(out.totalItems).toBe(2);
    expect(out.windowCount).toBe(1); // solo la finestra temporale valida
    // MUTATION: il vecchio comportamento scartava l'item invalido → undated sarebbe [].
    expect(out.undatedCount).toBe(1);
    expect(out.undated).toEqual([{ ts: 'not a date' }]);
  });

  describe('🔬 granularità di CALENDARIO timezone-aware', () => {
    it('default = fixed: comportamento UTC invariato (non-regressione) + windowSizeSec presente', async () => {
      const r = await exec(
        { timestampField: 'ts', windowSeconds: 3600 },
        [{ ts: '2026-05-20T12:30:00Z' }, { ts: '2026-05-20T12:45:00Z' }],
        ctx,
      );
      const out = r.output as {
        windows: Record<string, unknown[]>;
        windowSizeSec: number;
        granularity: string;
      };
      expect(out.granularity).toBe('fixed');
      expect(out.windowSizeSec).toBe(3600);
      expect(out.windows['2026-05-20T12:00:00.000Z']).toHaveLength(2);
    });

    it('🚨 granularity=day timezone Europe/Rome: bucket alla mezzanotte LOCALE', async () => {
      const r = await exec(
        { timestampField: 'ts', granularity: 'day', timezone: 'Europe/Rome' },
        [
          { ts: '2026-05-19T23:30:00Z' }, // 01:30 locale 20/5
          { ts: '2026-05-20T20:00:00Z' }, // 22:00 locale 20/5  → STESSO giorno locale
          { ts: '2026-05-20T22:30:00Z' }, // 00:30 locale 21/5  → giorno DOPO
        ],
        ctx,
      );
      const out = r.output as {
        windows: Record<string, unknown[]>;
        windowCount: number;
        timezone: string;
      };
      expect(out.timezone).toBe('Europe/Rome');
      expect(out.windowCount).toBe(2);
      expect(out.windows['2026-05-19T22:00:00.000Z']).toHaveLength(2); // i primi due
      expect(out.windows['2026-05-20T22:00:00.000Z']).toHaveLength(1); // il terzo
    });

    it('granularity=month raggruppa per mese di calendario', async () => {
      const r = await exec(
        { timestampField: 'ts', granularity: 'month', timezone: 'UTC' },
        [
          { ts: '2026-05-02T00:00:00Z' },
          { ts: '2026-05-30T23:00:00Z' },
          { ts: '2026-06-01T00:00:00Z' },
        ],
        ctx,
      );
      const out = r.output as { windowCount: number; windows: Record<string, unknown[]> };
      expect(out.windowCount).toBe(2);
      expect(out.windows['2026-05-01T00:00:00.000Z']).toHaveLength(2);
    });

    it('timezone non valida → fail-soft su UTC (no throw)', async () => {
      const r = await exec(
        { timestampField: 'ts', granularity: 'day', timezone: 'Bogus/Zone' },
        [{ ts: '2026-05-20T12:00:00Z' }],
        ctx,
      );
      const out = r.output as { timezone: string; windows: Record<string, unknown[]> };
      expect(out.timezone).toBe('UTC');
      expect(out.windows['2026-05-20T00:00:00.000Z']).toHaveLength(1);
    });
  });
});

describe('🛡️ cap difensivo anti-OOM (maxItems)', () => {
  describe('resolveMaxItems', () => {
    it('assente/vuoto/invalido → default 100k', () => {
      expect(resolveMaxItems(undefined)).toBe(DEFAULT_MAX_ITEMS);
      expect(resolveMaxItems(null)).toBe(DEFAULT_MAX_ITEMS);
      expect(resolveMaxItems('')).toBe(DEFAULT_MAX_ITEMS);
      expect(resolveMaxItems('abc')).toBe(DEFAULT_MAX_ITEMS);
      expect(resolveMaxItems(0)).toBe(DEFAULT_MAX_ITEMS);
      expect(resolveMaxItems(-5)).toBe(DEFAULT_MAX_ITEMS);
      expect(resolveMaxItems(NaN)).toBe(DEFAULT_MAX_ITEMS);
    });
    it('valore valido → usato; oltre il tetto → clamp a HARD_MAX_ITEMS', () => {
      expect(resolveMaxItems(50)).toBe(50);
      expect(resolveMaxItems('250')).toBe(250);
      expect(resolveMaxItems(2_000_000)).toBe(HARD_MAX_ITEMS);
      expect(resolveMaxItems(3.9)).toBe(3); // floor
    });
  });

  describe('capItems', () => {
    it('sotto soglia → nessun troncamento, nessun warning', () => {
      const r = capItems([1, 2], 5);
      expect(r).toEqual({ items: [1, 2], total: 2, truncated: false });
      expect(r.warning).toBeUndefined();
    });
    it('🚨 sopra soglia → tronca + warning con conteggi reali', () => {
      const r = capItems([1, 2, 3, 4, 5], 3);
      expect(r.items).toEqual([1, 2, 3]);
      expect(r.total).toBe(5);
      expect(r.truncated).toBe(true);
      expect(r.warning).toMatch(/3.*5|troncato/);
      expect(r.warning).toContain('3');
      expect(r.warning).toContain('5');
    });
    it('boundary: total === max → NON tronca', () => {
      expect(capItems([1, 2, 3], 3).truncated).toBe(false);
    });
    it('normalizza .records PRIMA di cappare', () => {
      const r = capItems({ records: [1, 2, 3, 4] }, 2);
      expect(r.items).toEqual([1, 2]);
      expect(r.total).toBe(4);
      expect(r.truncated).toBe(true);
    });
  });

  // Integrazione per-nodo: mutation-verify → senza cap il conteggio sarebbe 5.
  it('🚨 aggregate: count su 5 item con maxItems=3 → value=3 + warning', async () => {
    const r = await aggregateNode.executor!(
      { reducer: 'count', maxItems: 3 },
      [1, 2, 3, 4, 5],
      ctx,
    );
    expect((r.output as { value: number }).value).toBe(3);
    expect(r.warnings?.[0]).toMatch(/troncato/i);
  });

  it('🚨 group_by: 5 item maxItems=2 → totalItems=2 + warning', async () => {
    const r = await groupByNode.executor!(
      { groupKey: 'k', maxItems: 2 },
      [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }, { k: 'e' }],
      ctx,
    );
    expect((r.output as { totalItems: number }).totalItems).toBe(2);
    expect(r.warnings).toHaveLength(1);
  });

  it('🚨 distinct: 5 item maxItems=3 → original=3 + warning', async () => {
    const r = await distinctNode.executor!({ maxItems: 3 }, [1, 2, 3, 4, 5], ctx);
    expect((r.output as { original: number }).original).toBe(3);
    expect(r.warnings).toHaveLength(1);
  });

  it('🚨 window: 5 item maxItems=2 → totalItems=2 + warning', async () => {
    const r = await windowNode.executor!(
      { timestampField: 'ts', windowSeconds: 3600, maxItems: 2 },
      [
        { ts: '2026-05-20T12:00:00Z' },
        { ts: '2026-05-20T12:10:00Z' },
        { ts: '2026-05-20T12:20:00Z' },
        { ts: '2026-05-20T12:30:00Z' },
        { ts: '2026-05-20T12:40:00Z' },
      ],
      ctx,
    );
    expect((r.output as { totalItems: number }).totalItems).toBe(2);
    expect(r.warnings).toHaveLength(1);
  });

  it('default (no maxItems) → nessun warning su input piccolo (non-regressione)', async () => {
    const r = await aggregateNode.executor!({ reducer: 'count' }, [1, 2, 3], ctx);
    expect((r.output as { value: number }).value).toBe(3);
    expect(r.warnings).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review "opera d'arte" — bug di correttezza chiusi (con mutation-verify esplicito)
// ─────────────────────────────────────────────────────────────────────────────

describe('🔬 getField — path ANNIDATO (dot + bracket)', () => {
  it('dot-path: "user.country"', () => {
    expect(getField({ user: { country: 'IT' } }, 'user.country')).toBe('IT');
  });
  it('bracket-index: "items[0].name" e "items[1]"', () => {
    expect(getField({ items: [{ name: 'a' }, { name: 'b' }] }, 'items[0].name')).toBe('a');
    expect(getField({ items: ['x', 'y'] }, 'items[1]')).toBe('y');
  });
  it('🚨 MUTATION: senza nested-resolution "user.country" sarebbe undefined', () => {
    // Sul codice flat vecchio (item[field]) non esiste la chiave letterale "user.country".
    expect(getField({ user: { country: 'IT' } }, 'user.country')).not.toBeUndefined();
  });
  it('back-compat: una chiave reale che CONTIENE un punto vince sul nested', () => {
    expect(getField({ 'v1.2': 5, v1: { 2: 999 } }, 'v1.2')).toBe(5);
  });
  it('🛡️ NON segue __proto__/constructor/prototype nel path (no prototype-chain escape)', () => {
    expect(getField({ a: { b: 1 } }, 'a.__proto__')).toBeUndefined();
    expect(getField({ a: { b: 1 } }, 'a.constructor.name')).toBeUndefined();
  });
  it('path che sfonda un non-oggetto → undefined (no throw)', () => {
    expect(getField({ a: 5 }, 'a.b.c')).toBeUndefined();
  });
});

describe('🔬 toNumberOrNull — distinzione non-numerico + locale IT', () => {
  it('numeri/bool validi', () => {
    expect(toNumberOrNull(42)).toBe(42);
    expect(toNumberOrNull(true)).toBe(1);
    expect(toNumberOrNull(false)).toBe(0);
  });
  it('non-numerico → null (NON 0): è ciò che permette lo skip reale', () => {
    expect(toNumberOrNull('abc')).toBeNull();
    expect(toNumberOrNull('')).toBeNull();
    expect(toNumberOrNull('   ')).toBeNull();
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(NaN)).toBeNull();
    expect(toNumberOrNull(Infinity)).toBeNull();
    expect(toNumberOrNull({})).toBeNull();
  });
  it('locale italiano: virgola decimale + punti migliaia', () => {
    expect(toNumberOrNull('1.234,56')).toBe(1234.56);
    expect(toNumberOrNull('1.000.000,00')).toBe(1000000);
    expect(toNumberOrNull('3,5')).toBe(3.5);
  });
  it('senza virgola → parsing standard EN (no ambiguità su "1.234")', () => {
    expect(toNumberOrNull('1234.56')).toBe(1234.56);
    expect(toNumberOrNull('42')).toBe(42);
  });
  it('toNumber legacy resta 0 sui non-numerici (non-regressione API)', () => {
    expect(toNumber('abc')).toBe(0);
    expect(toNumber('42')).toBe(42);
  });
});

describe('🔬 aggregate — skip dei valori NON-numerici', () => {
  const exec = aggregateNode.executor!;
  it('sum ignora i non-numerici e li conta in skippedNonNumeric', async () => {
    const r = await exec(
      { reducer: 'sum', field: 'a' },
      [{ a: 10 }, { a: 'x' }, { a: 20 }, { a: null }],
      ctx,
    );
    const out = r.output as {
      value: number;
      processedCount: number;
      skippedNonNumeric: number;
      inputCount: number;
    };
    expect(out.value).toBe(30);
    expect(out.processedCount).toBe(2);
    expect(out.skippedNonNumeric).toBe(2);
    expect(out.inputCount).toBe(4);
  });
  it('🚨 MUTATION: avg divide per i VALIDI, non per arr.length (gli 0 finti falsavano la media)', async () => {
    // [10, "x", 20]: media corretta = 15 (30/2). Il codice vecchio (toNumber→0) → 30/3 = 10.
    const r = await exec({ reducer: 'avg', field: 'v' }, [{ v: 10 }, { v: 'x' }, { v: 20 }], ctx);
    expect((r.output as { value: number }).value).toBe(15);
  });
  it('min/max ignorano i non-numerici (no -Infinity/+Infinity spurio)', async () => {
    const data = [{ v: 'na' }, { v: 5 }, { v: 'boh' }, { v: 2 }];
    expect(
      ((await exec({ reducer: 'min', field: 'v' }, data, ctx)).output as { value: number }).value,
    ).toBe(2);
    expect(
      ((await exec({ reducer: 'max', field: 'v' }, data, ctx)).output as { value: number }).value,
    ).toBe(5);
  });
  it('tutti non-numerici → value 0 (no NaN/Infinity in output)', async () => {
    const r = await exec({ reducer: 'avg', field: 'v' }, [{ v: 'a' }, { v: 'b' }], ctx);
    const out = r.output as { value: number; skippedNonNumeric: number };
    expect(out.value).toBe(0);
    expect(out.skippedNonNumeric).toBe(2);
  });
  it('importi in formato italiano sommati correttamente', async () => {
    const r = await exec(
      { reducer: 'sum', field: 'imponibile' },
      [{ imponibile: '1.234,56' }, { imponibile: '1.000,00' }],
      ctx,
    );
    expect((r.output as { value: number }).value).toBeCloseTo(2234.56, 2);
  });
});

describe('🔬 aggregate — reducer median + collect (erano descritti ma inesistenti)', () => {
  const exec = aggregateNode.executor!;
  it('median dispari → elemento centrale', async () => {
    const r = await exec(
      { reducer: 'median', field: 'v' },
      [{ v: 3 }, { v: 1 }, { v: 2 }, { v: 5 }, { v: 4 }],
      ctx,
    );
    expect((r.output as { value: number }).value).toBe(3);
  });
  it('median pari → media dei due centrali', async () => {
    const r = await exec(
      { reducer: 'median', field: 'v' },
      [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }],
      ctx,
    );
    expect((r.output as { value: number }).value).toBe(2.5);
  });
  it('median robusta agli outlier (vs avg)', async () => {
    const data = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 1000 }];
    const med = (await exec({ reducer: 'median', field: 'v' }, data, ctx)).output as {
      value: number;
    };
    const avg = (await exec({ reducer: 'avg', field: 'v' }, data, ctx)).output as { value: number };
    expect(med.value).toBe(2.5);
    expect(avg.value).toBe(251.5); // l'outlier 1000 trascina la media, non la mediana
  });
  it('collect → array dei valori del campo (preserva ordine e duplicati)', async () => {
    const r = await exec(
      { reducer: 'collect', field: 'email' },
      [{ email: 'a@x' }, { email: 'b@x' }, { email: 'a@x' }],
      ctx,
    );
    expect((r.output as { value: string[] }).value).toEqual(['a@x', 'b@x', 'a@x']);
  });
});

describe('🔬 group_by / aggregate — group-by su path ANNIDATO', () => {
  it('group_by per "user.country"', async () => {
    const r = await groupByNode.executor!(
      { groupKey: 'user.country' },
      [
        { id: 1, user: { country: 'IT' } },
        { id: 2, user: { country: 'ES' } },
        { id: 3, user: { country: 'IT' } },
      ],
      ctx,
    );
    const out = r.output as { groups: Record<string, unknown[]>; groupCount: number };
    expect(out.groupCount).toBe(2);
    expect(out.groups.IT).toHaveLength(2);
    expect(out.groups.ES).toHaveLength(1);
  });
  it('aggregate sum group-by "addr.region"', async () => {
    const r = await aggregateNode.executor!(
      { reducer: 'sum', field: 'amount', groupBy: 'addr.region' },
      [
        { addr: { region: 'Lazio' }, amount: 10 },
        { addr: { region: 'Lazio' }, amount: 5 },
        { addr: { region: 'Lombardia' }, amount: 20 },
      ],
      ctx,
    );
    const out = r.output as { reduced: Record<string, number> };
    expect(out.reduced.Lazio).toBe(15);
    expect(out.reduced.Lombardia).toBe(20);
  });
});

describe('🔬 distinct — equivalenza strutturale CANONICA', () => {
  const exec = distinctNode.executor!;
  it('🚨 MUTATION: {a:1,b:2} e {b:2,a:1} sono DUPLICATI (key-order irrilevante)', async () => {
    // Col JSON.stringify nativo le due stringhe differivano → non deduplicati (bug).
    const r = await exec(
      {},
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
        { a: 1, b: 3 },
      ],
      ctx,
    );
    const out = r.output as { items: unknown[]; distinct: number };
    expect(out.distinct).toBe(2);
    expect(out.items).toEqual([
      { a: 1, b: 2 },
      { a: 1, b: 3 },
    ]);
  });
  it('canonicalizzazione ricorsiva (oggetti annidati)', async () => {
    const r = await exec({}, [{ x: { p: 1, q: 2 } }, { x: { q: 2, p: 1 } }], ctx);
    expect((r.output as { distinct: number }).distinct).toBe(1);
  });
  it('dedup per campo nested ("user.email")', async () => {
    const r = await exec(
      { field: 'user.email' },
      [
        { user: { email: 'a@x' }, n: 1 },
        { user: { email: 'a@x' }, n: 2 },
        { user: { email: 'b@x' }, n: 3 },
      ],
      ctx,
    );
    expect((r.output as { distinct: number }).distinct).toBe(2);
  });
  it('🛡️ input con riferimento circolare → NON crasha (marcato [Circular])', async () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    const b: Record<string, unknown> = { id: 2 };
    b.self = b;
    const r = await exec({}, [a, b, a], ctx);
    // a e la sua ripetizione collassano; b è distinto → 2 unici, nessun throw.
    expect((r.output as { distinct: number }).distinct).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ondata 8c — gap costruiti: group_by counts/largest, distinct multi-key, avg precision
// ─────────────────────────────────────────────────────────────────────────────

describe('🔬 group_by — counts / largestGroup / smallestGroup / floatPrecision', () => {
  const exec = groupByNode.executor!;
  it('counts per gruppo + gruppo più grande/piccolo', async () => {
    const r = await exec(
      { groupKey: 'c' },
      [{ c: 'A' }, { c: 'A' }, { c: 'A' }, { c: 'B' }, { c: 'C' }, { c: 'C' }],
      ctx,
    );
    const out = r.output as {
      counts: Record<string, number>;
      largestGroup: string;
      smallestGroup: string;
    };
    expect(out.counts).toEqual({ A: 3, B: 1, C: 2 });
    expect(out.largestGroup).toBe('A');
    expect(out.smallestGroup).toBe('B');
  });
  it('🚨 floatPrecision: 0.1+0.2 e 0.3 finiscono nello STESSO bucket', async () => {
    const r = await exec({ groupKey: 'k' }, [{ k: 0.1 + 0.2 }, { k: 0.3 }], ctx);
    expect((r.output as { groupCount: number }).groupCount).toBe(1);
  });
  it('interi NON sono toccati dalla normalizzazione float', async () => {
    const r = await exec({ groupKey: 'k' }, [{ k: 1 }, { k: 2 }, { k: 1 }], ctx);
    const out = r.output as { groups: Record<string, unknown[]> };
    expect(Object.keys(out.groups).sort()).toEqual(['1', '2']);
  });
});

describe('🔬 distinct — multi-key / normalize / removalPercent / exampleDuplicates', () => {
  const exec = distinctNode.executor!;
  it('🚨 dedup composta su più campi "vat,country"', async () => {
    const r = await exec(
      { field: 'vat,country' },
      [
        { vat: '1', country: 'IT', n: 1 },
        { vat: '1', country: 'ES', n: 2 },
        { vat: '1', country: 'IT', n: 3 },
      ],
      ctx,
    );
    const out = r.output as { distinct: number; items: { n: number }[] };
    expect(out.distinct).toBe(2);
    expect(out.items.map((i) => i.n)).toEqual([1, 2]);
  });
  it('🚨 normalize: email case/space-insensitive', async () => {
    const r = await exec(
      { field: 'email', normalize: true },
      [{ email: 'Mario@X.com' }, { email: 'mario@x.com ' }, { email: 'altro@x.com' }],
      ctx,
    );
    expect((r.output as { distinct: number }).distinct).toBe(2);
  });
  it('normalize OFF (default): "Mario@X" e "mario@x" sono distinti', async () => {
    const r = await exec({ field: 'email' }, [{ email: 'Mario@X' }, { email: 'mario@x' }], ctx);
    expect((r.output as { distinct: number }).distinct).toBe(2);
  });
  it('removalPercent + exampleDuplicates (max 5)', async () => {
    const r = await exec({}, [1, 1, 1, 1, 2], ctx);
    const out = r.output as {
      removalPercent: number;
      exampleDuplicates: unknown[];
      removed: number;
    };
    expect(out.removed).toBe(3);
    expect(out.removalPercent).toBe(60);
    expect(out.exampleDuplicates).toEqual([1, 1, 1]);
  });
});

describe('🔬 aggregate — precisione avg/median', () => {
  const exec = aggregateNode.executor!;
  it('🚨 avg arrotondato a 2 decimali di default (10+11+10)/3 = 10.33', async () => {
    const r = await exec({ reducer: 'avg', field: 'v' }, [{ v: 10 }, { v: 11 }, { v: 10 }], ctx);
    expect((r.output as { value: number }).value).toBe(10.33);
  });
  it('precision configurabile (0 → intero, 4 → 4 decimali)', async () => {
    const data = [{ v: 10 }, { v: 11 }, { v: 10 }];
    expect(
      (
        (await exec({ reducer: 'avg', field: 'v', precision: 0 }, data, ctx)).output as {
          value: number;
        }
      ).value,
    ).toBe(10);
    expect(
      (
        (await exec({ reducer: 'avg', field: 'v', precision: 4 }, data, ctx)).output as {
          value: number;
        }
      ).value,
    ).toBe(10.3333);
  });
  it('sum NON arrotondato (precision tocca solo avg/median)', async () => {
    const r = await exec({ reducer: 'sum', field: 'v' }, [{ v: 0.111 }, { v: 0.222 }], ctx);
    expect((r.output as { value: number }).value).toBeCloseTo(0.333, 3);
  });
});
