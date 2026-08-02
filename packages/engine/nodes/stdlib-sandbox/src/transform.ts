/**
 * Array/object transform helpers — pure JS, no dipendenze.
 *
 * Pattern lodash subset minimale + ergonomico per vendor custom-node.
 *
 * @module sandbox/transform
 */

/** Restituisce un nuovo oggetto con solo le keys specificate. */
export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/** Restituisce un nuovo oggetto SENZA le keys specificate. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const skip = new Set<string | number | symbol>(keys);
  const out = {} as Record<string | number | symbol, unknown>;
  for (const k of Object.keys(obj)) {
    if (!skip.has(k)) out[k] = (obj as Record<string, unknown>)[k];
  }
  return out as Omit<T, K>;
}

/** Group by predicate o key. */
export function groupBy<T>(
  items: readonly T[],
  key: keyof T | ((item: T) => string),
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const it of items) {
    const k = typeof key === 'function' ? key(it) : String(it[key]);
    (out[k] ??= []).push(it);
  }
  return out;
}

/** Sort by predicate. Stable: O(n log n). */
export function sortBy<T>(items: readonly T[], by: (item: T) => number | string): T[] {
  return [...items].sort((a, b) => {
    const va = by(a),
      vb = by(b);
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  });
}

/** Unique-by predicate (default identity). */
export function uniqBy<T>(items: readonly T[], by: (item: T) => unknown = (x) => x): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const it of items) {
    const k = by(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/** Chunk array into batches of size `n`. */
export function chunk<T>(items: readonly T[], n: number): T[][] {
  if (n <= 0 || !Number.isInteger(n)) throw new Error('chunk size must be a positive integer');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Deep clone via JSON (perde Date, undefined, Function — il vendor lo sa). */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Flatten array di array (1 livello). */
export function flatten<T>(items: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  // loop annidato, NON out.push(...sub): un sub-array enorme → spread RangeError.
  for (const sub of items) for (const x of sub) out.push(x);
  return out;
}

/** Sum number array. */
export function sum(items: readonly number[]): number {
  let s = 0;
  for (const v of items) s += v;
  return s;
}

/** Average number array. NaN se vuoto. */
export function avg(items: readonly number[]): number {
  if (items.length === 0) return NaN;
  return sum(items) / items.length;
}

/** Min by predicate. undefined se vuoto. */
export function minBy<T>(items: readonly T[], by: (item: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  let best = items[0]!;
  let bestVal = by(best);
  for (let i = 1; i < items.length; i++) {
    const v = by(items[i]!);
    if (v < bestVal) {
      best = items[i]!;
      bestVal = v;
    }
  }
  return best;
}

/** Max by predicate. undefined se vuoto. */
export function maxBy<T>(items: readonly T[], by: (item: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  let best = items[0]!;
  let bestVal = by(best);
  for (let i = 1; i < items.length; i++) {
    const v = by(items[i]!);
    if (v > bestVal) {
      best = items[i]!;
      bestVal = v;
    }
  }
  return best;
}

/** Range [start..end) con step (default 1). */
export function range(start: number, end?: number, step = 1): number[] {
  if (end === undefined) {
    end = start;
    start = 0;
  }
  if (step === 0) throw new Error('range step cannot be 0');
  const out: number[] = [];
  if (step > 0) {
    for (let i = start; i < end; i += step) out.push(i);
  } else {
    for (let i = start; i > end; i += step) out.push(i);
  }
  return out;
}
