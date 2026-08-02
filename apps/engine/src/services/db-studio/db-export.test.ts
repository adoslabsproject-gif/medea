import { describe, it, expect, vi } from 'vitest';
import {
  unionColumns,
  rowsToCsv,
  rowsToJson,
  sanitizeFilename,
  exportStamp,
  paginateAll,
  paginatePages,
  csvHeaderLine,
  csvBodyLines,
} from './db-export.js';

/** Fetcher di test: una tabella in-memory di `total` righe, pagina su limit/offset. */
function pagedSource(
  total: number,
): (limit: number, offset: number) => Promise<Record<string, unknown>[]> {
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (limit, offset) => Promise.resolve(all.slice(offset, offset + limit));
}

describe('paginateAll — accumulo + truncated onesto', () => {
  it('tabella più piccola di una pagina → tutte le righe, truncated:false', async () => {
    const r = await paginateAll(pagedSource(3), { pageSize: 5, maxRows: 100 });
    expect(r.rows.map((x) => x.id)).toEqual([0, 1, 2]);
    expect(r.truncated).toBe(false);
  });

  it('🚨 più pagine → concatena TUTTE in ordine, truncated:false', async () => {
    const r = await paginateAll(pagedSource(12), { pageSize: 5, maxRows: 100 });
    expect(r.rows).toHaveLength(12);
    expect(r.rows.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.truncated).toBe(false);
  });

  it('🚨 totale multiplo esatto del pageSize → si ferma (pagina finale corta=0), no loop infinito', async () => {
    const r = await paginateAll(pagedSource(10), { pageSize: 5, maxRows: 100 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it('🚨 oltre il cap maxRows → tronca a maxRows + truncated:true (peek vede altre righe)', async () => {
    const r = await paginateAll(pagedSource(50), { pageSize: 5, maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('🔒 cap raggiunto MA tabella finisce esattamente lì → truncated:false (peek vuoto)', async () => {
    const r = await paginateAll(pagedSource(10), { pageSize: 5, maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it('tabella vuota → [] + truncated:false (una sola fetch)', async () => {
    const fetch = vi.fn(pagedSource(0));
    const r = await paginateAll(fetch, { pageSize: 5, maxRows: 10 });
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("🔒 l'ultima pagina richiede SOLO le righe mancanti al cap (limit = maxRows-out.length)", async () => {
    const fetch = vi.fn(pagedSource(100));
    await paginateAll(fetch, { pageSize: 5, maxRows: 7 });
    // prima pagina: limit 5; seconda: limit min(5, 7-5)=2 → mai più di maxRows.
    expect(fetch.mock.calls[0]).toEqual([5, 0]);
    expect(fetch.mock.calls[1]).toEqual([2, 5]);
  });
});

describe('unionColumns', () => {
  it("unione delle chiavi nell'ordine di prima apparizione", () => {
    expect(
      unionColumns([
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });
  it('righe sparse → non perde colonne presenti solo in alcune righe', () => {
    expect(unionColumns([{ id: 1 }, { id: 2, extra: 'x' }])).toEqual(['id', 'extra']);
  });
  it('ignora righe non-oggetto / null', () => {
    expect(
      unionColumns([
        { a: 1 },
        null as unknown as Record<string, unknown>,
        5 as unknown as Record<string, unknown>,
      ]),
    ).toEqual(['a']);
  });
  it('lista vuota → []', () => {
    expect(unionColumns([])).toEqual([]);
  });
});

describe('rowsToCsv — RFC 4180 + anti-injection', () => {
  it('header + righe base (CRLF di default)', () => {
    const csv = rowsToCsv([{ a: '1', b: '2' }]);
    expect(csv).toBe('a,b\r\n1,2');
  });

  it('🔒 quota i campi con virgola, doppio apice (raddoppiato), newline', () => {
    const csv = rowsToCsv([{ x: 'ha, virgola', y: 'dice "ciao"', z: 'riga1\nriga2' }], {
      newline: '\n',
    });
    expect(csv).toBe('x,y,z\n"ha, virgola","dice ""ciao""","riga1\nriga2"');
  });

  it('null/undefined → cella vuota; cella mancante → vuota', () => {
    const csv = rowsToCsv([{ a: null, b: undefined, c: 'ok' }], {
      columns: ['a', 'b', 'c', 'd'],
      newline: '\n',
    });
    expect(csv).toBe('a,b,c,d\n,,ok,');
  });

  it('numeri/boolean/oggetti serializzati (oggetto → JSON in una cella)', () => {
    const csv = rowsToCsv([{ n: 42, ok: true, meta: { k: 'v' } }], { newline: '\n' });
    expect(csv).toBe('n,ok,meta\n42,true,"{""k"":""v""}"');
  });

  it('🔒 CSV-injection: valore che inizia con = + @ - viene neutralizzato con apice + quote', () => {
    const csv = rowsToCsv([{ f: '=SUM(A1:A2)' }, { f: '+1' }, { f: '@x' }, { f: '-3' }], {
      newline: '\n',
    });
    const lines = csv.split('\n');
    expect(lines[1]).toBe(`"'=SUM(A1:A2)"`);
    expect(lines[2]).toBe(`"'+1"`);
    expect(lines[3]).toBe(`"'@x"`);
    expect(lines[4]).toBe(`"'-3"`);
  });

  it('colonne esplicite → ordine + selezione rispettati', () => {
    const csv = rowsToCsv([{ a: 1, b: 2, c: 3 }], { columns: ['c', 'a'], newline: '\n' });
    expect(csv).toBe('c,a\n3,1');
  });

  it('nessuna riga e nessuna colonna → stringa vuota', () => {
    expect(rowsToCsv([])).toBe('');
  });

  it('colonne esplicite ma zero righe → solo header', () => {
    expect(rowsToCsv([], { columns: ['a', 'b'], newline: '\n' })).toBe('a,b');
  });
});

describe('csvHeaderLine / csvBodyLines — streaming a memoria limitata', () => {
  it('header = colonne escapate', () => {
    expect(csvHeaderLine(['a', 'b, c'])).toBe('a,"b, c"');
  });
  it('body di una pagina = righe escapate, colonne FISSE, senza header', () => {
    expect(
      csvBodyLines(
        [
          { a: 1, b: 'x,y' },
          { a: 2, b: 'z' },
        ],
        ['a', 'b'],
        '\n',
      ),
    ).toBe('1,"x,y"\n2,z');
  });
  it('celle mancanti nella pagina → vuote (colonne fisse dalla 1ª pagina)', () => {
    expect(csvBodyLines([{ a: 1 }], ['a', 'b'], '\n')).toBe('1,');
  });
  it('🔒 rowsToCsv === header + body (le due strade danno lo stesso CSV)', () => {
    const rows = [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ];
    const cols = ['a', 'b'];
    expect(rowsToCsv(rows, { columns: cols, newline: '\n' })).toBe(
      `${csvHeaderLine(cols)}\n${csvBodyLines(rows, cols, '\n')}`,
    );
  });
});

describe('paginatePages — streaming (NON accumula: anti-OOM)', () => {
  function pagedSource(
    total: number,
  ): (limit: number, offset: number) => Promise<Record<string, unknown>[]> {
    const all = Array.from({ length: total }, (_, i) => ({ id: i }));
    return (limit, offset) => Promise.resolve(all.slice(offset, offset + limit));
  }

  it('🚨 invoca onPage per OGNI pagina in ordine, senza accumulare', async () => {
    const seen: number[][] = [];
    const r = await paginatePages(
      pagedSource(12),
      (rows) => {
        seen.push(rows.map((x) => x.id as number));
      },
      { pageSize: 5, maxRows: 100 },
    );
    expect(seen).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
      [10, 11],
    ]);
    expect(r).toEqual({ rows: 12, truncated: false });
  });

  it('🚨 oltre il cap → tronca a maxRows + truncated:true', async () => {
    const seen: number[] = [];
    const r = await paginatePages(
      pagedSource(50),
      (rows) => {
        seen.push(rows.length);
      },
      { pageSize: 5, maxRows: 10 },
    );
    expect(seen.reduce((a, b) => a + b, 0)).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('🔒 onPage NON viene chiamato per pagine vuote (tabella vuota → 0 chiamate)', async () => {
    const onPage = vi.fn();
    const r = await paginatePages(pagedSource(0), onPage, { pageSize: 5, maxRows: 10 });
    expect(onPage).not.toHaveBeenCalled();
    expect(r).toEqual({ rows: 0, truncated: false });
  });

  it('🔒 supporta onPage async (backpressure dello stream)', async () => {
    const seen: number[] = [];
    await paginatePages(
      pagedSource(7),
      async (rows) => {
        await Promise.resolve();
        seen.push(rows.length);
      },
      { pageSize: 3, maxRows: 100 },
    );
    expect(seen).toEqual([3, 3, 1]);
  });

  it('🔒 paginateAll è equivalente (accumula i risultati di paginatePages)', async () => {
    const r = await paginateAll(pagedSource(7), { pageSize: 3, maxRows: 100 });
    expect(r.rows.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.truncated).toBe(false);
  });
});

describe('rowsToJson', () => {
  it('array di oggetti indentato', () => {
    expect(rowsToJson([{ a: 1 }])).toBe('[\n  {\n    "a": 1\n  }\n]');
  });
  it('vuoto → []', () => {
    expect(rowsToJson([])).toBe('[]');
  });
});

describe('sanitizeFilename — anti header-injection / traversal', () => {
  it('caratteri non sicuri → _', () => {
    expect(sanitizeFilename('my table/name')).toBe('my_table_name');
  });
  it('🔒 traversal e quote/CRLF rimossi', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeFilename('a"b\r\nContent-Type: x')).toBe('a_b_Content-Type_x');
  });
  it('leading dot/underscore strippati (no file nascosti)', () => {
    expect(sanitizeFilename('...hidden')).toBe('hidden');
  });
  it('accenti normalizzati', () => {
    expect(sanitizeFilename('clienti_città')).toBe('clienti_citta');
  });
  it('vuoto/solo-simboli → "export"', () => {
    expect(sanitizeFilename('')).toBe('export');
    expect(sanitizeFilename('///')).toBe('export');
  });
  it('lunghezza limitata a 80', () => {
    expect(sanitizeFilename('a'.repeat(200)).length).toBe(80);
  });
});

describe('exportStamp', () => {
  it('formato YYYYMMDD-HHMMSS UTC', () => {
    expect(exportStamp(new Date('2026-06-16T09:07:05Z'))).toBe('20260616-090705');
  });
});
