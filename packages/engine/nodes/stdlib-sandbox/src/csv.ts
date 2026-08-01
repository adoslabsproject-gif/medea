/**
 * CSV parser/stringifier RFC 4180-compliant — pure JS browser-safe.
 *
 * Pattern Pipedream `

.csv` ma stricter: gestisce quote escape "" interno,
 * CRLF + LF, BOM UTF-8, fields con virgola/newline interni.
 *
 * NO dipendenze esterne — single-pass O(n) on byte stream string. Sicuro per
 * iniezione nel V8 isolate (no node:fs, no Buffer).
 *
 * @module sandbox/csv
 */

export interface CsvParseOptions {
  delimiter?: string;     // default ','
  hasHeader?: boolean;    // default true
  trimFields?: boolean;   // default false
}

export interface CsvStringifyOptions {
  delimiter?: string;     // default ','
  newline?: string;       // default '\n'
  header?: string[];      // explicit header (override key order)
  /** Quote anche fields semplici (default false: quote solo se contengono delim/quote/newline). */
  quoteAll?: boolean;
}

/**
 * Parse CSV string → array di oggetti (con header) o array di array (no header).
 *
 * Gestisce:
 *  - quote double-quote: "field with ""nested"" quote"
 *  - field con delimiter interno: "a,b"
 *  - field con newline interno: "a\nb"
 *  - BOM UTF-8 (U+FEFF) all'inizio
 *  - CRLF + LF + CR end-of-line
 *  - record vuoto finale (trailing newline)
 */
export function parseCsv(
  input: string,
  options: CsvParseOptions = {},
): Record<string, string>[] | string[][] {
  const delimiter = options.delimiter ?? ',';
  const hasHeader = options.hasHeader !== false;
  const trim = options.trimFields ?? false;

  // Strip BOM
  let src = input;
  if (src.length > 0 && src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(trim ? field.trim() : field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      if (i + 1 < n && src[i + 1] === '\n') i++;
      row.push(trim ? field.trim() : field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(trim ? field.trim() : field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Last field/row se non terminato da newline
  if (field.length > 0 || row.length > 0) {
    row.push(trim ? field.trim() : field);
    rows.push(row);
  }

  // Drop trailing empty rows (CSV con \n finale)
  while (rows.length > 0 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') {
    rows.pop();
  }

  if (!hasHeader) return rows;

  if (rows.length === 0) return [];
  const header = rows[0]!;
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const obj: Record<string, string> = {};
    for (let h = 0; h < header.length; h++) {
      obj[header[h]!] = cells[h] ?? '';
    }
    out.push(obj);
  }
  return out;
}

/**
 * Stringify array di oggetti o array di array → CSV string.
 *
 * Quote applicata se field contiene delimiter, quote, newline (RFC 4180) o
 * se `quoteAll=true`. Quote interne raddoppiate ("" → """").
 */
export function stringifyCsv(
  records: readonly Record<string, unknown>[] | readonly (readonly unknown[])[],
  options: CsvStringifyOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const newline = options.newline ?? '\n';
  const quoteAll = options.quoteAll ?? false;

  if (records.length === 0) return '';

  const escapeField = (raw: unknown): string => {
    const s = raw == null ? ''
      : typeof raw === 'string' ? raw
      : typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint' ? String(raw)
      : (JSON.stringify(raw) ?? '');
    const needsQuote = quoteAll
      || s.includes(delimiter)
      || s.includes('"')
      || s.includes('\n')
      || s.includes('\r');
    if (!needsQuote) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };

  // Detect record shape
  const first = records[0]!;
  const isArrayShape = Array.isArray(first);

  if (isArrayShape) {
    const rows = records as readonly (readonly unknown[])[];
    return rows.map((r) => r.map(escapeField).join(delimiter)).join(newline);
  }

  const objs = records as readonly Record<string, unknown>[];
  const header = options.header ?? Object.keys(objs[0] ?? {});
  const lines: string[] = [];
  lines.push(header.map(escapeField).join(delimiter));
  for (const obj of objs) {
    lines.push(header.map((k) => escapeField(obj[k])).join(delimiter));
  }
  return lines.join(newline);
}
