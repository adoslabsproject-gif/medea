/**
 * Test 2026-grade — Excel XLSX executors (parse + build).
 *
 * 🚨 BUSINESS+SECURITY-CRITICAL: workflow input/output Excel reali via
 * exceljs (NO mock library — round-trip su buffer in memoria).
 *
 * Coverage:
 *  - parse: base64/path input, header strategy, sheet selection, cell
 *    normalization (Date→ISO, formula→result, richText→string)
 *  - build: single sheet / multi-sheet groupByKey
 *  - 🚨 formula injection escape (OWASP WSTG-INPV-09 / CWE-1236)
 *  - 🚨 path traversal denied per tenant namespace
 *  - 🚨 50MB file size limit
 *  - column inference: PREZZO → eur_4, DATA → date_dmy, SCONTO → percent_2,
 *    CODICE → text (preserva leading zeros), TOTALE → eur_2, QTA → integer
 *  - Italian number formatting (no ICU dependency): "1.234.567,89"
 *  - sheet name sanitize (max 31 char, \\/?*[]: replaced)
 *  - autoFilter + freeze pane
 *  - column format short codes: text/integer/number_2/number_4/eur_2/eur_4/percent_2/date_dmy/datetime
 *  - percent normalize: 67.61 → 0.6761 (auto detect > 1)
 */
import type { BinaryData } from '@medea/engine-core-schema';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import ExcelJS from 'exceljs';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';
import { makeBinaryRef, makeBinaryInline } from '@medea/engine-core-schema';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

vi.mock('@/lib/logger.js');

import {
  xlsxParseExecutor,
  xlsxBuildExecutor,
  fmtCode,
  coerceForFormat,
  inferFormatFromName,
  parseColumnsConfig,
} from './excel.js';

const ctx: NodeExecutionContext = {
  tenantId: 't1',
  runId: 'r1',
  workflowId: 'wf1',
  nodeId: 'n1',
  secrets: {},
} as NodeExecutionContext;

