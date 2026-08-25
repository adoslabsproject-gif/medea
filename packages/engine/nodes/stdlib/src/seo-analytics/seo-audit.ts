/**
 * action_seo_audit — audit SEO completo di una pagina HTML.
 *
 * Combina meta extraction + structural checks + score qualitativo (0-100).
 * Output dettagliato con: meta info, heading outline, image alt audit, link
 * counts (internal/external), word count, schema.org types, score finale.
 *
 * Zero network — pure HTML parsing. Per check link broken usa action_link_audit.
 */

import { load as cheerioLoad, type CheerioAPI } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

interface SeoIssue {
  severity: 'critical' | 'warning' | 'info';
  code: string;
  message: string;
  evidence?: string;
}

const MAX_IMAGES = 1000;
const MAX_LINKS = 5000;

interface SeoAuditResult {
  url: string | null;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  title: { value: string | null; length: number; ok: boolean };
  description: { value: string | null; length: number; ok: boolean };
  canonical: { value: string | null; ok: boolean };
  lang: string | null;
  robots: string | null;
  viewport: string | null;
  themeColor: string | null;
  favicon: string | null;
  h1: { count: number; texts: string[]; ok: boolean };
  headingOutline: { level: number; text: string }[];
  headingSkips: { from: number; to: number }[];
  images: { total: number; missingAlt: number; emptyAlt: number };
  links: { internal: number; external: number; nofollow: number; total: number };
  wordCount: number;
  openGraph: { hasTitle: boolean; hasDescription: boolean; hasImage: boolean };
  twitterCard: { hasCard: boolean; type: string | null };
  schemaTypes: string[];
  hreflangCount: number;
  issues: SeoIssue[];
}

function getHtml(
  config: Record<string, unknown>,
  input: unknown,
): { html: string; url: string | null } {
  const source = String(config.htmlSource ?? 'input');
  if (source === 'explicit') return { html: String(config.htmlExplicit ?? ''), url: null };
  if (typeof input === 'string') return { html: input, url: null };
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const url =
      typeof obj.url === 'string'
        ? obj.url
        : typeof obj.finalUrl === 'string'
          ? obj.finalUrl
          : null;
    if (typeof obj.body === 'string') return { html: obj.body, url };
    if (typeof obj.html === 'string') return { html: obj.html, url };
  }
  return { html: '', url: null };
}

function buildBaseUrl(declaredUrl: string | null, $: CheerioAPI): URL | null {
  const baseHref = $('base[href]').attr('href');
  const candidate = baseHref ?? declaredUrl;
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function classifyLink(
  href: string,
  base: URL | null,
): 'internal' | 'external' | 'anchor' | 'mailto' | 'tel' | 'unknown' {
  const trimmed = href.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('#')) return 'anchor';
  if (trimmed.startsWith('mailto:')) return 'mailto';
  if (trimmed.startsWith('tel:')) return 'tel';
  try {
    const resolved = new URL(trimmed, base ?? 'https://example.invalid');
    if (!base) return 'unknown';
    return resolved.host === base.host ? 'internal' : 'external';
  } catch {
    return 'unknown';
  }
}

