/**
 * Coercizione sicura a stringa di un valore di tipo ignoto.
 *
 * Sostituisce `String(x)` su valori `unknown`/object: `String({})` produce
 * `"[object Object]"` (bug latente — es. una config interpolata che valuta a un
 * oggetto finirebbe stampata come "[object Object]"). Qui un oggetto diventa
 * JSON leggibile, null/undefined → fallback, i primitivi restano invariati.
 *
 * È la fix canonica per `@typescript-eslint/no-base-to-string`: il problema NON
 * è stilistico, è che `Object.prototype.toString` perde l'informazione.
 */
export function coerceString(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return '[Function]';
  // object: JSON leggibile invece di "[object Object]".
  try {
    return JSON.stringify(v) ?? fallback;
  } catch {
    return fallback;
  }
}
