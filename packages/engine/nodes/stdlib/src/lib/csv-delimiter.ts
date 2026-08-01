/**
 * Rilevamento del delimitatore CSV — usato da logic_convert.
 *
 * Le esportazioni reali usano tre delimitatori: virgola (CSV internazionale),
 * punto-e-virgola (lo standard de-facto dei gestionali/Excel italiani, perché la
 * virgola è il separatore decimale) e tab (TSV). L'auto-detect conta le occorrenze
 * di ciascun candidato FUORI dai campi quotati nella prima riga non vuota e sceglie
 * il più frequente; in caso di parità o assenza, fallback alla virgola.
 */

export type CsvDelimiter = ',' | ';' | '\t';
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t'];

/** Conta le occorrenze di `ch` nella riga IGNORANDO ciò che sta tra virgolette. */
function countOutsideQuotes(line: string, ch: string): number {
  let count = 0;
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ch) count += 1;
  }
  return count;
}

/** Prima riga "significativa" (la prima non vuota) per il campionamento. */
function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  const head = nl === -1 ? text : text.slice(0, nl);
  return head.replace(/\r$/u, '');
}

export function detectDelimiter(text: string): CsvDelimiter {
  const sample = firstLine(text);
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const cand of CANDIDATES) {
    const n = countOutsideQuotes(sample, cand);
    if (n > bestCount) { bestCount = n; best = cand; }
  }
  return best;
}

/**
 * Risolve il delimitatore dal config: 'auto' → detect sul testo; '\\t'/'tab' → TAB;
 * un carattere esplicito → quello; default virgola. `sample` serve solo per 'auto'.
 */
export function resolveDelimiter(raw: unknown, sample: string): CsvDelimiter {
  if (raw === '\t') return '\t'; // tab LETTERALE: prima del trim, che lo cancellerebbe
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '' || v === 'auto') return detectDelimiter(sample);
  if (v === '\\t' || v.toLowerCase() === 'tab') return '\t'; // "\t" testuale o "tab"
  if (v === ';') return ';';
  return ',';
}
