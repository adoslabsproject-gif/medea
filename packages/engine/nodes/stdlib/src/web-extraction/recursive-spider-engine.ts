/**
 * Recursive spider — pure engine (in-process, no BYO).
 *
 * Why this is split from the NodeModule wrapper
 * ─────────────────────────────────────────────
 * The crawl loop is a regular async function with deterministic behaviour given
 * options + initial state. Keeping it pure (no NodeDef, no executor wiring,
 * no FlowForge types) lets the tests drive every code path — robots.txt
 * parsing, per-host rate limit, frontier dedup, depth limit, error handling —
 * via in-memory mocks of `safeFetchWithRedirects`. The wrapper file then has
 * a tiny coercion+config layer, easy to read.
 *
 * Why NOT BYO (vs `action_crawler_distributed`)
 * ─────────────────────────────────────────────
 * BYO requires hosting a separate crawler service (Redis queue + workers) and
 * is the right tool for >10k pages with persistence. For typical "mirror my
 * own site" workflows — usually 50-2000 pages — an in-process bounded-
 * concurrency worker pool is far simpler, cheaper to run, and deterministic.
 *
 * Safety budget
 * ─────────────
 *   - `maxPages` hard cap (default 100, max 5000): bounds total work.
 *   - `concurrency` (default 4, max 16): bounds peer-host parallelism.
 *   - `perHostMinDelayMs` (default 500): RFC-friendly rate limit.
 *   - `respectRobots` (default true): fetched `/robots.txt` is cached for the
 *     whole run; failure to fetch → allow-all (intentional: we don't punish a
 *     site that returns 404 on robots).
 *   - SSRF: every outbound HTTP call goes through `@medea/engine-safe-fetch`.
 *
 * @module web-extraction/recursive-spider-engine
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import { load as cheerioLoad } from 'cheerio';

// ─── Robots.txt minimal parser (RFC-friendly) ──────────────────────────────

export interface RobotsRules {
  disallowed: string[];
  crawlDelayMs: number | null;
}

/**
 * Parse robots.txt picking the most specific matching User-Agent group.
 * Matching strategy: an exact-prefix match wins over `*`. Crawl-Delay only
 * picked from the matched group.
 */
export function parseRobotsTxt(text: string, ua: string): RobotsRules {
  const groups = new Map<string, RobotsRules>();
  let current = '*';
  groups.set('*', { disallowed: [], crawlDelayMs: null });

  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (field === 'user-agent') {
      current = value.toLowerCase();
      if (!groups.has(current)) groups.set(current, { disallowed: [], crawlDelayMs: null });
    } else if (field === 'disallow' && value) {
      groups.get(current)!.disallowed.push(value);
    } else if (field === 'crawl-delay' && value) {
      const sec = Number(value);
      if (Number.isFinite(sec) && sec > 0) {
        groups.get(current)!.crawlDelayMs = Math.floor(sec * 1000);
      }
    }
  }
  const uaLower = ua.toLowerCase();
  for (const [agent, rules] of groups) {
    if (agent !== '*' && uaLower.includes(agent)) return rules;
  }
  return groups.get('*')!;
}

export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  for (const disallow of rules.disallowed) {
    if (disallow === '/' && path === '/') return false;
    if (disallow !== '' && disallow !== '/' && path.startsWith(disallow)) return false;
    if (disallow === '/' && path.startsWith('/')) return false;
  }
  return true;
}

// ─── URL helpers ────────────────────────────────────────────────────────────

export function normalizeUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a); const ub = new URL(b);
    return ua.host === ub.host && ua.protocol === ub.protocol;
  } catch { return false; }
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export interface SpiderOptions {
  seeds: readonly string[];
  maxDepth: number;
  maxPages: number;
  sameOriginOnly: boolean;
  allowDomains: readonly string[];
  denyPatterns: readonly RegExp[];
  userAgent: string;
  perHostMinDelayMs: number;
  concurrency: number;
  respectRobots: boolean;
  timeoutMs: number;
}

export interface SpiderPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  links: readonly string[];
  depth: number;
  fetchedAt: string;
  durationMs: number;
  error: string | null;
  /** HTML body only when `text/html` or `application/xhtml+xml`. Empty otherwise. */
  html: string;
}

export interface SpiderResult {
  pages: SpiderPage[];
  stats: { pagesFetched: number; pagesSkippedByRobots: number; errorCount: number; durationMsTotal: number; uniqueHosts: number };
  /** URLs still in the frontier when `maxPages` cap hit — pass-through for resume. */
  frontier: string[];
}

interface FrontierItem { url: string; depth: number }

