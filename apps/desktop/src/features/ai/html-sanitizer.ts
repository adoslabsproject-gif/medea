/** Sanitizzazione HTML lato client per passarlo al modello AI.
 *
 *  Obiettivi:
 *  - rimuovere `<script>`, `<style>`, commenti, `<head>` interi
 *  - rimuovere attributi `on*` (handler) e `style=`
 *  - rimuovere link `javascript:` e `data:` non-immagine
 *  - comprimere whitespace
 *  - preservare struttura semantica (heading, liste, link, tabelle, immagini)
 *  - troncare con cap configurabile
 *
 *  Non sostituisce la sanitizzazione lato server con `ammonia` (vedi CLAUDE.md):
 *  questa serve SOLO per costruire il contesto AI, non per il rendering iframe. */

const STRIP_TAGS_RE =
  /<(script|style|noscript|head|meta|link|object|embed|iframe|frame|frameset)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SELF_CLOSING_STRIP_RE = /<\/?(head|meta|link)\b[^>]*\/?>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const ON_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const STYLE_ATTR_RE = /\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const CLASS_ATTR_RE = /\s+class\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF_RE =
  /\s+(href|src|action|formaction)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi;
const WS_RE = /\s+/g;

export function sanitizeHtmlForLlm(html: string, maxChars = 5000): string {
  let s = html;
  s = s.replace(COMMENT_RE, '');
  s = s.replace(STRIP_TAGS_RE, '');
  s = s.replace(SELF_CLOSING_STRIP_RE, '');
  s = s.replace(ON_ATTR_RE, '');
  s = s.replace(STYLE_ATTR_RE, '');
  s = s.replace(CLASS_ATTR_RE, '');
  s = s.replace(JS_HREF_RE, ' $1="#"');
  s = s.replace(WS_RE, ' ');
  s = s.trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + '\n[…HTML troncato…]';
  return s;
}
