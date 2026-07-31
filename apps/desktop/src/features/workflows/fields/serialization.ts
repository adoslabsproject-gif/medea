/**
 * I formati con cui i campi strutturati vengono salvati.
 *
 * Sono il contratto con il motore: un filtro scritto qui deve essere letto
 * dall'adattatore del database, un caso di switch dal suo esecutore. Per
 * questo stanno in un modulo a parte e sono testati da soli — un componente
 * React si può riscrivere, il formato no.
 */

export interface KeyValuePair {
  k: string;
  v: string;
}

export interface SwitchCase {
  value: string;
  branch: string;
}

export interface QueryFilter {
  column: string;
  op: string;
  value?: string;
}

export interface SortCriterion {
  column: string;
  direction: 'asc' | 'desc';
}

/** Gli operatori di filtro che non chiedono un valore. */
export const UNARY_FILTER_OPS: ReadonlySet<string> = new Set(['isNull', 'notNull']);

function parseArray(raw: string): unknown[] {
  if (!raw.trim()) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function asRecord(item: unknown): Record<string, unknown> | null {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ── Chiave → valore ────────────────────────────────────────────────────────

export function parseKeyValue(raw: string): KeyValuePair[] {
  if (!raw.trim()) return [];
  try {
    const obj = asRecord(JSON.parse(raw));
    if (!obj) return [];
    return Object.entries(obj).map(([k, v]) => ({
      k,
      v: typeof v === 'string' ? v : JSON.stringify(v),
    }));
  } catch {
    return [];
  }
}

/** Numeri, booleani e strutture tornano al loro tipo; il resto resta testo. */
export function serializeKeyValue(pairs: readonly KeyValuePair[]): string {
  const out: Record<string, unknown> = {};
  for (const { k, v } of pairs) {
    if (!k.trim()) continue;
    const structured =
      v.startsWith('{') ||
      v.startsWith('[') ||
      v === 'true' ||
      v === 'false' ||
      /^-?\d+(\.\d+)?$/.test(v);
    if (structured) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        // Non era JSON valido: resta una stringa.
      }
    }
    out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}

// ── Casi dello switch: `valore=ramo` una coppia per riga ───────────────────

export function parseSwitchCases(raw: string): SwitchCase[] {
  if (!raw.trim()) return [];
  return raw.split('\n').map((line) => {
    const idx = line.indexOf('=');
    if (idx < 0) return { value: line.trim(), branch: '' };
    return { value: line.slice(0, idx).trim(), branch: line.slice(idx + 1).trim() };
  });
}

export function serializeSwitchCases(cases: readonly SwitchCase[]): string {
  return cases
    .filter((c) => c.value.trim() !== '' || c.branch.trim() !== '')
    .map((c) => `${c.value}=${c.branch}`)
    .join('\n');
}

// ── Filtri di query ────────────────────────────────────────────────────────

export function parseFilters(raw: string): QueryFilter[] {
  return parseArray(raw).flatMap((item) => {
    const f = asRecord(item);
    if (!f) return [];
    return [{ column: str(f.column), op: str(f.op, 'eq'), value: str(f.value) }];
  });
}

export function serializeFilters(filters: readonly QueryFilter[]): string {
  return JSON.stringify(
    filters
      .filter((f) => f.column.trim() !== '')
      .map((f) => (UNARY_FILTER_OPS.has(f.op) ? { column: f.column, op: f.op } : f)),
  );
}

// ── Ordinamento: l'ordine delle righe è la precedenza ──────────────────────

export function parseSort(raw: string): SortCriterion[] {
  return parseArray(raw).flatMap((item) => {
    const r = asRecord(item);
    if (!r) return [];
    return [{ column: str(r.column), direction: r.direction === 'desc' ? 'desc' : 'asc' }];
  });
}

export function serializeSort(rows: readonly SortCriterion[]): string {
  return JSON.stringify(rows.filter((r) => r.column.trim() !== ''));
}

/** Sposta una riga di un posto, senza uscire dai bordi. */
export function moveRow<T>(rows: readonly T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** Da «Nome del cliente» a `nome_del_cliente`. */
export function toFieldKey(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