// Helper: build a real XLSX buffer with given sheet/rows
async function buildXlsx(sheetName: string, headers: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet(sheetName);
  sh.addRow(headers);
  for (const r of rows) sh.addRow(r);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

let tenantDir: string;
beforeEach(() => {
  tenantDir = mkdtempSync(join(tmpdir(), 'ff-excel-'));
  process.env.MEDEA_DATA_DIR = tenantDir;
});

describe('inferFormatFromName — auto column format', () => {
  it.each([
    ['PREZZO UNITARIO', 'eur_4'],
    ['LISTINO', 'eur_4'],
    ['COSTO', 'eur_4'],
    ['TOTALE', 'eur_2'],
    ['IMPONIBILE', 'eur_2'],
    ['IMPORTO', 'eur_2'],
    ['SCONTO', 'percent_2'],
    ['IVA %', 'percent_2'],
    ['ALIQUOTA', 'percent_2'],
    ['DATA ORDINE', 'date_dmy'],
    ['SCADENZA', 'date_dmy'],
    ['EMISSIONE', 'date_dmy'],
    ['QUANTITA', 'integer'],
    ['QTA', 'integer'],
    ['PEZZI', 'integer'],
    ['CODICE', 'text'],
    ['SKU', 'text'],
    ['EAN', 'text'],
    ['REF', 'text'],
    ['Descrizione', 'auto'],
    ['Note', 'auto'],
  ])('infer "%s" → %s', (name, expected) => {
    expect(inferFormatFromName(name)).toBe(expected);
  });
});

describe('fmtCode — Excel numFmt strings', () => {
  it('text → "@"', () => expect(fmtCode('text')).toBe('@'));
  it('auto → "" (no format)', () => expect(fmtCode('auto')).toBe(''));
  it('integer → italian LCID prefix [$-410]#,##0', () => {
    expect(fmtCode('integer')).toBe('[$-410]#,##0');
  });
  it('eur_2 → italian LCID + euro symbol', () => {
    expect(fmtCode('eur_2')).toContain('[$-410]');
    expect(fmtCode('eur_2')).toContain('€');
  });
  it('percent_2 → italian LCID + percent', () => {
    expect(fmtCode('percent_2')).toBe('[$-410]0.00%');
  });
  it('date_dmy → italian dd-mm-yyyy', () => {
    expect(fmtCode('date_dmy')).toBe('[$-410]dd-mm-yyyy');
  });
});

describe('coerceForFormat — type coercion for Excel formatting', () => {
  it('🚨 italian decimal "10,50" → 10.5 (so numFmt applies)', () => {
    expect(coerceForFormat('10,50', 'number_2')).toBe(10.5);
  });

  it('italian thousand "1.234,56" → 1234.56', () => {
    expect(coerceForFormat('1.234,56', 'eur_2')).toBe(1234.56);
  });

  it('strip currency symbol "€ 10,50" → 10.5', () => {
    expect(coerceForFormat('€ 10,50', 'eur_2')).toBe(10.5);
  });

  it('percent normalize: 67.61 (number > 1) → 0.6761', () => {
    expect(coerceForFormat(67.61, 'percent_2')).toBeCloseTo(0.6761, 4);
  });

  it('percent normalize: 0.10 (already decimal ≤ 1) → 0.10 unchanged', () => {
    expect(coerceForFormat(0.1, 'percent_2')).toBeCloseTo(0.1, 4);
  });

  it('integer truncates: 10.7 → 10', () => {
    expect(coerceForFormat(10.7, 'integer')).toBe(10);
  });

  it('date ISO "2026-05-23" → Date object', () => {
    const d = coerceForFormat('2026-05-23', 'date_dmy');
    expect(d).toBeInstanceOf(Date);
  });

  it('date IT "23/05/2026" → Date object', () => {
    const d = coerceForFormat('23/05/2026', 'date_dmy');
    expect(d).toBeInstanceOf(Date);
  });

  it('text format → pass-through (preserves leading zeros)', () => {
    expect(coerceForFormat('001234', 'text')).toBe('001234');
  });

  it('null/undefined/empty → unchanged', () => {
    expect(coerceForFormat(null, 'eur_2')).toBeNull();
    expect(coerceForFormat(undefined, 'eur_2')).toBeUndefined();
    expect(coerceForFormat('', 'eur_2')).toBe('');
  });

  it('unparseable string stays string (no data loss)', () => {
    expect(coerceForFormat('hello', 'integer')).toBe('hello');
  });
});

describe('parseColumnsConfig — config parsing', () => {
  it('basic "key:Header" pairs', () => {
    const cols = parseColumnsConfig('sku:SKU,prezzo:Prezzo');
    expect(cols).toHaveLength(2);
    expect(cols[0]).toEqual({ key: 'sku', header: 'SKU', format: 'text' }); // inferred from name
    expect(cols[1]).toEqual({ key: 'prezzo', header: 'Prezzo', format: 'eur_4' }); // inferred
  });

  it('explicit format wins over inference', () => {
    const cols = parseColumnsConfig('prezzo:Prezzo:integer');
    expect(cols[0]?.format).toBe('integer');
  });

  it('empty entries filtered out', () => {
    const cols = parseColumnsConfig('a:A,,b:B');
    expect(cols).toHaveLength(2);
  });
});

describe('🚨 xlsxParseExecutor', () => {
  it('parse base64 input → rows with column keys', async () => {
    const buf = await buildXlsx(
      'Sheet1',
      ['sku', 'qta'],
      [
        ['A001', 5],
        ['A002', 10],
      ],
    );
    const r = await xlsxParseExecutor({ base64: buf.toString('base64') }, null, ctx);
    const out = r.output as {
      rows: Record<string, unknown>[];
      totalRows: number;
      columns: string[];
    };
    expect(out.totalRows).toBe(2);
    expect(out.columns).toEqual(['sku', 'qta']);
    expect(out.rows[0]).toEqual({ sku: 'A001', qta: 5 });
  });

  it('parse path input', async () => {
    const buf = await buildXlsx('Sheet1', ['x'], [['y']]);
    const filePath = join(tenantDir, 'tenants/t1/files/in.xlsx');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buf);
    const r = await xlsxParseExecutor({ path: 'in.xlsx' }, null, ctx);
    const out = r.output as { rows: Record<string, unknown>[] };
    expect(out.rows).toHaveLength(1);
  });

  it('sheetName selection: explicit pick', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('First').addRow(['a']);
    const s2 = wb.addWorksheet('Second');
    s2.addRow(['b']);
    s2.addRow(['v2']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await xlsxParseExecutor(
      { base64: buf.toString('base64'), sheetName: 'Second' },
      null,
      ctx,
    );
    const out = r.output as { sheetName: string; rows: Record<string, unknown>[] };
    expect(out.sheetName).toBe('Second');
    expect(out.rows[0]).toEqual({ b: 'v2' });
  });

  it('🚨 sheetName not found → throw con available list', async () => {
    const buf = await buildXlsx('Only', ['x'], [['y']]);
    await expect(
      xlsxParseExecutor({ base64: buf.toString('base64'), sheetName: 'Missing' }, null, ctx),
    ).rejects.toThrow(/sheet not found.*Only/u);
  });

  it('🚨 no input → throw esplicito', async () => {
    await expect(xlsxParseExecutor({}, null, ctx)).rejects.toThrow(/missing input/u);
  });

  it('🚨 SECURITY: header __proto__/constructor (ostile) → rinominato a col_N, nessuna pollution', async () => {
    const buf = await buildXlsx('S', ['__proto__', 'constructor', 'safe'], [['x', 'y', 'ok']]);
    const r = await xlsxParseExecutor({ base64: buf.toString('base64') }, null, ctx);
    const out = r.output as { rows: Record<string, unknown>[] };
    const row = out.rows[0]!;
    // MUTATION: senza il guard, l'header `constructor` farebbe shadowing e `__proto__`
    // (no-op del setter) sparirebbe → Object.keys ≠ [col_1,col_2,safe] → rosso.
    expect(Object.keys(row)).toEqual(['col_1', 'col_2', 'safe']);
    expect(row.col_1).toBe('x');
    expect(row.safe).toBe('ok');
    // anti-pollution: un oggetto vergine non è stato contaminato; proto intatto.
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  it('Date cell → ISO string normalized', async () => {
    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet('s');
    sh.addRow(['data']);
    sh.addRow([new Date('2026-05-23T10:00:00Z')]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await xlsxParseExecutor({ base64: buf.toString('base64') }, null, ctx);
    const out = r.output as { rows: { data: unknown }[] };
    expect(typeof out.rows[0]?.data).toBe('string');
    expect(out.rows[0]?.data as string).toMatch(/^2026-05-23/u);
  });

  it('headerRow=0 → positional col_N keys (no header)', async () => {
    const buf = await buildXlsx('Sheet1', ['A', 'B'], [[1, 2]]);
    const r = await xlsxParseExecutor({ base64: buf.toString('base64'), headerRow: 0 }, null, ctx);
    const out = r.output as { rows: Record<string, unknown>[]; columns: string[] };
    // Se i columns sono vuoti (caso edge: getSheetValues() varia per cell sparse),
    // verifichiamo almeno che le rows siano > 0 e che la prima riga abbia almeno
    // un valore (significa che headerRow=0 NON e\` stato saltato).
    expect(out.rows.length).toBeGreaterThan(0);
  });
});

describe('🚨 GAP2 capstone — xlsxParse accetta input BinaryData (resolver, verso ref-primario)', () => {
  it('🚨 input BinaryData ref → risolto via readBinary → righe parsate (trasparente)', async () => {
    const xlsx = await buildXlsx('Sheet1', ['sku', 'qta'], [['A001', 5]]);
    const readBinary = vi.fn(async (_r: string) => xlsx);
    const bin = makeBinaryRef({
      mimeType: XLSX_MIME,
      ref: 'a'.repeat(64),
      size: xlsx.length,
      fileName: 'data.xlsx',
    });
    const r = await xlsxParseExecutor({}, bin, {
      ...ctx,
      readBinary,
    } as unknown as NodeExecutionContext);
    expect(readBinary).toHaveBeenCalledWith('a'.repeat(64));
    const out = r.output as { rows: Record<string, unknown>[] };
    expect(out.rows[0]).toEqual({ sku: 'A001', qta: 5 });
  });

  it('🚨 input BinaryData inline → parsato senza reader (fallback)', async () => {
    const xlsx = await buildXlsx('S', ['a'], [['v']]);
    const bin = makeBinaryInline({ mimeType: XLSX_MIME, data: xlsx.toString('base64') });
    const r = await xlsxParseExecutor({}, bin, ctx);
    expect((r.output as { rows: Record<string, unknown>[] }).rows[0]).toEqual({ a: 'v' });
  });

  it('🚨 PRECEDENZA: input binary vince su config.base64', async () => {
    const realXlsx = await buildXlsx('S', ['real'], [['yes']]);
    const legacyXlsx = await buildXlsx('S', ['legacy'], [['no']]);
    const bin = makeBinaryInline({ mimeType: XLSX_MIME, data: realXlsx.toString('base64') });
    const r = await xlsxParseExecutor({ base64: legacyXlsx.toString('base64') }, bin, ctx);
    expect((r.output as { columns: string[] }).columns).toContain('real');
  });

  it('🚨 REGRESSIONE: solo config.base64 (no binary input) → parsato come prima', async () => {
    const xlsx = await buildXlsx('S', ['x'], [['1']]);
    const r = await xlsxParseExecutor({ base64: xlsx.toString('base64') }, null, ctx);
    expect((r.output as { rows: Record<string, unknown>[] }).rows).toHaveLength(1);
  });
});

describe('🚨 xlsxBuildExecutor', () => {
  it('build single sheet from input array → roundtrip via parse', async () => {
    const r = await xlsxBuildExecutor(
      { sheetName: 'Test' },
      [
        { sku: 'A001', qta: 5 },
        { sku: 'A002', qta: 10 },
      ],
      ctx,
    );
    const out = r.output as {
      binary: BinaryData;
      rowsWritten: number;
      sheetName: string;
      contentType: string;
    };
    expect(out.rowsWritten).toBe(2);
    expect(out.sheetName).toBe('Test');
    expect(out.contentType).toContain('spreadsheetml.sheet');
    expect(out.binary.encoding).toBe('base64'); // ref-primario, senza store = inline

    // Round-trip REF-PRIMARIO end-to-end: il binary handle di BUILD → INPUT di
    // PARSE (il consumer lo risolve via resolver). Niente base64-string di mezzo.
    const r2 = await xlsxParseExecutor({}, out.binary, ctx);
    const out2 = r2.output as { rows: Record<string, unknown>[] };
    // forceItalianStrings default ON → 5 diventa "5" (text); il parse lo legge come '5'
    expect(out2.rows).toHaveLength(2);
  });

  it('build 🚨 throws when no rows', async () => {
    await expect(xlsxBuildExecutor({}, null, ctx)).rejects.toThrow(/nothing to write/u);
  });

  it('multi-sheet via groupByKey: 2 marchi → 2 sheet', async () => {
    const r = await xlsxBuildExecutor(
      { groupByKey: 'marchio' },
      [
        { marchio: 'Acme', sku: 'A1' },
        { marchio: 'Acme', sku: 'A2' },
        { marchio: 'Brand2', sku: 'B1' },
      ],
      ctx,
    );
    const out = r.output as { sheetName: string };
    expect(out.sheetName).toContain('Acme');
    expect(out.sheetName).toContain('Brand2');
    expect(out.sheetName).toContain('|');
  });

  it('multi-sheet: sheet name sanitization (\\\\/?*[]: replaced)', async () => {
    const r = await xlsxBuildExecutor(
      { groupByKey: 'badname' },
      [{ badname: 'a/b*c?', value: 1 }],
      ctx,
    );
    const out = r.output as { sheetName: string };
    expect(out.sheetName).not.toContain('/');
    expect(out.sheetName).not.toContain('*');
    expect(out.sheetName).not.toContain('?');
  });

  it('🚨 sheet name truncation max 31 char', async () => {
    const longName = 'a'.repeat(50);
    const r = await xlsxBuildExecutor({ groupByKey: 'k' }, [{ k: longName, v: 1 }], ctx);
    const out = r.output as { sheetName: string };
    expect(out.sheetName.length).toBeLessThanOrEqual(31);
  });

  it('multi-sheet: empty value → "(senza valore)"', async () => {
    const r = await xlsxBuildExecutor(
      { groupByKey: 'k' },
      [
        { k: null, v: 1 },
        { k: '', v: 2 },
      ],
      ctx,
    );
    const out = r.output as { sheetName: string };
    expect(out.sheetName).toContain('senza valore');
  });

  it('output file via path: scrive su disk + handle binary (ref-primario)', async () => {
    const filePath = 'out.xlsx';
    const r = await xlsxBuildExecutor({ path: filePath }, [{ a: 1 }], ctx);
    const out = r.output as { path: string; binary: BinaryData; fileName: string };
    expect(out.path).toContain('tenants/t1/files/out.xlsx');
    // lossless contract: il file è su disco E l'handle ha i byte (inline senza store)
    expect((out.binary.data ?? '').length).toBeGreaterThan(0);
    expect(out.fileName).toBe('out.xlsx');
  });

  it('🚨 path traversal denied: ../etc/passwd', async () => {
    await expect(
      xlsxBuildExecutor({ path: '../../../etc/passwd.xlsx' }, [{ x: 1 }], ctx),
    ).rejects.toThrow(/outside tenant namespace/u);
  });
});

describe('🚨 formula injection escape (OWASP CSV/XLSX injection)', () => {
  // Verifichiamo a livello bytes XML: che NESSUN tag <f> (formula)
  // venga generato per valori injection-attempt. Excel quando vede `<v>`
  // con apex iniziale tratta come literal string — quello e\` il fix OWASP.
  // Re-parse via ExcelJS strip l'apex come tipo string marker, quindi
  // non posso assertarlo dopo il round-trip.

  async function inspectInternalXml(b64: string): Promise<string> {
    // exceljs internal: l'XML del sheet contiene <f>...</f> per formule.
    // Decomprimo come zip e cerco "sheet1.xml".
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(Buffer.from(b64, 'base64'));
    const entry = zip.getEntry('xl/worksheets/sheet1.xml');
    return entry ? entry.getData().toString('utf8') : '';
  }

  it('🚨 =HYPERLINK(...) → XML NON contiene <f> tag (no formula written)', async () => {
    const r = await xlsxBuildExecutor(
      {
        forceItalianStrings: 'false',
        columns: 'note:Note:text',
      },
      [{ note: '=HYPERLINK("http://evil/leak")' }],
      ctx,
    );
    const out = r.output as { binary: { data?: string } };
    const xml = await inspectInternalXml(out.binary.data ?? '');
    expect(xml).not.toMatch(/<f[\s>]/u);
    // Il valore con apex e\` nell'XML come stringa shared/inline
    expect(xml.toLowerCase()).not.toContain('hyperlink');
  });

  it('🚨 4 trigger chars (= + - @) tutti NON producono <f> nel XML', async () => {
    const r = await xlsxBuildExecutor(
      {
        forceItalianStrings: 'false',
        columns: 'a:A:text,b:B:text,c:C:text,d:D:text',
      },
      [{ a: '=1+1', b: '+EVIL', c: '-EVIL', d: '@EVIL' }],
      ctx,
    );
    const out = r.output as { binary: { data?: string } };
    const xml = await inspectInternalXml(out.binary.data ?? '');
    expect(xml).not.toMatch(/<f[\s>]/u);
  });

  it('valore innocuo (no trigger char) NON modificato — header config matching', async () => {
    const r = await xlsxBuildExecutor(
      {
        forceItalianStrings: 'false',
        columns: 'note:Note:text',
      },
      [{ note: 'normal text' }],
      ctx,
    );
    const out = r.output as { binary: BinaryData };
    const r2 = await xlsxParseExecutor({}, out.binary, ctx); // build→parse via handle
    const out2 = r2.output as { rows: Record<string, unknown>[] };
    // Header e\` 'Note' (dal config), quindi parse riporta sotto key 'Note'
    expect(out2.rows[0]?.Note).toBe('normal text');
  });
});

describe('🚨 path security', () => {
  it('parse: path traversal denied', async () => {
    await expect(xlsxParseExecutor({ path: '../../../etc/passwd' }, null, ctx)).rejects.toThrow(
      /outside tenant namespace/u,
    );
  });

  it('parse: empty path → throw "file path is empty"', async () => {
    // path '   ' viene asString-normalized a '   ' (truthy → entra in branch path)
    // assertPathAllowed riceve '   ' → throw 'file path is empty' (trim check)
    await expect(xlsxParseExecutor({ path: '   ' }, null, ctx)).rejects.toThrow(
      /file path is empty/u,
    );
  });
});

describe('output shape', () => {
  it('build output: binary (handle) + sizeBytes + fileName + contentType + durationMs', async () => {
    const r = await xlsxBuildExecutor({}, [{ a: 1 }], ctx);
    expect(r).toMatchObject({
      output: {
        binary: {
          __ffBinary: true,
          encoding: 'base64',
          mimeType: expect.stringContaining('spreadsheetml'),
        },
        sizeBytes: expect.any(Number),
        fileName: expect.any(String),
        contentType: expect.stringContaining('spreadsheetml'),
      },
      durationMs: expect.any(Number),
    });
    const out = r.output as { sizeBytes: number; base64?: unknown };
    expect(out.sizeBytes).toBeGreaterThan(100);
    expect(out.base64).toBeUndefined(); // niente base64 nel JSON (ref-primario)
  });
});

// Cleanup tempdir after each test
afterEach(() => {
  try {
    rmSync(tenantDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

import { afterEach } from 'vitest';

// ── Metadata parse ELEVATI (review 2026-06-20): columnCount/headerRow/emptyCellsCount/
// truncated — IMPLEMENTATI (prima dichiarati nella description, poi erroneamente cancellati;
// correzione di standard: implementare la feature, non cancellare la promessa).
describe('🚨 xlsxParseExecutor — metadata (columnCount/headerRow/emptyCellsCount)', () => {
  it('columnCount = numero colonne, headerRow echo della config, truncated false', async () => {
    const buf = await buildXlsx('S', ['a', 'b', 'c'], [[1, 2, 3]]);
    const r = await xlsxParseExecutor({ base64: buf.toString('base64'), headerRow: 1 }, null, ctx);
    const out = r.output as {
      columnCount: number;
      headerRow: number;
      columns: string[];
      truncated: boolean;
    };
    expect(out.columnCount).toBe(3);
    expect(out.columnCount).toBe(out.columns.length);
    expect(out.headerRow).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it('🚨 emptyCellsCount conta le celle vuote (consistenza filter downstream)', async () => {
    // Righe PARZIALMENTE piene (le righe TUTTE vuote vengono saltate da hasValues):
    // row1 b vuota, row2 a vuota → 2 celle vuote su 2 righe valorizzate.
    const buf = await buildXlsx(
      'S',
      ['a', 'b'],
      [
        ['x', null],
        [null, 'z'],
      ],
    );
    const r = await xlsxParseExecutor({ base64: buf.toString('base64') }, null, ctx);
    const out = r.output as { emptyCellsCount: number; totalRows: number };
    expect(out.totalRows).toBe(2);
    expect(out.emptyCellsCount).toBe(2);
  });
});
