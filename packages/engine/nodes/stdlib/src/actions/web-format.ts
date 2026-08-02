/**
 * Web-format nodes — estrazione da HTML e conversione Markdown→HTML, in JavaScript
 * puro (ZERO dipendenze, ZERO `node:*`, browser-safe). Coprono casi che in n8n
 * richiedono il nodo HTML Extract o un nodo Code con cheerio.
 *
 *   - action_html_extract : testo / link / immagini / titolo / meta / heading da HTML
 *   - action_markdown     : Markdown → HTML sicuro (escape, subset whitelisted)
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════════════
// action_html_extract
// ════════════════════════════════════════════════════════════════════════
function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const htmlExtractExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const html = str(config.html !== undefined && str(config.html) !== '' ? config.html : input);
  const op = str(config.operation, 'text');
  switch (op) {
    case 'text':
      return { output: { result: stripTags(html) }, durationMs: Date.now() - startedAt };
    case 'links': {
      const links: { href: string; text: string }[] = [];
      const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null)
        links.push({ href: decodeEntities(m[1]!), text: stripTags(m[2]!) });
      return { output: { result: links, count: links.length }, durationMs: Date.now() - startedAt };
    }
    case 'images': {
      const imgs: string[] = [];
      const re = /<img\b[^>]*src\s*=\s*["']([^"']+)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) imgs.push(decodeEntities(m[1]!));
      return { output: { result: imgs, count: imgs.length }, durationMs: Date.now() - startedAt };
    }
    case 'title': {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      return { output: { result: m ? stripTags(m[1]!) : '' }, durationMs: Date.now() - startedAt };
    }
    case 'meta': {
      const meta: Record<string, string> = {};
      const re = /<meta\b[^>]*>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const tag = m[0];
        const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
        if (name && content !== undefined) meta[name] = decodeEntities(content);
      }
      return {
        output: { result: meta, count: Object.keys(meta).length },
        durationMs: Date.now() - startedAt,
      };
    }
    case 'headings': {
      const headings: { level: number; text: string }[] = [];
      const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null)
        headings.push({ level: Number(m[1]), text: stripTags(m[2]!) });
      return {
        output: { result: headings, count: headings.length },
        durationMs: Date.now() - startedAt,
      };
    }
    default:
      throw new Error(`action_html_extract: operazione sconosciuta "${op}"`);
  }
};

export const htmlExtractNode: NodeModule = {
  def: {
    id: 'action_html_extract',
    type: 'action',
    label: 'Estrai da HTML',
    icon: 'code',
    color: '#7c3aed',
    description:
      'Estrae dati strutturati da una pagina/frammento HTML in JavaScript puro (zero dipendenze) — il nodo HTML ' +
      'Extract di n8n senza dover usare un nodo Code con cheerio. Sei modalità da dropdown: ' +
      '(1) TESTO — rimuove tutti i tag (e i blocchi script/style) restituendo il testo leggibile, con gli a-capo ' +
      'preservati nei punti giusti (paragrafi, liste, heading) e le entità HTML decodificate (&amp; → &): per ' +
      'indicizzare, riassumere via AI, fare analisi del contenuto; ' +
      '(2) LINK — tutti i collegamenti come { href, text } (mappa i link di una pagina, estrai gli URL di un ' +
      'risultato di ricerca, trova i download); ' +
      '(3) IMMAGINI — tutti gli src delle immagini; ' +
      '(4) TITOLO — il contenuto del tag <title>; ' +
      '(5) META — tutti i meta tag come oggetto { name/property: content }, inclusi gli Open Graph (og:title, ' +
      'og:image, description) per anteprime social, SEO, schede prodotto; ' +
      '(6) HEADING — tutti i titoli H1-H6 con il loro livello, per ricostruire la struttura/sommario di un ' +
      'documento. ' +
      'Le entità HTML vengono sempre decodificate e i blocchi script/style esclusi dal testo. ' +
      'Output a seconda della modalità: { result } (testo/titolo) o { result, count } (link/immagini/meta/heading). ' +
      'Use case: estrai il testo pulito di un articolo prima di passarlo a un nodo AI; raccogli tutti i link di ' +
      "una pagina indice per il crawling; leggi i meta Open Graph per generare un'anteprima; ricava il sommario " +
      'dai heading di una pagina di documentazione.',
    configFields: [
      {
        key: 'operation',
        label: 'Cosa estrarre',
        type: 'select',
        required: true,
        defaultValue: 'text',
        options: ['text', 'links', 'images', 'title', 'meta', 'headings'],
        help: 'text = solo testo · links/images = elenchi · title/meta/headings = metadati struttura.',
      },
      {
        key: 'html',
        label: 'HTML',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "Il contenuto HTML da analizzare. Vuoto = usa l'input del nodo.",
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: htmlExtractExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_markdown — Markdown → HTML sicuro
// ════════════════════════════════════════════════════════════════════════
function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" rel="noopener noreferrer">$1</a>',
      );
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      const lvl = h[1]!.length;
      out.push(`<h${lvl}>${inline(h[2]!)}</h${lvl}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (/^>\s?/.test(line)) {
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push('<hr>');
      continue;
    }
    if (line.trim() === '') continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
const markdownExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const md = str(
    config.markdown !== undefined && str(config.markdown) !== '' ? config.markdown : input,
  );
  const html = mdToHtml(md);
  return { output: { html, length: html.length }, durationMs: Date.now() - startedAt };
};

export const markdownNode: NodeModule = {
  def: {
    id: 'action_markdown',
    type: 'action',
    label: 'Markdown → HTML',
    icon: 'file-text',
    color: '#db2777',
    description:
      'Converte testo Markdown in HTML SICURO, in JavaScript puro (zero dipendenze) — utile soprattutto per ' +
      "trasformare l'output di un nodo AI (che spesso produce Markdown) in HTML pronto per un'email o una pagina. " +
      'La cosa fondamentale: ogni contenuto testuale viene ESCAPATO (anti-XSS) prima di applicare la formattazione, ' +
      "e sono supportati solo gli elementi di una whitelist sicura — niente HTML grezzo dell'utente che passa " +
      'inosservato (a differenza di molte librerie Markdown con opzioni "html: true" pericolose). Supporta: ' +
      'titoli (#…######), grassetto (**), corsivo (*), codice inline (`) e blocchi di codice (```), liste ' +
      'puntate (- / *), citazioni (>), linee orizzontali (---) e link [testo](https://…) — con rel="noopener ' +
      'noreferrer" automatico e SOLO schemi http/https (no javascript:). ' +
      'Output: { html, length }. ' +
      "Use case: trasforma la risposta Markdown di un agente AI nel corpo HTML di un'email; pubblica una nota " +
      'scritta in Markdown come HTML; genera il contenuto formattato di un messaggio da un template Markdown; ' +
      'converti le note di rilascio Markdown in HTML per una pagina di changelog.',
    configFields: [
      {
        key: 'markdown',
        label: 'Markdown',
        type: 'textarea',
        required: false,
        defaultValue: 'input',
        placeholder: '# Titolo\n\nTesto **in grassetto** e [un link](https://example.com).',
        help: "Il testo Markdown da convertire. Vuoto = usa l'input del nodo.",
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: markdownExecutor,
};