function scoreToGrade(score: number): SeoAuditResult['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const { html, url } = getHtml(config, input);
  if (!html.trim()) {
    return {
      output: { matched: false, warnings: ['Empty HTML input'] },
      durationMs: Date.now() - start,
      warnings: ['Empty HTML input'],
    };
  }

  const $ = cheerioLoad(html);
  const issues: SeoIssue[] = [];
  const base = buildBaseUrl(url, $);

  // Title
  const titleVal = $('head title').first().text().trim() || null;
  const titleLen = titleVal?.length ?? 0;
  const titleOk = titleLen >= 20 && titleLen <= 60;
  if (!titleVal)
    issues.push({ severity: 'critical', code: 'NO_TITLE', message: 'Missing <title>' });
  else if (titleLen > 60)
    issues.push({
      severity: 'warning',
      code: 'TITLE_TOO_LONG',
      message: `Title ${titleLen} chars (max 60)`,
    });
  else if (titleLen < 20)
    issues.push({
      severity: 'warning',
      code: 'TITLE_TOO_SHORT',
      message: `Title ${titleLen} chars (min 20)`,
    });

  // Description

  const descVal = $('meta[name="description"]').attr('content')?.trim() || null;
  const descLen = descVal?.length ?? 0;
  const descOk = descLen >= 50 && descLen <= 160;
  if (!descVal)
    issues.push({
      severity: 'critical',
      code: 'NO_DESCRIPTION',
      message: 'Missing meta description',
    });
  else if (descLen > 160)
    issues.push({
      severity: 'warning',
      code: 'DESC_TOO_LONG',
      message: `Description ${descLen} chars (max 160)`,
    });
  else if (descLen < 50)
    issues.push({
      severity: 'warning',
      code: 'DESC_TOO_SHORT',
      message: `Description ${descLen} chars (min 50)`,
    });

  // Canonical

  const canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;
  if (!canonical)
    issues.push({
      severity: 'warning',
      code: 'NO_CANONICAL',
      message: 'Missing <link rel="canonical">',
    });

  // lang
  const lang = $('html').attr('lang')?.trim() ?? null;
  if (!lang)
    issues.push({ severity: 'warning', code: 'NO_LANG', message: 'Missing <html lang="…">' });

  // robots
  const robots = $('meta[name="robots"]').attr('content')?.trim() ?? null;
  const isNoindex = robots ? /noindex/iu.test(robots) : false;
  if (isNoindex)
    issues.push({
      severity: 'critical',
      code: 'NOINDEX',
      message: 'Page has robots="noindex" — not crawlable',
    });

  // viewport (mobile-friendliness), theme-color, favicon
  const viewport = $('meta[name="viewport"]').attr('content')?.trim() ?? null;
  if (!viewport)
    issues.push({
      severity: 'info',
      code: 'NO_VIEWPORT',
      message: 'Missing <meta name="viewport"> (mobile-friendliness)',
    });
  const themeColor = $('meta[name="theme-color"]').attr('content')?.trim() ?? null;
  const favicon =
    $('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
      .first()
      .attr('href')
      ?.trim() ?? null;

  // H1
  const h1Texts: string[] = [];
  $('h1').each((_, el) => {
    h1Texts.push($(el).text().trim());
  });
  const h1Count = h1Texts.length;
  const h1Ok = h1Count === 1;
  if (h1Count === 0)
    issues.push({ severity: 'critical', code: 'NO_H1', message: 'No <h1> on page' });
  else if (h1Count > 1)
    issues.push({
      severity: 'warning',
      code: 'MULTIPLE_H1',
      message: `${h1Count} <h1> tags (recommended 1)`,
    });

  // Heading outline (limited to first 50 to bound size)
  const headingOutline: { level: number; text: string }[] = [];
  $('h1, h2, h3, h4, h5, h6')
    .slice(0, 50)
    .each((_, el) => {
      const tagName = (el as { tagName?: string }).tagName ?? 'h1';
      const level = Number(tagName.replace(/^h/iu, '')) || 1;
      headingOutline.push({ level, text: $(el).text().trim().slice(0, 200) });
    });
  // Heading hierarchy: un livello che SALTA il predecessore (es. h1→h3) è un difetto
  // di accessibilità/SEO. Confronto solo le discese (un h3→h1 di risalita è lecito).
  const headingSkips: { from: number; to: number }[] = [];
  for (let i = 1; i < headingOutline.length; i += 1) {
    const prev = headingOutline[i - 1]!.level;
    const cur = headingOutline[i]!.level;
    if (cur > prev + 1) headingSkips.push({ from: prev, to: cur });
  }
  if (headingSkips.length > 0) {
    const first = headingSkips[0]!;
    issues.push({
      severity: 'warning',
      code: 'HEADING_SKIP',
      message: `${headingSkips.length} heading level skip(s) (e.g. h${String(first.from)} → h${String(first.to)})`,
      evidence: `h${String(first.from)} → h${String(first.to)}`,
    });
  }

  // Images alt audit (cap difensivo 1000 elementi)
  let imgTotal = 0;
  let imgMissingAlt = 0;
  let imgEmptyAlt = 0;
  $('img')
    .slice(0, MAX_IMAGES)
    .each((_, el) => {
      imgTotal += 1;
      const alt = $(el).attr('alt');
      if (alt === undefined) imgMissingAlt += 1;
      else if (alt.trim() === '') imgEmptyAlt += 1;
    });
  if (imgMissingAlt > 0)
    issues.push({
      severity: 'warning',
      code: 'IMG_MISSING_ALT',
      message: `${imgMissingAlt}/${imgTotal} images missing alt attribute`,
      evidence: `${imgMissingAlt} senza alt`,
    });

  // Links count (cap difensivo 5000 elementi)
  let internal = 0,
    external = 0,
    nofollow = 0,
    totalLinks = 0;
  $('a[href]')
    .slice(0, MAX_LINKS)
    .each((_, el) => {
      totalLinks += 1;
      const href = $(el).attr('href') ?? '';
      const rel = ($(el).attr('rel') ?? '').toLowerCase();
      if (rel.includes('nofollow')) nofollow += 1;
      const kind = classifyLink(href, base);
      if (kind === 'internal') internal += 1;
      else if (kind === 'external') external += 1;
    });

  // Word count (rough: body text /\s+/)
  const bodyText = $('body').text().replace(/\s+/gu, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;
  if (wordCount < 300)
    issues.push({
      severity: 'info',
      code: 'LOW_WORD_COUNT',
      message: `${wordCount} words (thin content threshold 300)`,
    });

  // Open Graph
  const ogTitle = Boolean($('meta[property="og:title"]').attr('content'));
  const ogDesc = Boolean($('meta[property="og:description"]').attr('content'));
  const ogImage = Boolean($('meta[property="og:image"]').attr('content'));
  if (!ogTitle)
    issues.push({
      severity: 'info',
      code: 'NO_OG_TITLE',
      message: 'Missing og:title (social sharing degraded)',
    });
  if (!ogImage)
    issues.push({
      severity: 'info',
      code: 'NO_OG_IMAGE',
      message: 'Missing og:image (social cards no preview)',
    });

  // Twitter Card
  const twCard =
    $('meta[name="twitter:card"]').attr('content') ??
    $('meta[property="twitter:card"]').attr('content') ??
    null;

  // Schema.org JSON-LD
  const schemaTypes = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const visit = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          if (typeof obj['@type'] === 'string') schemaTypes.add(obj['@type']);
          else if (Array.isArray(obj['@type']))
            obj['@type'].forEach((t) => {
              if (typeof t === 'string') schemaTypes.add(t);
            });
          Object.values(obj).forEach(visit);
        }
      };
      visit(parsed);
    } catch {
      /* malformed JSON-LD ignored */
    }
  });

  // Hreflang
  const hreflangCount = $('link[rel="alternate"][hreflang]').length;

  // Score (0-100)
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'critical') score -= 15;
    else if (issue.severity === 'warning') score -= 5;
    else score -= 1;
  }
  score = Math.max(0, Math.min(100, score));

  const result: SeoAuditResult = {
    url,
    score,
    grade: scoreToGrade(score),
    title: { value: titleVal, length: titleLen, ok: titleOk },
    description: { value: descVal, length: descLen, ok: descOk },
    canonical: { value: canonical, ok: Boolean(canonical) },
    lang,
    robots,
    viewport,
    themeColor,
    favicon,
    h1: { count: h1Count, texts: h1Texts.slice(0, 10), ok: h1Ok },
    headingOutline,
    headingSkips,
    images: { total: imgTotal, missingAlt: imgMissingAlt, emptyAlt: imgEmptyAlt },
    links: { internal, external, nofollow, total: totalLinks },
    wordCount,
    openGraph: { hasTitle: ogTitle, hasDescription: ogDesc, hasImage: ogImage },
    twitterCard: { hasCard: Boolean(twCard), type: twCard },
    schemaTypes: Array.from(schemaTypes),
    hreflangCount,
    issues,
  };

  return {
    output: result,
    durationMs: Date.now() - start,
    ...(issues.filter((i) => i.severity === 'critical').length > 0
      ? {
          warnings: issues
            .filter((i) => i.severity === 'critical')
            .map((i) => `${i.code}: ${i.message}`),
        }
      : {}),
  };
};

