/**
 * `action_html_mirror_rewrite` — turn a fetched HTML page into an offline-
 * navigable copy by rewriting absolute URLs to local paths.
 *
 * Companion node of `action_recursive_spider` + `action_asset_batch_download`.
 * Typical pipeline:
 *
 *   spider → pages[]            ────┐
 *   loop pages → extract assets ────┘
 *     ↓
 *   asset_batch_download → assetMap (url → /opt/mirror/.../logo.png)
 *     ↓
 *   loop pages → html_mirror_rewrite(html, pageUrl, assetMap, baseLocalPath)
 *     ↓
 *   loop pages → file_write(savePath, html)
 *
 * What gets rewritten
 * ───────────────────
 *   - `<a href>`, `<link href>`
 *   - `<img src>`, `<img srcset>` (multi-URL with descriptors)
 *   - `<source src>`, `<source srcset>` (picture / video / audio)
 *   - `<script src>`, `<video poster>`, `<iframe src>`, `<audio src>`
 *   - Inline `<style>` blocks: `url(...)` rules
 *   - `style=""` attributes on any element
 *
 * What is left untouched
 * ──────────────────────
 *   - `data:`, `mailto:`, `tel:`, `javascript:`, `blob:` URIs
 *   - Fragment-only links (`#section`)
 *   - URLs not present in the assetMap (kept as absolute — useful so the
 *     mirror keeps "external" links pointing to the live web).
 *
 * @module web-extraction/html-mirror-rewrite
 */

import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

/**
 * path.relative() per due path ASSOLUTI POSIX, in puro JS (zero `node:path`).
 * Tenere il nodo browser-safe è un invariante: l'editor importa l'intero
 * catalogo nodi per i metadata e NON deve trascinare moduli Node nel bundle
 * (vedi guard `nodes-browser-safe.test.ts`). htmlSaveDir e fsPath sono sempre
 * path assoluti del filesystem server, già normalizzati.
 */
export function relativePosix(from: string, to: string): string {
  const norm = (p: string): string[] => p.split('/').filter((s) => s !== '' && s !== '.');
  const f = norm(from);
  const t = norm(to);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i += 1;
  const up: string[] = new Array<string>(f.length - i).fill('..');
  return [...up, ...t.slice(i)].join('/');
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export interface RewriteOptions {
  /** Absolute URL of the page being rewritten — base for resolving relatives. */
  pageUrl: string;
  /** Map URL → savePath (absolute filesystem path). Output of asset-batch-download. */
  assetMap: Readonly<Record<string, string>>;
  /** Absolute directory where the rewritten HTML will be saved. Local paths
   * in the rewritten output are computed relative to THIS directory.
   * Example: page at `/opt/mirror/blog/post1/index.html`, asset at
   * `/opt/mirror/assets/img/x.png` → rewritten to `../../assets/img/x.png`. */
  htmlSaveDir: string;
  /** Drop query string from rewritten URLs. Default true. */
  stripQuery: boolean;
  /** Drop fragment from rewritten URLs. Default false (fragments are anchors). */
  stripFragment: boolean;
}

export interface RewriteStats {
  rewritten: number;
  unchanged: number;
  skippedScheme: number;
}

export interface RewriteResult { html: string; stats: RewriteStats }

const SKIP_SCHEMES = /^(?:data:|mailto:|tel:|javascript:|blob:|sms:|chrome-extension:)/i;

/** Resolve a possibly-relative URL against the page; null if invalid/unsafe. */
function resolveAbs(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) return null; // fragment-only — keep verbatim
  if (SKIP_SCHEMES.test(trimmed)) return null;
  try { return new URL(trimmed, pageUrl).toString(); } catch { return null; }
}

/**
 * Map an absolute URL to a local file path via the assetMap, then convert
 * that filesystem path into a relative href the HTML saved at `htmlSaveDir`
 * can use directly in a browser opening `file://...`.
 */
function toLocalHref(absUrl: string, opts: RewriteOptions): string | null {
  // Normalize the lookup key: strip fragment + (optionally) query so the
  // assetMap can be keyed on the canonical asset URL, not on every variant.
  const u = new URL(absUrl);
  const fragment = opts.stripFragment ? '' : u.hash;
  const query = opts.stripQuery ? '' : u.search;
  const canonicalKey = `${u.origin}${u.pathname}${u.search}${u.hash}`;
  const lookupKey = `${u.origin}${u.pathname}${u.search}`;
  const fsPath = opts.assetMap[canonicalKey] ?? opts.assetMap[lookupKey] ?? opts.assetMap[`${u.origin}${u.pathname}`];
  if (!fsPath) return null;
  let rel = relativePosix(opts.htmlSaveDir, fsPath);
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = `./${rel}`;
  return rel + query + fragment;
}