export async function runSpider(opts: SpiderOptions): Promise<SpiderResult> {
  const start = Date.now();
  const visited = new Set<string>();
  const queue: FrontierItem[] = [];
  const pages: SpiderPage[] = [];
  const hostsSeen = new Set<string>();
  const robotsCache = new Map<string, RobotsRules | null>();
  const hostNextSlot = new Map<string, number>();
  let robotsSkipped = 0;
  let errorCount = 0;

  for (const seed of opts.seeds) {
    const n = normalizeUrl(seed, seed);
    if (n && !visited.has(n)) { visited.add(n); queue.push({ url: n, depth: 0 }); }
  }

  async function getRobots(origin: string): Promise<RobotsRules | null> {
    const cached = robotsCache.get(origin);
    if (cached !== undefined) return cached;
    try {
      const res = await safeFetchWithRedirects(`${origin}/robots.txt`, {
        method: 'GET', headers: { 'User-Agent': opts.userAgent }, timeoutMs: 5_000,
      });
      const rules = res.ok ? parseRobotsTxt(await res.text(), opts.userAgent) : null;
      robotsCache.set(origin, rules); return rules;
    } catch { robotsCache.set(origin, null); return null; }
  }

  async function fetchOne(item: FrontierItem): Promise<void> {
    let parsedUrl: URL;
    try { parsedUrl = new URL(item.url); } catch { return; }
    hostsSeen.add(parsedUrl.host);
    const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;

    if (opts.respectRobots) {
      const rules = await getRobots(origin);
      if (rules && !isPathAllowed(rules, parsedUrl.pathname)) { robotsSkipped++; return; }
    }

    const now = Date.now();
    const nextSlot = hostNextSlot.get(parsedUrl.host) ?? 0;
    if (nextSlot > now) await new Promise<void>((r) => setTimeout(r, nextSlot - now));
    hostNextSlot.set(parsedUrl.host, Date.now() + opts.perHostMinDelayMs);

    const pageStart = Date.now();
    let html = ''; let status = 0; let contentType = ''; let bytes = 0;
    let finalUrl = item.url; let error: string | null = null;
    try {
      const res = await safeFetchWithRedirects(item.url, {
        method: 'GET',
        headers: { 'User-Agent': opts.userAgent, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        timeoutMs: opts.timeoutMs,
      });
      status = res.status; finalUrl = res.url || item.url;
      contentType = res.headers.get('content-type') ?? '';
      if (res.ok && /^text\/html|application\/xhtml/i.test(contentType)) {
        html = await res.text(); bytes = Buffer.byteLength(html, 'utf8');
      } else if (res.ok) {
        // HEAD-equivalent: count bytes but discard body to keep memory bounded.
        const buf = await res.arrayBuffer(); bytes = buf.byteLength;
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); errorCount++; }

    const links: string[] = [];
    if (html) {
      try {
        const $ = cheerioLoad(html);
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href'); if (!href) return;
          const abs = normalizeUrl(href, finalUrl); if (!abs) return;
          if (opts.sameOriginOnly && !sameOrigin(abs, item.url)) return;
          if (opts.allowDomains.length > 0) {
            const h = new URL(abs).host;
            if (!opts.allowDomains.some((d) => h === d || h.endsWith(`.${d}`))) return;
          }
          if (opts.denyPatterns.some((re) => re.test(abs))) return;
          if (!links.includes(abs)) links.push(abs);
        });
      } catch { /* malformed HTML — extract zero links, continue */ }
    }

    pages.push({
      url: item.url, finalUrl, status, contentType, bytes, html,
      links, depth: item.depth, fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - pageStart, error,
    });

    // Enqueue children: cap the queue size at maxPages * 10 as a sanity
    // explosion guard (a sitemap with 100k links would blow heap otherwise).
    // The fetch loop separately enforces `pages.length < maxPages`, so any
    // queued-but-unfetched URLs end up in the returned `frontier` for resume.
    if (item.depth + 1 <= opts.maxDepth) {
      const queueCap = opts.maxPages * 10;
      for (const l of links) {
        if (visited.has(l)) continue;
        if (queue.length >= queueCap) break;
        visited.add(l); queue.push({ url: l, depth: item.depth + 1 });
      }
    }
  }

  // Bounded concurrency worker pool — race + drain pattern keeps the queue
  // hot without `Promise.all` over the entire frontier (which would explode
  // memory and ignore the `maxPages` cap mid-flight).
  const inflight = new Set<Promise<void>>();
  while ((queue.length > 0 || inflight.size > 0) && pages.length < opts.maxPages) {
    while (inflight.size < opts.concurrency && queue.length > 0 && pages.length < opts.maxPages) {
      const item = queue.shift()!;
      const task = fetchOne(item).finally(() => { inflight.delete(task); });
      inflight.add(task);
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight);
  }
  await Promise.allSettled([...inflight]);

  return {
    pages,
    stats: {
      pagesFetched: pages.length,
      pagesSkippedByRobots: robotsSkipped,
      errorCount,
      durationMsTotal: Date.now() - start,
      uniqueHosts: hostsSeen.size,
    },
    frontier: queue.map((q) => q.url),
  };
}