export const seoAuditNode: NodeModule = {
  def: {
    id: 'action_seo_audit',
    type: 'action',
    label: 'SEO Audit (full page)',
    icon: 'shield',
    color: '#16a34a',
    description:
      'Audit SEO completo on-page con scoring deterministico 0-100 e grade A-F. ' +
      'Valuta: title length (ok 20-60 char), description length (ok 50-160), H1 count ' +
      '(esattamente 1), heading hierarchy (rileva i salti di livello, es. h1→h3), ' +
      'canonical, lang attribute, robots directive (noindex), alt immagini (count + ' +
      'missing), conteggio link interni/esterni con nofollow, Open Graph (title/' +
      'description/image), Twitter Card, Schema.org JSON-LD type detection, hreflang ' +
      'count, viewport meta (mobile-friendly), theme-color e favicon (estratti). Zero ' +
      'network — parsing locale via cheerio. Cap difensivi: 1000 immagini, 5000 link.\n\n' +
      'Differenza con i sibling: action_seo_audit = scoring + issues list (HTML in → ' +
      'score + grade + report). Per parsing meta tag senza scoring usa ' +
      'action_meta_extract (raw structured data). Per density specifica keyword usa ' +
      'action_keyword_density. Per link broken check usa action_link_audit (con HTTP ' +
      'HEAD probe). Per redirect chain audit usa action_redirect_chain.\n\n' +
      'Scoring deterministico (NO LLM drift): lo stesso HTML → SEMPRE lo stesso score ' +
      '(audit-friendly per prove riproducibili). Issues classificati per severity con ' +
      'peso fisso: **critical** (title/description/H1 mancante, noindex = -15 ognuno), ' +
      '**warning** (title/description fuori range, MULTIPLE_H1, IMG_MISSING_ALT, ' +
      'NO_CANONICAL, NO_LANG, HEADING_SKIP = -5), **info** (LOW_WORD_COUNT, NO_OG_*, ' +
      'NO_VIEWPORT = -1). Codici machine-readable: NO_TITLE, TITLE_TOO_SHORT, ' +
      'TITLE_TOO_LONG, NO_DESCRIPTION, NO_CANONICAL, NO_H1, MULTIPLE_H1, NOINDEX, ' +
      'HEADING_SKIP, IMG_MISSING_ALT, NO_VIEWPORT, … (alcuni con `evidence`).\n\n' +
      'Output: `{ url, score (0-100), grade ("A".."F"), title: {value,length,ok}, ' +
      'description: {...}, canonical: {...}, lang, robots, viewport, themeColor, ' +
      'favicon, h1: {count,texts,ok}, headingOutline, headingSkips, images: ' +
      '{total,missingAlt,emptyAlt}, links: {internal,external,nofollow,total}, ' +
      'wordCount, openGraph, twitterCard, schemaTypes, hreflangCount, issues: ' +
      '[{severity,code,message,evidence?}] }`. Grading: A≥90 / B≥75 / C≥60 / D≥40 / F<40.\n\n' +
      'Use case Cappella-Sistina-grade: (1) **audit SEO settimanale** propri 50 ' +
      'landing — cron loop fetch → seo_audit → store score in DB → trend chart ' +
      'dashboard (score migliora nel tempo? regressioni dopo deploy?); (2) **gate ' +
      'CI/CD pre-deploy** — il workflow build chiama seo_audit su pagina nuova, ' +
      'se score < 80 blocca deploy con report PR comment GitHub; (3) **client ' +
      'reporting agenzia SEO** — mensile fetch + audit, PDF report con grade + ' +
      'top 10 issues + raccomandazioni testuali → email cliente; (4) **A/B test ' +
      'SEO impact** — variant A con tag attuali, variant B con title rewritten, ' +
      'audit entrambi → confronto deterministico score.\n\n' +
      'Safety budget: HTML parse max 5 MB, regex parser timeout 100ms anti-ReDoS, ' +
      'image count cap 1000 (alt check), link count cap 5000, audit log con URL hash ' +
      '+ score + issues count.',
    outputContract: {
      notes: 'Su un HTML vuoto NON fallisce: escono `matched` falso e `warnings`, e nessuno degli altri campi. `issues` e` la parte utile — `score` e `grade` da soli non dicono cosa correggere.',
      fields: [
        { name: 'url', type: 'string', desc: 'La pagina esaminata.' },
        { name: 'score', type: 'number', desc: 'Il punteggio complessivo.' },
        { name: 'grade', type: 'string', desc: 'Il voto corrispondente al punteggio.' },
        { name: 'title', type: 'object', desc: 'Il titolo, con la sua lunghezza e se va bene.' },
        { name: 'description', type: 'object', desc: 'La descrizione, con la sua lunghezza e se va bene.' },
        { name: 'canonical', type: 'object', desc: 'L\'indirizzo canonico e se e` dichiarato.' },
        { name: 'lang', type: 'string|null', desc: 'La lingua dichiarata.' },
        { name: 'robots', type: 'string|null', desc: 'Le istruzioni per i motori di ricerca.' },
        { name: 'viewport', type: 'string|null', desc: 'Le impostazioni di visualizzazione mobile.' },
        { name: 'themeColor', type: 'string|null', desc: 'Il colore dichiarato per l\'interfaccia.' },
        { name: 'favicon', type: 'string|null', desc: 'L\'icona del sito.' },
        { name: 'h1', type: 'object', desc: 'I titoli principali trovati e se sono in numero giusto.' },
        { name: 'headingOutline', type: 'array', desc: 'La struttura dei titoli, in ordine.' },
        { name: 'headingSkips', type: 'array', desc: 'I salti di livello nei titoli: sono errori di struttura.' },
        { name: 'images', type: 'object', desc: 'Le immagini e quante sono senza testo alternativo.' },
        { name: 'links', type: 'object', desc: 'Il conto dei collegamenti interni ed esterni.' },
        { name: 'wordCount', type: 'number', desc: 'Quante parole ha la pagina.' },
        { name: 'openGraph', type: 'object', desc: 'I dati per le anteprime sui social.' },
        { name: 'twitterCard', type: 'object', desc: 'I dati per le anteprime su Twitter.' },
        { name: 'schemaTypes', type: 'array', desc: 'I tipi di dati strutturati dichiarati.' },
        { name: 'hreflangCount', type: 'number', desc: 'Quante versioni in altre lingue sono dichiarate.' },
        { name: 'issues', type: 'array', desc: 'I problemi trovati, con gravita` e codice: e` la parte su cui si agisce.' },
        { name: 'matched', type: 'boolean', desc: 'Presente e falso SOLO quando l\'HTML era vuoto.' },
        { name: 'warnings', type: 'array', desc: 'Gli avvisi. Presente quando ce ne sono.' },
      ],
    },
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
        help: 'input = HTML dal nodo precedente. explicit = HTML statico per testing.',
      },
      {
        key: 'htmlExplicit',
        label: 'HTML (esplicito)',
        type: 'code',
        language: 'json',
        required: false,
        showIf: { field: 'htmlSource', equals: 'explicit' },
        help: 'HTML statico per testing manuale.',
      },
    ],
    outputs: [
      'url',
      'score',
      'grade',
      'title',
      'description',
      'canonical',
      'lang',
      'robots',
      'viewport',
      'themeColor',
      'favicon',
      'h1',
      'headingOutline',
      'headingSkips',
      'images',
      'links',
      'wordCount',
      'openGraph',
      'twitterCard',
      'schemaTypes',
      'hreflangCount',
      'issues',
    ],
  },
  executor,
};
