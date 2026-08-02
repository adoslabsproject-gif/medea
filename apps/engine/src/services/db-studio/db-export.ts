/**
 * Serializzazione PURA delle righe di una tabella per l'export/backup scaricabile
 * sul device (DB Studio → "Esporta"). CSV (RFC 4180) + JSON. Nessun I/O, nessuna
 * dipendenza dal DB → testabile in isolamento con tutti gli edge di escaping.
 *
 * Richiesto dall'owner (2026-06-16): "le tabelle devono essere esportabili e
 * possibilitate a fare backup da scaricare sul proprio device".
 */

export type Row = Record<string, unknown>;

/**
 * Colonne in ordine deterministico: unione delle chiavi di TUTTE le righe nel loro
 * ordine di prima apparizione (le righe SQL hanno chiavi omogenee, ma documenti
 * NoSQL/righe sparse no → non perdiamo colonne presenti solo in alcune righe).
 */
export function unionColumns(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** Rappresentazione testuale di un valore di cella per il CSV. */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  // oggetti/array → JSON compatto (preserva il dato in una sola cella). Se non è
  // serializzabile (es. ciclico), marker esplicito invece di "[object Object]".
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '[unserializable]';
  }
}

/**
 * Escape RFC 4180: un campo va quotato se contiene `"`, `,`, `\n` o `\r`; i `"`
 * interni si raddoppiano. Quotare un campo che inizia con `=`,`+`,`-`,`@` mitiga
 * anche la CSV-injection in Excel (prefisso apice neutralizzante).
 */
function escapeCsvField(s: string): string {
  const needsQuote = /[",\r\n]/.test(s);
  const injectionRisk = /^[=+\-@\t\r]/.test(s);
  if (injectionRisk) {
    // prefisso apice → Excel/Sheets non interpreta la formula; poi quotiamo.
    return `"'${s.replace(/"/g, '""')}"`;
  }
  if (needsQuote) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvOptions {
  /** Colonne esplicite (ordine + selezione). Default: unione di tutte le righe. */
  columns?: readonly string[];
  /** Terminatore di riga. Default CRLF (compat Excel). */
  newline?: '\r\n' | '\n';
}

/** Riga header CSV (colonne escapate, senza terminatore). */
export function csvHeaderLine(columns: readonly string[]): string {
  return columns.map((c) => escapeCsvField(c)).join(',');
}

/**
 * Righe di una PAGINA → linee CSV (escapate, unite da `nl`, senza header e senza
 * terminatore finale). Usato dallo streaming per non tenere mai in RAM più di una
 * pagina. `columns` è fisso (derivato una volta dalla prima pagina).
 */
export function csvBodyLines(
  rows: readonly Row[],
  columns: readonly string[],
  nl: '\r\n' | '\n' = '\r\n',
): string {
  return rows
    .map((r) => {
      const row: Row = r && typeof r === 'object' ? r : {};
      return columns.map((c) => escapeCsvField(cellToString(row[c]))).join(',');
    })
    .join(nl);
}

/**
 * Righe → CSV RFC 4180. Header dalla lista colonne (o unione). Celle mancanti =
 * vuote. Stringa vuota se non ci sono né colonne né righe. (Variante buffered,
 * per dataset piccoli/test; per i download si usa lo streaming via csvBodyLines.)
 */
export function rowsToCsv(rows: readonly Row[], opts: CsvOptions = {}): string {
  const columns = opts.columns ? [...opts.columns] : unionColumns(rows);
  const nl = opts.newline ?? '\r\n';
  if (columns.length === 0) return '';
  const header = csvHeaderLine(columns);
  const body = csvBodyLines(rows, columns, nl);
  return body ? `${header}${nl}${body}` : header;
}

/** Righe → JSON indentato (array di oggetti). */
export function rowsToJson(rows: readonly Row[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Nome file sicuro per il Content-Disposition: solo `[A-Za-z0-9._-]`, il resto →
 * `_`, niente leading dot, lunghezza limitata. Anti header-injection / traversal.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80);
  return cleaned || 'export';
}

/**
 * Paginazione PURA per l'export: chiama `fetchPage(limit, offset)` a blocchi e
 * accumula fino a `maxRows`. Si ferma appena una pagina torna meno righe del
 * `limit` richiesto (= fine tabella). Se raggiunge il cap, fa un "peek" di 1 riga
 * oltre per dire onestamente se l'export è `truncated`. Il fetcher è iniettato →
 * testabile senza adapter/DB. Non assume nulla sull'engine.
 */
export async function paginateAll(
  fetchPage: (limit: number, offset: number) => Promise<readonly Row[]>,
  opts: { maxRows?: number; pageSize?: number } = {},
): Promise<{ rows: Row[]; truncated: boolean }> {
  const out: Row[] = [];
  // loop, NON out.push(...page): export DB grande → spread di una pagina → RangeError.
  const { truncated } = await paginatePages(
    fetchPage,
    (page) => {
      for (const r of page) out.push(r);
    },
    opts,
  );
  return { rows: out, truncated };
}

/**
 * Come `paginateAll` ma a MEMORIA LIMITATA: invece di accumulare, invoca
 * `onPage(rows)` per ogni pagina (il chiamante la scrive subito sullo stream e la
 * scarta). Ritorna il conteggio righe + `truncated` (peek oltre il cap). È il cuore
 * dell'export streaming — senza questo l'export di una tabella grande satura l'heap
 * del container (OOM, bug 2026-06-16). `onPage` può essere async (backpressure).
 */
export async function paginatePages(
  fetchPage: (limit: number, offset: number) => Promise<readonly Row[]>,
  onPage: (rows: readonly Row[]) => void | Promise<void>,
  opts: { maxRows?: number; pageSize?: number } = {},
): Promise<{ rows: number; truncated: boolean }> {
  const maxRows = opts.maxRows ?? 100_000;
  const pageSize = opts.pageSize ?? 5_000;
  let total = 0;
  let offset = 0;
  while (total < maxRows) {
    const limit = Math.min(pageSize, maxRows - total);
    const page = await fetchPage(limit, offset);
    if (page.length > 0) {
      await onPage(page);
      total += page.length;
    }
    if (page.length < limit) return { rows: total, truncated: false };
    offset += page.length;
  }
  const peek = await fetchPage(1, offset);
  return { rows: total, truncated: peek.length > 0 };
}

/** Stamp `YYYYMMDD-HHMMSS` UTC per i nomi file di export (ordinabile). */
export function exportStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear().toString()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}
