/**
 * `news_display` — executor.
 *
 * Parser XML minimo per RSS 2.0 + Atom 1.0 (cheerio xml-mode).
 * Cache 5min per feedUrl. SSRF guard via @medea/engine-safe-fetch.
 *
 * @module executors/news
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor, NodeExecutionResult } from '@medea/engine-nodes-stdlib';
import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import { readTextTruncated } from '@/lib/capped-response.js';
import { load as cheerioLoad } from 'cheerio';

interface NewsItem {
  title: string;
  link: string;
  pubDate: string | null;
  pubTimestamp: number | null;
  snippet: string;
  author: string | null;
  categories: string[];
}

interface NewsOutput {
  feed: { title: string; link: string; description: string; lang: string };
  items: NewsItem[];
  count: number;
  markdown?: string;
  html?: string;
}

interface CacheEntry { value: NewsOutput; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max = 280): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function parseDate(raw: string | null | undefined): { iso: string | null; ts: number | null } {
  if (!raw) return { iso: null, ts: null };
  const d = new Date(raw);
  if (isNaN(d.getTime())) return { iso: raw, ts: null };
  return { iso: d.toISOString(), ts: d.getTime() };
}

export function parseFeed(xml: string): { feed: NewsOutput['feed']; items: NewsItem[] } {
  const $ = cheerioLoad(xml, { xmlMode: true });
  const isAtom = $('feed').length > 0 && $('feed entry').length > 0;
  const isRss = $('rss channel').length > 0 || $('channel item').length > 0;

  if (!isAtom && !isRss) {
    throw new Error('news_display: feed XML non riconosciuto come RSS 2.0 o Atom 1.0');
  }

  let feedMeta: NewsOutput['feed'];
  const items: NewsItem[] = [];

  if (isAtom) {
    const feed = $('feed').first();
    feedMeta = {
      title: feed.children('title').first().text().trim(),
      link: feed.children("link[rel='alternate']").attr('href') ?? feed.children('link').attr('href') ?? '',
      description: feed.children('subtitle').first().text().trim(),
      lang: feed.attr('xml:lang') ?? '',
    };
    feed.find('entry').each((_, el) => {
      const e = $(el);
      const title = e.find('title').first().text().trim();
      const link = e.find("link[rel='alternate']").attr('href') ?? e.find('link').attr('href') ?? '';
      const pubRaw = e.find('updated').first().text().trim() || e.find('published').first().text().trim();
      const { iso, ts } = parseDate(pubRaw);
      const summary = e.find('summary').first().text() || e.find('content').first().text();
      const author = e.find('author > name').first().text().trim();
      const cats: string[] = [];
      e.find('category').each((_i, c) => {
        const term = $(c).attr('term') ?? $(c).text().trim();
        if (term) cats.push(term);
      });
      items.push({
        title, link, pubDate: iso, pubTimestamp: ts,
        snippet: truncate(stripHtml(summary), 280),
        author: author || null,
        categories: cats,
      });
    });
  } else {
    const channel = $('rss channel').first().length > 0 ? $('rss channel').first() : $('channel').first();
    feedMeta = {
      title: channel.children('title').first().text().trim(),
      link: channel.children('link').first().text().trim(),
      description: channel.children('description').first().text().trim(),
      lang: channel.children('language').first().text().trim(),
    };
    channel.find('item').each((_, el) => {
      const e = $(el);
      const title = e.find('title').first().text().trim();
      const link = e.find('link').first().text().trim() || e.find('guid').first().text().trim();
      const pubRaw = e.find('pubDate').first().text().trim() || e.find('dc\\:date,date').first().text().trim();
      const { iso, ts } = parseDate(pubRaw);
      const description = e.find('description').first().text() || e.find('content\\:encoded').first().text();
      const author = e.find('author').first().text().trim() || e.find('dc\\:creator,creator').first().text().trim();
      const cats: string[] = [];
      e.find('category').each((_i, c) => {
        const term = $(c).text().trim();
        if (term) cats.push(term);
      });
      items.push({
        title, link, pubDate: iso, pubTimestamp: ts,
        snippet: truncate(stripHtml(description), 280),
        author: author || null,
        categories: cats,
      });
    });
  }

  return { feed: feedMeta, items };
}

function renderMarkdown(items: NewsItem[]): string {
  return items.map((it) => {
    const date = it.pubDate ? ` _(${it.pubDate.slice(0, 10)})_` : '';
    const snippet = it.snippet ? `\n  ${it.snippet}` : '';
    return `- **[${it.title}](${it.link})**${date}${snippet}`;
  }).join('\n');
}

function renderHtml(items: NewsItem[]): string {
  const li = items.map((it) => {
    const date = it.pubDate ? ` <span style="color:#999">(${it.pubDate.slice(0, 10)})</span>` : '';
    const snippet = it.snippet ? `<br><span style="font-size:0.9em">${it.snippet}</span>` : '';
    return `  <li><a href="${it.link}"><strong>${it.title}</strong></a>${date}${snippet}</li>`;
  }).join('\n');
  return `<ul>\n${li}\n</ul>`;
}

export const newsDisplayExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const feedUrl = coerceString(cfg.feedUrl ?? '').trim();
  if (!feedUrl) throw new Error('news_display: "feedUrl" e\\` obbligatorio');

  const limitRaw = Number(cfg.limit ?? 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 100)) : 10;
  const renderFormat: 'none' | 'markdown' | 'html' = cfg.renderFormat === 'markdown' ? 'markdown' : cfg.renderFormat === 'html' ? 'html' : 'none';
  const sinceHoursRaw = Number(cfg.sinceHours ?? NaN);
  const sinceHours = Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0 ? Math.floor(sinceHoursRaw) : null;
  const timeoutMsRaw = Number(cfg.timeoutMs ?? 10_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? Math.min(Math.floor(timeoutMsRaw), 60_000)
    : 10_000;

  const cacheKey = `${feedUrl}|${limit.toString()}|${renderFormat}|${sinceHours?.toString() ?? '-'}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { output: cached.value, durationMs: Date.now() - start };
  }

  let xml: string;
  try {
    const res = await safeFetchWithRedirects(feedUrl, {
      method: 'GET',
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'user-agent': 'FlowForge-News/1.0 (+https://flowforge.io)',
      },
      timeoutMs,
      signal: context.abortSignal ?? AbortSignal.timeout(timeoutMs),
    } as never);
    if (!res.ok) throw new Error(`news_display: HTTP ${String(res.status)} fetching feed`);
    // Cap streaming anti-OOM: un feed malevolo da centinaia di MB non va bufferizzato
    // (5MB è enorme per un RSS/Atom legittimo, anche full-text).
    xml = (await readTextTruncated(res, 5 * 1024 * 1024)).text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`news_display: fetch fallito — ${msg}`);
  }

  const { feed, items: allItems } = parseFeed(xml);

  let items = allItems;
  if (sinceHours !== null) {
    const cutoff = Date.now() - sinceHours * 3600 * 1000;
    items = items.filter((it) => it.pubTimestamp !== null && it.pubTimestamp >= cutoff);
  }
  items = items.slice(0, limit);

  const output: NewsOutput = { feed, items, count: items.length };
  if (renderFormat === 'markdown') output.markdown = renderMarkdown(items);
  if (renderFormat === 'html') output.html = renderHtml(items);

  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, { value: output, expiresAt: Date.now() + CACHE_TTL_MS });

  return { output, durationMs: Date.now() - start } satisfies NodeExecutionResult;
};

export const __test__ = { parseFeed, renderMarkdown, renderHtml, parseDate, stripHtml, truncate, clearCache: (): void => cache.clear() };
