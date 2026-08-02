/**
 * Executor per action_lines_enrich.
 *
 * Algoritmo:
 *   1. Per ogni line con product_code, controlla se matcha una delle
 *      includeCodePatterns (regex). Se NO → passthrough.
 *   2. Se SÌ → cerca nel rawText la posizione del codice, prende la riga
 *      IMMEDIATAMENTE successiva (indentata, no codice articolo all'inizio).
 *   3. Se quella riga inizia con uno dei excludePrefixes → ignora.
 *   4. Altrimenti → concatena alla product_description col separator.
 *
 * Pure function — testabile in isolamento. No I/O, no dipendenze esterne.
 */
import { type NodeExecutor, safeUserRegex } from '@medea/engine-nodes-stdlib';

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

interface OrderLine {
  product_code?: string;
  product_description?: string;
  [key: string]: unknown;
}

/**
 * Cerca la "sotto-descrizione" di un codice nel testo del PDF.
 *
 * Strategia: trova la riga che inizia con product_code, prendi la riga
 * successiva, se NON inizia con un altro product_code (cioè è "indentata"
 * o testo libero), considerala sotto-descrizione.
 *
 * Restituisce stringa vuota se non trovata o se è una linea-codice.
 */
export function findSubDescription(
  rawText: string,
  productCode: string,
  allCodes: string[],
): string {
  if (!productCode) return '';
  const lines = rawText.split(/\r?\n/);
  // Trova la riga che contiene il code come "parola intera" all'inizio
  // (dopo eventuale whitespace).
  const codeEscaped = productCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const codeRegex = new RegExp(`(^|\\s)${codeEscaped}(\\s|$)`);
  let foundIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (codeRegex.test(lines[i] ?? '')) {
      foundIdx = i;
      break;
    }
  }
  if (foundIdx === -1 || foundIdx + 1 >= lines.length) return '';
  const nextLine = (lines[foundIdx + 1] ?? '').trim();
  if (!nextLine) return '';
  // Se la riga successiva contiene uno degli altri product_code, non è
  // una sotto-descrizione: è la prossima riga ordine.
  for (const otherCode of allCodes) {
    if (otherCode === productCode) continue;
    const otherEscaped = otherCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\s)${otherEscaped}(\\s|$)`).test(nextLine)) return '';
  }
  return nextLine;
}

/**
 * Verifica se il code matcha almeno una delle regex includ.
 * Restituisce true se matcha, false se no.
 */
export function codeMatchesIncludePattern(code: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (!pattern.trim()) continue;
    try {
      // RE2 (motore lineare, NO backtracking): il pattern è config dell'autore →
      // `new RegExp(pattern)` di V8 sarebbe ReDoS (es. `(a+)+$` → CPU 100% sul
      // container tenant). RE2 rende il catastrophic backtracking IMPOSSIBILE.
      if (safeUserRegex(pattern).test(code)) return true;
    } catch {
      /* regex invalida / feature non-RE2 — skip silenziosamente */
    }
  }
  return false;
}

/**
 * Verifica se la sotto-descrizione inizia con un prefisso da escludere
 * (case-insensitive).
 */
export function subDescIsExcluded(subDesc: string, excludedPrefixes: string[]): boolean {
  const lower = subDesc.toLowerCase().trim();
  for (const prefix of excludedPrefixes) {
    if (!prefix.trim()) continue;
    if (lower.startsWith(prefix.toLowerCase().trim())) return true;
  }
  return false;
}

export const linesEnrichExecutor: NodeExecutor = (config, input) => {
  const start = Date.now();
  // Risolvi sorgenti
  let lines: OrderLine[] = [];
  const linesExpr = config.linesExpression;
  if (Array.isArray(linesExpr)) lines = linesExpr as OrderLine[];
  else if (Array.isArray(input)) lines = input as OrderLine[];
  else if (
    input !== null &&
    typeof input === 'object' &&
    Array.isArray((input as Record<string, unknown>).lines)
  ) {
    lines = (input as { lines: OrderLine[] }).lines;
  }

  const rawText = asString(config.rawTextExpression);
  if (!rawText)
    return Promise.reject(
      new Error(
        'action_lines_enrich: "Testo PDF grezzo" è obbligatorio (es. {{$node.pdf_extract.json.text}})',
      ),
    );

  const includePatterns = asString(config.includeCodePatterns)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const excludePrefixes = asString(config.excludePrefixes)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const separator = asString(config.separator) || ' — ';

  const allCodes = lines.map((l) => asString(l.product_code)).filter(Boolean);

  let enrichedCount = 0;
  const enrichedLines = lines.map((line) => {
    const code = asString(line.product_code);
    if (!code) return line;
    if (!codeMatchesIncludePattern(code, includePatterns)) return line;
    const sub = findSubDescription(rawText, code, allCodes);
    if (!sub) return line;
    if (subDescIsExcluded(sub, excludePrefixes)) return line;
    enrichedCount += 1;
    const baseDesc = asString(line.product_description);
    const newDesc = baseDesc ? `${baseDesc}${separator}${sub}` : sub;
    return { ...line, product_description: newDesc };
  });

  // PASSTHROUGH dell'input: il nodo si inserisce in mezzo a una catena
  // (es. extract_of → enrich_lines → validate) e il validate downstream
  // ha bisogno di TUTTI i campi originali (order_number, totale_imponibile,
  // is_purchase_order, ecc.) NON solo di `lines`. Se ritornassimo solo
  // {lines, enrichedCount}, validate riceverebbe payload mutilato e la
  // condizione fallirebbe portando il flow sul ramo error_alert.
  // Strategia: spread dell'input completo, sovrascrivendo SOLO `lines`.
  const passthrough =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return Promise.resolve({
    output: { ...passthrough, lines: enrichedLines, enrichedCount },
    durationMs: Date.now() - start,
  });
};