/** Rewrite a `srcset` attribute (comma-separated url+descriptor pairs). */
function rewriteSrcset(srcset: string, opts: RewriteOptions): { value: string; rewritten: number } {
  let rewritten = 0;
  const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const splitAt = part.search(/\s+/);
    const url = splitAt < 0 ? part : part.slice(0, splitAt);
    const descriptor = splitAt < 0 ? '' : part.slice(splitAt).trim();
    const abs = resolveAbs(url, opts.pageUrl);
    if (!abs) { out.push(part); continue; }
    const local = toLocalHref(abs, opts);
    if (local) { rewritten++; out.push(descriptor ? `${local} ${descriptor}` : local); }
    else out.push(part);
  }
  return { value: out.join(', '), rewritten };
}

/** Rewrite all `url(...)` occurrences inside a CSS chunk (style block or style attr). */
function rewriteCssUrls(css: string, opts: RewriteOptions): { value: string; rewritten: number } {
  let rewritten = 0;
  const out = css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (whole, quote: string, url: string) => {
    const abs = resolveAbs(url, opts.pageUrl);
    if (!abs) return whole;
    const local = toLocalHref(abs, opts);
    if (!local) return whole;
    rewritten++;
    return `url(${quote}${local}${quote})`;
  });
  return { value: out, rewritten };
}

const SINGLE_ATTRS: readonly { sel: string; attr: string }[] = [
  { sel: 'a[href]', attr: 'href' },
  { sel: 'link[href]', attr: 'href' },
  { sel: 'img[src]', attr: 'src' },
  { sel: 'script[src]', attr: 'src' },
  { sel: 'source[src]', attr: 'src' },
  { sel: 'video[poster]', attr: 'poster' },
  { sel: 'video[src]', attr: 'src' },
  { sel: 'audio[src]', attr: 'src' },
  { sel: 'iframe[src]', attr: 'src' },
  { sel: 'embed[src]', attr: 'src' },
  { sel: 'object[data]', attr: 'data' },
];
const SRCSET_ATTRS: readonly { sel: string; attr: string }[] = [
  { sel: 'img[srcset]', attr: 'srcset' },
  { sel: 'source[srcset]', attr: 'srcset' },
];

export function rewriteHtml(html: string, opts: RewriteOptions): RewriteResult {
  const stats: RewriteStats = { rewritten: 0, unchanged: 0, skippedScheme: 0 };
  const $ = cheerioLoad(html);

  for (const { sel, attr } of SINGLE_ATTRS) {
    $(sel).each((_i, el) => {
      const raw = $(el).attr(attr); if (!raw) return;
      if (raw.startsWith('#')) { stats.unchanged++; return; }
      if (SKIP_SCHEMES.test(raw.trim())) { stats.skippedScheme++; return; }
      const abs = resolveAbs(raw, opts.pageUrl);
      if (!abs) { stats.unchanged++; return; }
      const local = toLocalHref(abs, opts);
      if (local) { $(el).attr(attr, local); stats.rewritten++; }
      else stats.unchanged++;
    });
  }
  for (const { sel, attr } of SRCSET_ATTRS) {
    $(sel).each((_i, el) => {
      const raw = $(el).attr(attr); if (!raw) return;
      const r = rewriteSrcset(raw, opts);
      $(el).attr(attr, r.value);
      stats.rewritten += r.rewritten;
      if (r.rewritten === 0) stats.unchanged++;
    });
  }
  // <style> blocks
  $('style').each((_i, el) => {
    const css = $(el).html(); if (!css) return;
    const r = rewriteCssUrls(css, opts);
    if (r.rewritten > 0) { $(el).html(r.value); stats.rewritten += r.rewritten; }
  });
  // style="" attributes on any element
  $('[style]').each((_i, el) => {
    const css = $(el).attr('style'); if (!css) return;
    const r = rewriteCssUrls(css, opts);
    if (r.rewritten > 0) { $(el).attr('style', r.value); stats.rewritten += r.rewritten; }
  });

  return { html: $.html(), stats };
}

