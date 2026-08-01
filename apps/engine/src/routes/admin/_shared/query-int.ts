/**
 * parseIntParam — parsing DIFENSIVO di query-string interi per le route admin.
 *
 * Motivazione (audit 2026-07-02, finding #10): diversi endpoint admin facevano
 * `Number(c.req.query('limit'))` / `parseInt(...)` senza guardia. Un input non
 * numerico (`?limit=abc`) produce `NaN`, che si propaga in `LIMIT NaN` / offset
 * NaN → errore driver → 500. Un input enorme (`?limit=9e9`) bypassava i cap.
 *
 * Contratto (puro, zero dipendenze → 100% testabile):
 *   - input `undefined`/vuoto/non-finito/NaN  → `def`
 *   - clamp nell'intervallo [min, max] inclusi
 *   - troncamento a intero (via Math.trunc, niente arrotondamenti sorprendenti)
 *   - `-0` normalizzato a `0`
 */
export interface IntParamBounds {
  /** Valore di default quando l'input è assente o non parsabile. */
  def: number;
  /** Minimo incluso. */
  min: number;
  /** Massimo incluso. */
  max: number;
}

export function parseIntParam(raw: string | undefined | null, bounds: IntParamBounds): number {
  const { def, min, max } = bounds;
  if (raw === undefined || raw === null || raw.trim() === '') return clamp(def, min, max);
  // Number() (non parseInt) così "12abc" → NaN → def, invece di 12 silenzioso.
  const n = Number(raw);
  if (!Number.isFinite(n)) return clamp(def, min, max);
  return clamp(Math.trunc(n), min, max);
}

function clamp(n: number, min: number, max: number): number {
  const v = Math.min(max, Math.max(min, n));
  return v === 0 ? 0 : v; // normalizza -0 → 0
}
