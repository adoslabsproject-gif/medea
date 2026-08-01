/**
 * Safe coercion helpers — centralizza i pattern duplicati cross-files.
 *
 * Prima erano ridefiniti in actions/http.ts + altri 1-2 file. Ora UNICA
 * sorgente di verita\` importata da tutti i nodi legacy che non hanno (ancora)
 * adottato Zod schema parsing. I nodi v2 con `parseConfig` non ne necessitano.
 *
 * Tutte le funzioni sono pure (no side effects), no throw, no logger calls.
 */

/**
 * Convert any value to a string. null/undefined → '', primitives → String(),
 * object → JSON.stringify (no throw, falls back to '[object]' su circular).
 */
export function safeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  try { return JSON.stringify(value); } catch { return '[object]'; }
}

/**
 * Coerce to number. NaN/Infinity/non-numeric → fallback.
 */
export function safeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Truthy boolean coercion — accetta `true | 'true' | 1 | '1' | 'yes' | 'on'`.
 * Tutto il resto e\` false. Match con i toggle UI legacy (defaultValue: 'true').
 */
export function asBool(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const v = value.toLowerCase().trim();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  if (typeof value === 'number') return value === 1;
  return false;
}

/**
 * Parse a JSON string → Record<string,string>. Vuoto / invalido / array → {}.
 * Numeric / boolean values vengono stringificati per match shape header HTTP.
 */
export function parseKvJson(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

/**
 * Split a CSV string into array of trimmed non-empty tokens. Util per
 * `retryOnStatus: "429,500,502"` → [429, 500, 502] via mapper.
 */
export function splitCsv(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse CSV of integers (e.g. "200,201,204"). Filters NaN/non-finite.
 */
export function parseCsvInts(raw: unknown): number[] {
  return splitCsv(raw)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Pick a string from a list of candidates, returning the first non-empty.
 * Util per `pick(config.bearerToken, config.token, '')`.
 */
export function pick(...candidates: unknown[]): string {
  for (const c of candidates) {
    const s = safeString(c);
    if (s !== '') return s;
  }
  return '';
}