// ─── NodeModule wrapper ────────────────────────────────────────────────────

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return def;
}

function parseAssetMap(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parseAssetMap(parsed);
    } catch { return {}; }
  }
  return {};
}

const executor: NodeExecutor = async (config) => {
  const html = String(config.html ?? '');
  if (!html) throw new Error('html required (string)');
  const pageUrl = String(config.pageUrl ?? '').trim();
  if (!pageUrl) throw new Error('pageUrl required (absolute URL of the source page)');
  if (!/^https?:\/\//i.test(pageUrl)) throw new Error('pageUrl must be http(s)://');
  const htmlSaveDir = String(config.htmlSaveDir ?? '').trim();
  if (!htmlSaveDir) throw new Error('htmlSaveDir required (absolute filesystem path where rewritten HTML will live)');
  if (!htmlSaveDir.startsWith('/')) throw new Error('htmlSaveDir must be an absolute path');

  const assetMap = parseAssetMap(config.assetMap);
  const start = Date.now();
  const out = rewriteHtml(html, {
    pageUrl, assetMap, htmlSaveDir,
    stripQuery: asBool(config.stripQuery, true),
    stripFragment: asBool(config.stripFragment, false),
  });

  return { output: { ...out, assetMapSize: Object.keys(assetMap).length }, durationMs: Date.now() - start };
};

export const htmlMirrorRewriteNode: NodeModule = {
  executor,
  def: {
    id: 'action_html_mirror_rewrite',
    type: 'action',
    label: 'HTML Mirror Rewrite',
    icon: 'file-symlink',
    color: '#16a34a',
    description:
      'Riscrive un HTML per la navigazione offline come fa wget --mirror: trasforma URL assoluti di asset (img/css/js/video/iframe) in path locali relativi, in base alla mappa assetMap (output di action_asset_batch_download). ' +
      'Riscrive: a[href], link[href], img[src+srcset], script[src], source[src+srcset], video[src+poster], audio[src], iframe[src], embed[src], object[data], CSS url(...) inline (<style> blocks + style attribute). ' +
      'NON riscrive: data:/mailto:/tel:/javascript:/blob: URIs, fragment-only links (#anchor), URL non presenti in assetMap (preservati assoluti — utile per link "external" verso il web live). ' +
      'Use case: pipeline mirror completo (spider → asset download → mirror rewrite → file_write), backup statico navigabile, snapshot legale di una pagina. ' +
      'Output: html riscritto + stats {rewritten, unchanged, skippedScheme} per audit.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      { key: 'html', label: 'HTML sorgente', type: 'textarea', required: true,
        placeholder: '{{$node.spider.json.pages[0].html}}',
        help: 'HTML completo della pagina. Tipicamente da action_recursive_spider o action_web_fetch_advanced.' },
      { key: 'pageUrl', label: 'URL pagina sorgente', type: 'text', required: true,
        placeholder: 'https://example.com/blog/post-1/',
        help: 'URL assoluto della pagina originale. Necessario per risolvere link relativi prima di mapparli.' },
      { key: 'htmlSaveDir', label: 'Directory dove salverai l\'HTML', type: 'text', required: true,
        placeholder: '/opt/mirror/zelistore.it/blog/post-1',
        help: 'Path assoluto della cartella in cui scriverai l\'HTML output. Tutti i link locali vengono calcolati relativi a QUESTA directory.' },
      { key: 'assetMap', label: 'Asset map (url → local path)', type: 'json', required: false, defaultValue: '{}',
        help: 'JSON object {url assoluto: percorso filesystem}. Tipicamente {{$node.asset_download.json.stats.assetMap}}. URL non in mappa restano assoluti.' },
      { key: 'stripQuery', label: 'Rimuovi query string', type: 'boolean', required: false, defaultValue: 'true',
        help: 'Se ON, i path locali NON includono "?foo=bar". Default ON perché le query non hanno senso su file:// locale.' },
      { key: 'stripFragment', label: 'Rimuovi fragment (#anchor)', type: 'boolean', required: false, defaultValue: 'false',
        help: 'Se OFF (default), i "#anchor" vengono preservati — VLC/browser li onorano anche su file://. ON solo per output puramente statico.' },
    ],
  },
};
