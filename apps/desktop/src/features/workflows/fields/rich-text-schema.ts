/**
 * Che HTML può uscire da un corpo email.
 *
 * Questo file è **la** decisione dell'editor ricco, non un dettaglio di
 * configurazione. Un WYSIWYG generico produce `<div>`, `<span style>`, classi,
 * `<font>`: HTML che il browser mostra benissimo e che Outlook, Gmail e la
 * posta di iOS rendono ognuno a modo suo. Il risultato è una email che si è
 * vista bene mentre la si scriveva e arriva storta.
 *
 * Lo schema di ProseMirror è una garanzia strutturale, non un filtro: il
 * documento **non può** contenere nodi che non stanno qui, quindi l'HTML in
 * uscita non può contenerli neppure. Anche incollando da Word.
 *
 * Cosa c'è, e perché tanto poco:
 *
 * - paragrafo, grassetto, corsivo, link, elenchi, due livelli di titolo,
 *   a capo forzato. È quello che serve a scrivere una email, ed è quello che
 *   tutti i client di posta rendono allo stesso modo dal 2005.
 * - niente colori, niente font, niente allineamento: sono le prime cose a
 *   rompersi fuori dal browser, e nessuna delle tre serve a un'automazione.
 * - niente immagini: un `<img>` in una email automatica o è remota — e allora
 *   viene bloccata dalla maggior parte dei client — o è allegata, che è un
 *   altro campo del nodo.
 */

import { Bold } from '@tiptap/extension-bold';
import { BulletList } from '@tiptap/extension-bullet-list';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { History } from '@tiptap/extension-history';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { ListItem } from '@tiptap/extension-list-item';
import { OrderedList } from '@tiptap/extension-ordered-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';

/**
 * Le estensioni, nell'ordine in cui il documento le usa.
 *
 * `openOnClick: false` sui link: dentro un campo di configurazione un click
 * serve a mettere il cursore, non a navigare. Aprire una pagina mentre si
 * sistema un indirizzo è il modo più veloce di perdere quello che si stava
 * scrivendo.
 */
export const RICH_TEXT_EXTENSIONS = [
  Document,
  Paragraph,
  Text,
  Bold,
  Italic,
  BulletList,
  OrderedList,
  ListItem,
  HardBreak,
  Heading.configure({ levels: [2, 3] }),
  Link.configure({ openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] }),
  History,
];

/**
 * Un corpo vuoto è vuoto, non `<p></p>`.
 *
 * Tiptap rappresenta il documento vuoto con un paragrafo senza testo, e
 * serializzato diventa `<p></p>`. Salvarlo vorrebbe dire che un campo mai
 * toccato risulta compilato — e un nodo che controlla «il corpo c'è?» direbbe
 * di sì davanti al niente.
 */
export function normalizeHtml(html: string): string {
  const vuoto = html.replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/g, '').trim();
  return vuoto === '' ? '' : html;
}
