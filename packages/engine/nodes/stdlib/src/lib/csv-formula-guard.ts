/**
 * Guardia anti CSV/Spreadsheet formula injection (CWE-1236) — SSOT condivisa.
 *
 * Una cella STRINGA che inizia con un trigger di formula (`= + - @`, TAB, CR)
 * viene eseguita all'apertura del CSV in Excel/LibreOffice/Google Sheets
 * (`=cmd|'/c calc'!A1`, `=HYPERLINK(...)`, `=2+5+cmd|...`). Prefissarla con un
 * apice (`'`) la rende un literal testuale inerte — la convenzione standard.
 *
 * Questo modulo è il SINGOLO punto di verità del set di trigger e della
 * neutralizzazione: ogni nodo che GENERA CSV (action_csv, logic_convert) lo
 * importa, così la regola non può divergere tra i due percorsi.
 *
 * IMPORTANTE — neutralizza SOLO le stringhe: i numeri (anche negativi serializzati
 * come "-5") NON sono celle-formula e non vanno toccati. Il chiamante decide la
 * serializzazione (String vs JSON.stringify) e applica questa guardia al solo
 * ramo `typeof value === 'string'`.
 */

/** Trigger di formula riconosciuti da Excel/LibreOffice/Sheets: `=`, `+`, `-`, `@`, TAB, CR. */
export const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Restituisce la stringa neutralizzata: se inizia con un trigger di formula,
 * la prefissa con un apice; altrimenti la lascia invariata.
 */
export function neutralizeCsvFormula(value: string): string {
  return CSV_FORMULA_PREFIX.test(value) ? `'${value}` : value;
}
