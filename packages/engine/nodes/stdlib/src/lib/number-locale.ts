/**
 * SSOT della coercion numerica locale-aware — usata dai nodi aggregation
 * (sum/avg/min/max/median) e da logic_convert (CSV→JSON con parseNumbers).
 *
 * Riconosce DUE formati senza ambiguità:
 *   • EN / ISO: separatore decimale "." e nessun raggruppamento ("1234.56", "42").
 *   • IT / EU:  separatore decimale "," e "." come raggruppamento migliaia
 *               ("1.234,56" → 1234.56, "1.000.000" → 1000000, "3,5" → 3.5).
 *
 * La disambiguazione è deterministica: se la stringa contiene una VIRGOLA, è
 * formato IT (la virgola è il decimale, i punti sono migliaia); altrimenti si
 * applica il parsing standard. Così "1.234" (senza virgola) → 1.234 (EN) e non
 * viene reinterpretato a 1234 — l'unico caso davvero ambiguo resta esplicitamente
 * EN, mai indovinato.
 *
 * Ritorna `null` (non 0) sui valori non-numerici, così i chiamanti possono
 * distinguere "assente/non valido" da "zero" (es. avg che non deve contare i
 * non-numerici nel denominatore).
 */

/** Una stringa-numero IT valida: cifre, punti-migliaia opzionali, virgola decimale opzionale, segno. */
const IT_NUMERIC = /^[+-]?\d{1,3}(\.\d{3})*(,\d+)?$|^[+-]?\d+(,\d+)?$/u;

export function parseNumberLocale(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t === '') return null;
  if (t.includes(',')) {
    // Formato IT solo se la struttura è coerente (migliaia + 1 sola virgola decimale):
    // evita di "salvare" stringhe arbitrarie con virgole (es. "1,2,3" o "a,b").
    if (!IT_NUMERIC.test(t)) return null;
    const normalized = t.replace(/\./gu, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
