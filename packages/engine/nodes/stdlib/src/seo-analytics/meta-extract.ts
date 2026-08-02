/**
 * action_meta_extract — estrae meta tag SEO + Open Graph + Twitter Card + JSON-LD.
 *
 * Input: HTML (string da nodo precedente o esplicito).
 * Output: { title, description, canonical, robots, lang, og:{}, twitter:{}, jsonLd:[] }
 *
 * Zero network: pura parse cheerio. SSRF-safe by design.
 * Tollerante a HTML malformato (cheerio loose mode).
 */

import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

interface MetaResult {
  title: string | null;
  description: string | null;
  keywords: string[];
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  charset: string | null;
  viewport: string | null;
  author: string | null;
  favicon: string | null;
  themeColor: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  jsonLd: unknown[];
  hreflang: { lang: string; href: string; valid: boolean }[];
  /** Altri <meta name=…> non standard (generator, application-name, …). */
  metaExtra: Record<string, string>;
  /** Soft warnings su problemi rilevati. */
  warnings: string[];
}

const TRUNC_TITLE = 200;
const TRUNC_DESC = 500;
const MAX_HTML_BYTES = 5 * 1024 * 1024; // cap difensivo anti-OOM sul parse
/** Codice hreflang valido: ISO 639-1/2 + regione/script opzionale, oppure x-default. */
const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Za-z]{2})?)$/u;
/** <meta name=…> già mappati in campi dedicati → non finiscono in metaExtra. */
const KNOWN_META_NAMES = new Set([
  'description',
  'keywords',
  'robots',
  'viewport',
  'author',
  'theme-color',
]);

function getHtmlFromInput(config: Record<string, unknown>, input: unknown): string {
  const source = String(config.htmlSource ?? 'input');
  if (source === 'explicit') return String(config.htmlExplicit ?? '');
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.body === 'string') return obj.body;
    if (typeof obj.html === 'string') return obj.html;
  }
  return '';
}

function safeJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const rawHtml = getHtmlFromInput(config, input);
  if (!rawHtml.trim()) {
    return {
      output: { matched: false, warnings: ['Empty HTML input'] } satisfies Partial<MetaResult> & {
        matched: boolean;
      },
      durationMs: Date.now() - start,
      warnings: ['Empty HTML input'],
    };
  }
  // Cap difensivo anti-OOM: HTML oltre 5MB viene troncato prima del parse cheerio.
  const truncated = rawHtml.length > MAX_HTML_BYTES;
  const html = truncated ? rawHtml.slice(0, MAX_HTML_BYTES) : rawHtml;

  const $ = cheerioLoad(html);
  const result: MetaResult = {
    title: null,
    description: null,
    keywords: [],
    canonical: null,
    robots: null,
    lang: null,
    charset: null,
    viewport: null,
    author: null,
    favicon: null,
    themeColor: null,
    og: {},
    twitter: {},
    jsonLd: [],
    hreflang: [],
    metaExtra: {},
    warnings: [],
  };
  if (truncated)
    result.warnings.push(`HTML troncato a ${String(MAX_HTML_BYTES)} byte (cap anti-OOM)`);

  // <title>
  const titleText = $('head title').first().text().trim();
  if (titleText) result.title = titleText.slice(0, TRUNC_TITLE);

  // <html lang="">
  const lang = $('html').attr('lang');
  if (lang) result.lang = lang.trim();

  // <meta charset> / <meta http-equiv="content-type">
  result.charset = $('meta[charset]').attr('charset')?.trim().toLowerCase() ?? null;

  // Standard meta name=*
  $('meta[name]').each((_, el) => {
    const name = ($(el).attr('name') ?? '').trim().toLowerCase();
    const content = ($(el).attr('content') ?? '').trim();
    if (!name || !content) return;
    if (name === 'description') result.description = content.slice(0, TRUNC_DESC);
    else if (name === 'keywords') {
      result.keywords = content
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 50);
    } else if (name === 'robots') result.robots = content;
    else if (name === 'viewport') result.viewport = content;
    else if (name === 'author') result.author = content;
    else if (name === 'theme-color') result.themeColor = content;
    else if (name.startsWith('twitter:')) result.twitter[name.slice('twitter:'.length)] = content;
    // Ogni altro <meta name=…> non standard (generator, application-name, …) → metaExtra.
    else if (!KNOWN_META_NAMES.has(name)) result.metaExtra[name] = content;
  });

  // Favicon: icon / shortcut icon / apple-touch-icon (il primo dichiarato).
  const faviconHref = $(
    'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
  )
    .first()
    .attr('href');
  if (faviconHref) result.favicon = faviconHref.trim();

  // <meta property="og:*">
  $('meta[property]').each((_, el) => {
    const prop = ($(el).attr('property') ?? '').trim().toLowerCase();
    const content = ($(el).attr('content') ?? '').trim();
    if (!prop || !content) return;
    if (prop.startsWith('og:')) result.og[prop.slice('og:'.length)] = content;
    else if (prop.startsWith('twitter:')) result.twitter[prop.slice('twitter:'.length)] = content;
  });

  // <link rel="canonical">, alternate hreflang
  const canon = $('link[rel="canonical"]').attr('href');
  if (canon) result.canonical = canon.trim();
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const hreflang = ($(el).attr('hreflang') ?? '').trim();
    const href = ($(el).attr('href') ?? '').trim();
    if (hreflang && href)
      result.hreflang.push({ lang: hreflang, href, valid: HREFLANG_RE.test(hreflang) });
  });

  // JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    const parsed = safeJsonParse($(el).text());
    if (parsed !== null) result.jsonLd.push(parsed);
  });

  // Soft warnings — segnalano problemi senza fallire l'esecuzione
  if (!result.title) result.warnings.push('Missing <title>');
  else if (titleText.length > 60)
    result.warnings.push(`Title too long (${titleText.length} chars, recommended 50-60)`);
  else if (titleText.length < 20)
    result.warnings.push(`Title too short (${titleText.length} chars, recommended 20-60)`);
  if (!result.description) result.warnings.push('Missing meta description');
  else if (result.description.length > 160)
    result.warnings.push(
      `Description too long (${result.description.length} chars, recommended ≤160)`,
    );
  else if (result.description.length < 50)
    result.warnings.push(
      `Description too short (${result.description.length} chars, recommended 50-160)`,
    );
  if (!result.canonical) result.warnings.push('Missing <link rel="canonical">');
  if (!result.og.title) result.warnings.push('Missing og:title (social sharing degraded)');
  if (!result.og.image)
    result.warnings.push('Missing og:image (social cards will have no preview)');
  const invalidHreflang = result.hreflang.filter((h) => !h.valid).map((h) => h.lang);
  if (invalidHreflang.length > 0)
    result.warnings.push(`Invalid hreflang code(s): ${invalidHreflang.join(', ')}`);

  return {
    output: result,
    durationMs: Date.now() - start,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
};

