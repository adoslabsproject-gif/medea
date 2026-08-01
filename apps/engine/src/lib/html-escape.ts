/**
 * Escaping per output HTML — anti-XSS riflesso.
 *
 * Due contesti, due funzioni: NON sono intercambiabili.
 *
 *  - escapeHtml          -> testo o valore di attributo dentro markup HTML.
 *  - scriptStringLiteral -> valore interpolato DENTRO un blocco <script>:
 *                           li' l'escape HTML non basta (le entita' non
 *                           vengono decodificate in contesto JS) e va invece
 *                           prodotto un literal JS sicuro, neutralizzando
 *                           anche la sequenza di chiusura del tag script.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapa & < > " ' per inserimento sicuro come testo/attributo HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

// Separatori di riga JS (U+2028 / U+2029): validi in JSON ma spezzano uno
// string literal JS. Riferiti per codepoint per non dipendere dal byte
// letterale nel sorgente.
const LINE_SEP = 0x2028;
const PARA_SEP = 0x2029;

/**
 * Produce un literal JS (virgolette incluse) sicuro da interpolare dentro
 * uno <script>. JSON.stringify gestisce quote/backslash/newline; in piu'
 * neutralizziamo "<" (cosi' una sequenza di chiusura tag non puo' iniettare
 * markup) e i separatori di riga U+2028/U+2029.
 */
export function scriptStringLiteral(s: string): string {
  let out = '';
  for (const ch of JSON.stringify(s)) {
    const code = ch.codePointAt(0);
    if (ch === '<') out += '\\u003c';
    else if (code === LINE_SEP) out += '\\u2028';
    else if (code === PARA_SEP) out += '\\u2029';
    else out += ch;
  }
  return out;
}