export const metaExtractNode: NodeModule = {
  def: {
    id: 'action_meta_extract',
    type: 'action',
    label: 'Meta Extract (SEO + OG + Twitter + JSON-LD)',
    icon: 'tag',
    color: '#0ea5e9',
    description:
      'Parser meta tag SEO completo da HTML — estrae title, description, canonical, ' +
      'lang, robots, viewport, Open Graph (og:title/og:description/og:image/og:type/ ' +
      'og:url), Twitter Card (twitter:card/title/description/image/site/creator), ' +
      'JSON-LD strutturato (Schema.org Article/Product/Organization/BreadcrumbList ' +
      '/FAQPage/HowTo/Recipe), favicon, hreflang multi-language (con validazione del ' +
      "codice ISO 639-1), og:locale (dentro l'oggetto og), theme-color, e ogni altro " +
      '<meta name=…> non standard raccolto in metaExtra. HTML oltre 5MB troncato (cap ' +
      'anti-OOM). Output strutturato per scoring SEO automatico, DB audit, report email, ' +
      'AI agent suggestion rewriting.\n\n' +
      'Differenza con i sibling: action_meta_extract = parsing PURE locale (HTML → ' +
      'object structured, no network). Per scoring SEO completo con weight rules ' +
      'usa action_seo_audit downstream. Per analisi keyword density specifica usa ' +
      'action_keyword_density. Per audit broken links su pagina usa action_link_audit. ' +
      'Per redirect chain analysis usa action_redirect_chain.\n\n' +
      'Pipeline tipico: action_web_fetch_advanced (fetch HTML) → action_meta_extract ' +
      '(parse meta) → action_seo_audit (score) → action_send_email (digest report). ' +
      'Zero network in questo nodo: parsing locale via cheerio + regex robust. ' +
      'Tollerante a HTML malformato (tag chiusi male, attributi senza quote, encoding ' +
      'inconsistent UTF-8/Latin-1).\n\n' +
      'Output: `{ title, description, keywords, canonical, robots, lang, charset, ' +
      'viewport, author, favicon, themeColor, og: {...}, twitter: {...}, jsonLd: ' +
      '[{...}], hreflang: [{lang, href, valid}], metaExtra: { generator, ' +
      'application-name, ... }, warnings }`. JSON-LD normalizzato ad array (anche con 1 ' +
      'solo blocco). hreflang con flag `valid` (codice ISO 639-1 + regione opzionale).\n\n' +
      'Use case Cappella-Sistina-grade: (1) **SEO audit mensile** propri 100 ' +
      'landing pages — cron loop su sitemap → fetch + meta_extract + seo_audit → ' +
      'digest email con red flag (description mancante / canonical wrong / og:image ' +
      'broken); (2) **OpenGraph preview tester** — utente incolla URL nel form, ' +
      'workflow fetch + meta_extract → render preview FB/Twitter/LinkedIn come si ' +
      'vedrebbe → permette editor di iterare prima di publish; (3) **Schema.org ' +
      'validation** per propri prodotti e-commerce — verifica JSON-LD Product schema ' +
      'completo (price/availability/aggregateRating) per Google Rich Results; ' +
      '(4) **competitor SERP monitoring** — settimanale fetch 50 landing competitor, ' +
      'estrai title/description, alert se cambiano (= nuova strategia keyword).\n\n' +
      'Safety budget: HTML parse max 5 MB (oltre → truncate), regex robust con ' +
      'timeout 100ms (anti-ReDoS), JSON-LD parse safe (no crash su malformed), ' +
      'audit log con URL hash + meta count per cost monitoring.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'htmlSource',
        label: 'Sorgente HTML',
        type: 'select',
        required: false,
        options: ['input', 'explicit'],
        defaultValue: 'input',
        help: 'input = HTML dal nodo precedente (legge string, .body o .html). explicit = HTML statico per testing.',
      },
      {
        key: 'htmlExplicit',
        label: 'HTML (esplicito, solo per test)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '<html><head><title>Test</title></head><body></body></html>',
        showIf: { field: 'htmlSource', equals: 'explicit' },
        help: 'HTML statico per testing manuale. In produzione lascia su "input" e ricevi HTML dal nodo precedente.',
      },
    ],
    outputs: [
      'title',
      'description',
      'keywords',
      'canonical',
      'robots',
      'lang',
      'charset',
      'viewport',
      'author',
      'favicon',
      'themeColor',
      'og',
      'twitter',
      'jsonLd',
      'hreflang',
      'metaExtra',
      'warnings',
    ],
  },
  executor,
};
