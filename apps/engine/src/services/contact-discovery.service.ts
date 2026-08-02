/**
 * Contact Discovery — mini-agente di crawling focalizzato su scoperta contatti.
 *
 * COSA FA (paragonabile a Hunter.io / Apollo / Clay):
 *   Dato l'URL homepage di un'azienda, NAVIGA il sito seguendo i link più
 *   probabili per arrivare a una pagina contatti, finché non trova almeno
 *   una email business valida. NON è un crawler greedy: massimo 5 pagine per
 *   dominio, rispetta robots.txt, max 30s per dominio, cache LRU 7d.
 *
 * STRATEGIA (in ordine, stop appena trova email valide):
 *
 *   1. Cache hit (7d TTL per domain)
 *   2. robots.txt fetch + parse → blocca path disallowed
 *   3. Fetch homepage → harvestEmails (spesso il footer ha info@/mail to:)
 *   4. Estrai link interni (stesso host), prioritizza per:
 *      - path keyword score (es. /contatti, /kontakt, /contact-us) 14 lingue
 *      - anchor text keyword score (es. "Scrivici", "Get in touch")
 *   5. Visita top-N pagine prioritarie → harvest su ognuna
 *   6. Fallback sitemap.xml → cerca URL con keyword contatti
 *   7. Fallback finale: DDG "site:domain contatti email" → fetch primo URL
 *
 * MULTI-LINGUA NATIVO: il vocabolario di priorità include 14 lingue
 * (IT, EN, DE, FR, ES, PT, NL, EL, SE, NO, DK, FI, IS, HR).
 *
 * ANTI-ABUSE:
 *   - Rate limit per host: max 2 req/sec (semaphore in-memory)
 *   - Total timeout: 30s per dominio (default)
 *   - Max pages: 5 (default)
 *   - User-Agent dichiarato (no spoofing aggressivo)
 *   - Respect robots.txt (User-agent: * disallow check)
 *
 * OUTPUT (per nodo workflow):
 *   {
 *     emails: HarvestedEmail[],     // tutte le email trovate dedupplicate
 *     primary_email: string | null,
 *     source_page: string | null,   // URL della pagina dove sono state trovate
 *     pages_visited: number,
 *     paths_tried: string[],        // log dei path tentati (debug)
 *     domain: string,
 *     took_ms: number,
 *     cache_hit: boolean,
 *     reason_if_empty?: string,
 *   }
 *
 * NON USIAMO il `fetchUrl()` di web-tools.service.ts perché quello strippa
 * <footer> via cheerio (rimosso per leggibilità LLM) — ma le email aziendali
 * vivono SPESSO nel footer. Qui abbiamo un fetcher raw HTML-preserving.
 */

import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { harvestEmails, type HarvestedEmail } from './email-harvest.service.js';
import { webSearch } from './web-tools.service.js';
import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readTextTruncated } from '@/lib/capped-response.js';

// ─────────────────────────────────────────────────────────────────────────
// Configurazione
// ─────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 500_000; // 500 KB — pagine ricche di link possono essere grandi
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 giorni
const CACHE_MAX_ENTRIES = 5000;
const RATE_LIMIT_PER_HOST_MS = 500; // 2 req/sec per host

const USER_AGENT = process.env.MEDEA_BOT_UA
  ?? 'FlowForgeContactDiscovery/1.0 (+https://flowforge.io/bot; respectful crawler)';

// ─────────────────────────────────────────────────────────────────────────
// Vocabolario keyword contatti — 14 lingue, peso decrescente
// (path match vale 10× anchor match perché path è più indicativo)
// ─────────────────────────────────────────────────────────────────────────

const PATH_KEYWORDS: { pattern: RegExp; weight: number; lang: string }[] = [
  // Esatti "contatti" + sinonimi diretti — peso massimo
  { pattern: /\/(contact-us|contactus|contact_us)(\/|$|\?|#)/i, weight: 100, lang: 'en' },
  { pattern: /\/(contattaci|contatto|contatti)(\/|$|\?|#)/i, weight: 100, lang: 'it' },
  { pattern: /\/(kontakt|kontaktiere-uns|kontakt-aufnehmen)(\/|$|\?|#)/i, weight: 100, lang: 'de' },
  { pattern: /\/(contactez-nous|nous-contacter|contact)(\/|$|\?|#)/i, weight: 100, lang: 'fr' },
  { pattern: /\/(contactenos|contactanos|contacto)(\/|$|\?|#)/i, weight: 100, lang: 'es' },
  { pattern: /\/(contacte-nos|contate-nos|contato|contacto)(\/|$|\?|#)/i, weight: 100, lang: 'pt' },
  { pattern: /\/(neem-contact-op|contact)(\/|$|\?|#)/i, weight: 100, lang: 'nl' },
  { pattern: /\/(epikoinonia)(\/|$|\?|#)/i, weight: 100, lang: 'el' },
  { pattern: /\/(yhteystiedot|ota-yhteytta)(\/|$|\?|#)/i, weight: 100, lang: 'fi' },
  { pattern: /\/(hafdu-samband|tengilidir)(\/|$|\?|#)/i, weight: 100, lang: 'is' },
  // Pattern generico "contact" — copre /contact, /kontakt, /contato in 7+ lingue
  { pattern: /\/(contact|kontakt|contato|contacto|kontaktirajte)(\/|$|\?|#)/i, weight: 90, lang: 'multi' },

  // About / Chi siamo / Impressum — secondo step (a volte info legali → email)
  { pattern: /\/(about-us|aboutus|about_us)(\/|$|\?|#)/i, weight: 70, lang: 'en' },
  { pattern: /\/(chi-siamo|chisiamo|chi_siamo|azienda|societa)(\/|$|\?|#)/i, weight: 70, lang: 'it' },
  { pattern: /\/(uber-uns|ueber-uns|impressum|unternehmen)(\/|$|\?|#)/i, weight: 75, lang: 'de' }, // DE impressum è legalmente obbligatorio
  { pattern: /\/(a-propos|apropos|qui-sommes-nous|entreprise)(\/|$|\?|#)/i, weight: 70, lang: 'fr' },
  { pattern: /\/(sobre-nosotros|nosotros|empresa|quienes-somos)(\/|$|\?|#)/i, weight: 70, lang: 'es' },
  { pattern: /\/(sobre-nos|sobre|empresa)(\/|$|\?|#)/i, weight: 70, lang: 'pt' },
  { pattern: /\/(over-ons|bedrijf|wie-zijn-wij)(\/|$|\?|#)/i, weight: 70, lang: 'nl' },
  { pattern: /\/(om-oss|om-os|om-mig|foretag|virksomhed)(\/|$|\?|#)/i, weight: 70, lang: 'scandi' },
  { pattern: /\/(meista|yritys)(\/|$|\?|#)/i, weight: 70, lang: 'fi' },
  { pattern: /\/(um-okkur|fyrirtaekid)(\/|$|\?|#)/i, weight: 70, lang: 'is' },
  { pattern: /\/(o-nama|tvrtka|poduzece)(\/|$|\?|#)/i, weight: 70, lang: 'hr' },
  { pattern: /\/(about|company|firm)(\/|$|\?|#)/i, weight: 65, lang: 'multi' },

  // Team / People — terzo step (CEO/sales people)
  { pattern: /\/(team|squadra|staff|equipo|equipe|equipa|tiimi|tim)(\/|$|\?|#)/i, weight: 50, lang: 'multi' },

  // Info / Help / Support
  { pattern: /\/(info|informazioni|informationen|informacion|informaties)(\/|$|\?|#)/i, weight: 40, lang: 'multi' },

  // Sales / Commercial
  { pattern: /\/(sales|vendite|ventas|verkauf|forsaljning|myynti)(\/|$|\?|#)/i, weight: 80, lang: 'multi' },
  { pattern: /\/(commerciale|commercial|comercial)(\/|$|\?|#)/i, weight: 80, lang: 'multi' },

  // Generic fallback paths
  { pattern: /\/(privacy|cookie|legal|terms)(\/|$|\?|#)/i, weight: 20, lang: 'multi' },
];

const ANCHOR_KEYWORDS: { pattern: RegExp; weight: number }[] = [
  // Direct contact CTAs
  { pattern: /\b(contattaci|scrivici|contact us|contattare|get in touch|reach (out|us)|nous contacter|contactenos|kontaktieren|hubungi)\b/i, weight: 30 },
  { pattern: /\b(contact|contatto|contatti|kontakt|contato|contacto)\b/i, weight: 25 },
  { pattern: /\b(about|chi siamo|uber uns|qui sommes|sobre nosotros|over ons|om oss|o nama)\b/i, weight: 18 },
  { pattern: /\b(impressum|imprint|legal notice|menzioni legali|mentions legales)\b/i, weight: 22 },
  { pattern: /\b(team|squadra|equipo|equipe|staff)\b/i, weight: 12 },
  { pattern: /\b(info|informazioni|information)\b/i, weight: 8 },
  { pattern: /\b(sales|vendite|commerciale|sales team)\b/i, weight: 20 },
  { pattern: /\b(email|e-mail|posta|courriel)\b/i, weight: 15 },
];

// ─────────────────────────────────────────────────────────────────────────
// Rate limiter per host (anti-abuse + best practice crawling)
// ─────────────────────────────────────────────────────────────────────────

const lastRequestByHost = new Map<string, number>();

async function waitForHostSlot(hostname: string): Promise<void> {
  const last = lastRequestByHost.get(hostname);
  const now = Date.now();
  if (last !== undefined) {
    const elapsed = now - last;
    if (elapsed < RATE_LIMIT_PER_HOST_MS) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_PER_HOST_MS - elapsed));
    }
  }
  lastRequestByHost.set(hostname, Date.now());
  // Garbage collection: rimuove host con last >1h
  if (lastRequestByHost.size > 1000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [h, t] of lastRequestByHost) {
      if (t < cutoff) lastRequestByHost.delete(h);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// LRU cache (in-process, sufficiente per workflow runtime)
// ─────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: ContactDiscoveryResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(url: string): string {
  // Normalizza: scheme://hostname senza path
  try {
    const u = new URL(url);
    return createHash('sha1').update(`${u.protocol}//${u.hostname.toLowerCase()}`).digest('hex');
  } catch {
    return createHash('sha1').update(url).digest('hex');
  }
}

function cacheGet(url: string): ContactDiscoveryResult | null {
  const key = cacheKey(url);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(url: string, result: ContactDiscoveryResult): void {
  const key = cacheKey(url);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest entry (Map preserve insertion order)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─────────────────────────────────────────────────────────────────────────
// robots.txt parser (minimal RFC 9309)
// ─────────────────────────────────────────────────────────────────────────

interface RobotsRules {
  disallow: string[];
  allow: string[];
}

async function fetchRobots(origin: string): Promise<RobotsRules> {
  try {
    const url = `${origin}/robots.txt`;
    // #202 P0-3: SSRF guard anche per robots.txt — `origin` viene dai
    // risultati DDG search (user-controllable). Senza guard, attaccante
    // mette URL malicious in serp → bypass guard via robots.txt fetch.
    const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
    const guard = validateUrlForFetch(url);
    if (!guard.ok) {
      logger.warn({ url, reason: guard.reason }, 'contact-discovery: SSRF block robots');
      return { disallow: [], allow: [] };
    }
    const ctrl = new AbortController();
    const to = setTimeout(() => { ctrl.abort(); }, 5_000);
    const res = await safeOutboundFetch(url, {
      externalSignal: ctrl.signal, timeoutMs: 0,
      redirect: 'manual',         // no redirect su robots.txt — pattern stretto
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(to);
    if (!res.ok) return { disallow: [], allow: [] };
    // Cap in streaming (anti-OOM): un robots.txt malevolo da centinaia di MB non
    // deve essere bufferizzato. 256KB è enorme per un robots.txt legittimo.
    const { text } = await readTextTruncated(res, 256 * 1024);
    return parseRobots(text);
  } catch {
    return { disallow: [], allow: [] };
  }
}

function parseRobots(text: string): RobotsRules {
  // Solo user-agent: * o FlowForgeContactDiscovery — minimal parser
  const lines = text.split(/\r?\n/);
  const rules: RobotsRules = { disallow: [], allow: [] };
  let appliesToUs = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [keyRaw, ...valParts] = line.split(':');
    if (!keyRaw) continue;
    const key = keyRaw.toLowerCase().trim();
    const val = valParts.join(':').trim();
    if (key === 'user-agent') {
      const ua = val.toLowerCase();
      appliesToUs = ua === '*' || ua.includes('flowforge') || ua.includes('contactdiscovery');
    } else if (appliesToUs && key === 'disallow' && val) {
      rules.disallow.push(val);
    } else if (appliesToUs && key === 'allow' && val) {
      rules.allow.push(val);
    }
  }
  return rules;
}

function isAllowedByRobots(rules: RobotsRules, pathname: string): boolean {
  // Allow ha precedenza su Disallow (RFC 9309 longest-match)
  const allowMatch = rules.allow.find((p) => pathname.startsWith(p));
  const disallowMatch = rules.disallow.find((p) => pathname.startsWith(p));
  if (!disallowMatch) return true;
  if (!allowMatch) return false;
  return allowMatch.length >= disallowMatch.length;
}

// ─────────────────────────────────────────────────────────────────────────
// Fetcher raw (preserva footer per email harvesting)
// ─────────────────────────────────────────────────────────────────────────

interface RawFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  html: string;
}

async function fetchRaw(url: string, signal?: AbortSignal): Promise<RawFetchResult | null> {
  try {
    // #202 P0-3: SSRF guard — la URL può venire da DDG search → contenuto
    // user-controllable. Senza guard, attaccante mette in serp un link a
    // http://169.254.169.254/ (IMDS) → leak cred IAM.
    const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
    const guard = validateUrlForFetch(url);
    if (!guard.ok) {
      logger.warn({ url, reason: guard.reason }, 'contact-discovery: SSRF block');
      return null;
    }
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return null;

    await waitForHostSlot(u.hostname);

    const ctrl = new AbortController();
    const to = setTimeout(() => { ctrl.abort(); }, FETCH_TIMEOUT_MS);

    // Inoltra abort dal segnale parent
    const onParentAbort = () => { ctrl.abort(); };
    signal?.addEventListener('abort', onParentAbort);

    try {
      // #202 P0-3: redirect manual + re-validate Location PRIMA di re-fetch.
      // Senza questo, fetch nativo segue Location header → server malicious
      // 302 → http://10.0.0.1/admin bypassa il guard iniziale.
      let currentUrl = u.toString();
      let res: Response | null = null;
      const MAX_HOPS = 5;
      for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
        res = await safeOutboundFetch(currentUrl, {
          externalSignal: ctrl.signal, timeoutMs: 0,
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.5',
            'Accept-Language': 'it,en;q=0.9,de;q=0.5',
          },
        });
        if (res.status < 300 || res.status >= 400 || !res.headers.has('location')) break;
        if (hop === MAX_HOPS) break;
        const nextRaw = res.headers.get('location') ?? '';
        let nextUrl: string;
        try { nextUrl = new URL(nextRaw, currentUrl).toString(); } catch { break; }
        const hopGuard = validateUrlForFetch(nextUrl);
        if (!hopGuard.ok) {
          logger.warn({ from: currentUrl, to: nextUrl, reason: hopGuard.reason }, 'contact-discovery: redirect blocked (SSRF)');
          return null;
        }
        // Drain del corpo 3xx SENZA leggerlo: res.text() lo bufferizzerebbe TUTTO
        // (un redirect con body enorme → OOM). cancel() scarta lo stream e libera l'FD.
        try { await res.body?.cancel(); } catch { /* best-effort */ }
        currentUrl = nextUrl;
      }
      if (!res) return null;
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!res.ok && res.status !== 304) {
        return { status: res.status, finalUrl: res.url, contentType, html: '' };
      }
      // Cap a 500KB IN STREAMING: prima `arrayBuffer()` bufferizzava l'INTERO body e
      // solo dopo tagliava → il cap era cosmetico, l'OOM avveniva sul read. Ora il
      // taglio avviene durante il download (mai più di MAX_FETCH_BYTES in RAM).
      const { text: html } = await readTextTruncated(res, MAX_FETCH_BYTES);
      return { status: res.status, finalUrl: res.url, contentType, html };
    } finally {
      clearTimeout(to);
      signal?.removeEventListener('abort', onParentAbort);
    }
  } catch (e) {
    logger.debug({ err: e, url }, 'contact-discovery: fetch fallita');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Estrazione link interni + scoring priorità
// ─────────────────────────────────────────────────────────────────────────

interface ScoredLink {
  url: string;
  score: number;
  anchor: string;
  reason: string;
}

function extractAndScoreLinks(html: string, baseUrl: string): ScoredLink[] {
  let baseOrigin: string;
  try { baseOrigin = new URL(baseUrl).origin; }
  catch { return []; }

  const $ = cheerio.load(html);
  const map = new Map<string, ScoredLink>();

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
      return;
    }
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    // Solo same-origin
    let absUrl: URL;
    try { absUrl = new URL(abs); }
    catch { return; }
    if (absUrl.origin !== baseOrigin) return;
    // Strip fragment + query non rilevanti per scoring (mantieni la URL completa per la fetch)
    const normalized = absUrl.origin + absUrl.pathname;
    const anchor = ($(el).text() ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

    let pathScore = 0;
    let pathReason = '';
    for (const { pattern, weight } of PATH_KEYWORDS) {
      if (pattern.test(absUrl.pathname)) {
        if (weight > pathScore) {
          pathScore = weight;
          pathReason = `path~${pattern.source.slice(0, 30)}`;
        }
      }
    }
    let anchorScore = 0;
    let anchorReason = '';
    for (const { pattern, weight } of ANCHOR_KEYWORDS) {
      if (pattern.test(anchor)) {
        if (weight > anchorScore) {
          anchorScore = weight;
          anchorReason = `anchor~${pattern.source.slice(0, 30)}`;
        }
      }
    }
    const totalScore = pathScore * 10 + anchorScore;
    if (totalScore === 0) return;
    const existing = map.get(normalized);
    if (!existing || existing.score < totalScore) {
      map.set(normalized, {
        url: normalized,
        score: totalScore,
        anchor,
        reason: [pathReason, anchorReason].filter(Boolean).join('+'),
      });
    }
  });

  return [...map.values()].sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────
// Sitemap.xml fallback
// ─────────────────────────────────────────────────────────────────────────

async function fetchSitemapCandidates(origin: string, signal?: AbortSignal): Promise<string[]> {
  const candidates: string[] = [];
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-1.xml']) {
    const res = await fetchRaw(`${origin}${path}`, signal);
    if (!res?.html) continue;
    // Parser minimal: estrai <loc>...</loc>
    const matches = res.html.match(/<loc>([^<]+)<\/loc>/gi) ?? [];
    for (const m of matches) {
      const url = m.replace(/<\/?loc>/gi, '').trim();
      if (url) candidates.push(url);
    }
    if (candidates.length > 0) break;
  }
  // Filtra URL candidate plausibili per contatti
  const scored: { url: string; score: number }[] = [];
  for (const u of candidates) {
    try {
      const parsed = new URL(u);
      let pathScore = 0;
      for (const { pattern, weight } of PATH_KEYWORDS) {
        if (pattern.test(parsed.pathname)) {
          pathScore = Math.max(pathScore, weight);
        }
      }
      if (pathScore > 0) scored.push({ url: u, score: pathScore });
    } catch { /* skip */ }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.url);
}

// ─────────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────────

export interface ContactDiscoveryOptions {
  /** Max pagine visitate per dominio (default 5) */
  maxPages?: number;
  /** Total timeout per dominio in ms (default 30000) */
  timeoutMs?: number;
  /** Se true, rispetta robots.txt (default true) */
  respectRobots?: boolean;
  /** Se true, abilita DDG fallback (default true) */
  ddgFallback?: boolean;
  /** Se true, by-pass cache (default false) */
  bypassCache?: boolean;
}

export interface ContactDiscoveryResult {
  emails: HarvestedEmail[];
  primary_email: string | null;
  source_page: string | null;
  pages_visited: number;
  paths_tried: string[];
  domain: string;
  took_ms: number;
  cache_hit: boolean;
  reason_if_empty?: string;
  // ── Standard 2026 enrichment ─────────────────────────────────────────
  /** Nome azienda derivato da og:site_name, <title>, application-name, o fallback titlecase(domain). */
  company_name: string;
  /** Meta description o og:description, sanitizzata. Vuota se assente. */
  description: string;
  /** Lingua HTML (attributo `lang` del tag <html>). Es. "en", "it". */
  site_language: string | null;
  /** Testo pulito (no script/style/tag), primi 4000 caratteri. Utile per personalize/lead_score. */
  content_text: string;
  /** og:image della homepage (URL assoluto). Utile per anteprima visiva nel CRM. */
  og_image: string | null;
}

export async function discoverContacts(
  homeUrl: string,
  options: ContactDiscoveryOptions = {},
): Promise<ContactDiscoveryResult> {
  const start = Date.now();
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const respectRobots = options.respectRobots ?? true;
  const ddgFallback = options.ddgFallback ?? true;

  let parsedHome: URL;
  try { parsedHome = new URL(homeUrl); }
  catch {
    return emptyResult(homeUrl, start, 'invalid_url');
  }
  const origin = parsedHome.origin;
  const domain = parsedHome.hostname.replace(/^www\./i, '');

  // Cache
  if (!options.bypassCache) {
    const hit = cacheGet(homeUrl);
    if (hit) {
      return { ...hit, cache_hit: true, took_ms: 0 };
    }
  }

  // Global abort signal (timeout totale)
  const ctrl = new AbortController();
  const globalTo = setTimeout(() => { ctrl.abort(); }, timeoutMs);

  const pathsTried: string[] = [];
  const visited = new Set<string>();
  const allEmails: HarvestedEmail[] = [];
  // Metadata della homepage — popolato al primo fetch riuscito.
  // Ripieghiamo a default sensibili se non viene mai popolato.
  let homepageMeta: ReturnType<typeof extractHomepageMetadata> | null = null;
  let sourcePage: string | null = null;

  try {
    // Step 1: robots.txt
    const robots = respectRobots ? await fetchRobots(origin) : { disallow: [], allow: [] };

    const tryFetch = async (url: string): Promise<boolean> => {
      if (visited.size >= maxPages) return false;
      let parsed: URL;
      try { parsed = new URL(url); }
      catch { return false; }
      if (visited.has(parsed.origin + parsed.pathname)) return false;
      if (respectRobots && !isAllowedByRobots(robots, parsed.pathname)) {
        pathsTried.push(`${parsed.pathname} [robots:blocked]`);
        return false;
      }
      visited.add(parsed.origin + parsed.pathname);
      pathsTried.push(parsed.pathname);
      const fetchResult = await fetchRaw(url, ctrl.signal);
      if (!fetchResult?.html || fetchResult.status >= 400) {
        return false;
      }
      // Cattura metadata SOLO dalla prima pagina riuscita (di norma homepage)
      homepageMeta ??= extractHomepageMetadata(fetchResult.html, parsed.origin, domain);
      const harvest = harvestEmails(fetchResult.html);
      if (harvest.all_emails.length > 0) {
        for (const e of harvest.all_emails) {
          if (!allEmails.some((x) => x.email === e.email)) {
            allEmails.push(e);
          }
        }
        if (!sourcePage) sourcePage = fetchResult.finalUrl || url;
        return true; // found
      }
      // Estrai link prioritari da questa pagina per il prossimo round
      if (visited.size === 1) {
        // Solo dalla homepage estraiamo i link (le altre pagine seguono già priorità)
        const scoredLinks = extractAndScoreLinks(fetchResult.html, fetchResult.finalUrl || url);
        for (const link of scoredLinks.slice(0, maxPages - 1)) {
          discoveryQueue.push(link);
        }
      }
      return false;
    };

    const discoveryQueue: ScoredLink[] = [];

    // Step 2: fetch homepage
    const homeFound = await tryFetch(parsedHome.toString());

    // Step 3: visita pagine prioritarie scoperte sulla homepage
    if (!homeFound) {
      // Ordina queue per score (extractAndScoreLinks ritorna già ordinato, ma sicuro)
      discoveryQueue.sort((a, b) => b.score - a.score);
      for (const link of discoveryQueue) {
        if (ctrl.signal.aborted) break;
        if (visited.size >= maxPages) break;
        const found = await tryFetch(link.url);
        if (found) break;
      }
    }

    // Step 4: fallback sitemap.xml se ancora nulla
    if (allEmails.length === 0 && !ctrl.signal.aborted && visited.size < maxPages) {
      const sitemapUrls = await fetchSitemapCandidates(origin, ctrl.signal);
      for (const url of sitemapUrls) {
        if (ctrl.signal.aborted) break;
        if (visited.size >= maxPages) break;
        const found = await tryFetch(url);
        if (found) break;
      }
    }

    // Step 5: fallback DDG site search
    if (allEmails.length === 0 && ddgFallback && !ctrl.signal.aborted) {
      try {
        const search = await webSearch(`site:${domain} contatti OR contact OR contactez email`, 3);
        for (const r of search.results) {
          if (ctrl.signal.aborted) break;
          if (visited.size >= maxPages) break;
          // Solo URL same-domain
          try {
            const u = new URL(r.url);
            if (u.hostname.replace(/^www\./, '') !== domain) continue;
          } catch { continue; }
          const found = await tryFetch(r.url);
          if (found) break;
        }
      } catch (e) {
        logger.debug({ err: e, domain }, 'contact-discovery: DDG fallback fallita');
      }
    }

    const tookMs = Date.now() - start;
    // Default sensati se non siamo mai riusciti a scaricare la homepage.
    const meta = homepageMeta ?? extractHomepageMetadata('', origin, domain);
    const result: ContactDiscoveryResult = {
      emails: allEmails,
      primary_email: pickPrimary(allEmails),
      source_page: sourcePage,
      pages_visited: visited.size,
      paths_tried: pathsTried,
      domain,
      took_ms: tookMs,
      cache_hit: false,
      company_name: meta.company_name,
      description: meta.description,
      site_language: meta.site_language,
      content_text: meta.content_text,
      og_image: meta.og_image,
      ...(allEmails.length === 0 ? { reason_if_empty: classifyEmptyReason(visited.size, pathsTried, ctrl.signal.aborted) } : {}),
    };
    cacheSet(homeUrl, result);
    return result;
  } finally {
    clearTimeout(globalTo);
  }
}

/**
 * Estrae metadata "human-grade" dalla homepage HTML:
 *   • company_name → og:site_name → <title> → application-name → titlecase(domain)
 *   • description  → meta description → og:description
 *   • site_language → <html lang="...">
 *   • content_text → testo pulito (strip script/style/tag), capped a 4000 char
 *   • og_image     → og:image (assoluto)
 *
 * Parser regex-based (no jsdom): adeguato per HTML real-world, robusto su
 * encoding misti, evita la dipendenza pesante di un DOM completo.
 */
function extractHomepageMetadata(
  html: string,
  origin: string,
  domain: string,
): {
  company_name: string;
  description: string;
  site_language: string | null;
  content_text: string;
  og_image: string | null;
} {
  // Helpers
  const decodeEntities = (s: string): string =>
    s.replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)));

  const metaContent = (re: RegExp): string | null => {
    const m = re.exec(html);
    if (!m) return null;
    const v = (m[1] ?? '').trim();
    return v ? decodeEntities(v) : null;
  };

  // og:site_name / application-name / title
  const ogSite =
    metaContent(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    ?? metaContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  const appName =
    metaContent(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i)
    ?? metaContent(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']application-name["']/i);
  const titleRaw = metaContent(/<title[^>]*>([^<]+)<\/title>/i);
  // Title spesso è "Brand | Tagline" — prendi solo la prima parte se contiene separatori
  const title = titleRaw
    ? titleRaw.split(/\s+[|–—-]\s+/)[0]?.trim() ?? titleRaw.trim()
    : null;

  // Description
  const description =
    metaContent(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    ?? metaContent(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
    ?? metaContent(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    ?? '';

  // Site language: <html lang="..">
  const langMatch = /<html\s[^>]*\blang=["']([a-zA-Z-]+)["']/i.exec(html);
  const siteLanguage = langMatch?.[1] ? langMatch[1].slice(0, 2).toLowerCase() : null;

  // og:image (assoluto)
  let ogImage = metaContent(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? metaContent(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogImage && !/^https?:\/\//i.test(ogImage)) {
    try { ogImage = new URL(ogImage, origin).toString(); } catch { ogImage = null; }
  }

  // Content text: rimuovi script/style/svg/noscript, poi tag, poi normalizza whitespace
  const cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const contentText = decodeEntities(cleaned).replace(/\s+/g, ' ').trim().slice(0, 4000);

  // company_name resolution con priorità: og:site_name > application-name > title > titlecase(domain)
  const titlecaseDomain = (d: string): string => {
    const stripped = d.replace(/^www\./i, '').split('.')[0] ?? d;
    return stripped
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  };
  const companyName = (ogSite ?? appName ?? title ?? titlecaseDomain(domain)).trim();

  return {
    company_name: companyName,
    description: description.slice(0, 500),
    site_language: siteLanguage,
    content_text: contentText,
    og_image: ogImage ?? null,
  };
}

function pickPrimary(emails: HarvestedEmail[]): string | null {
  if (emails.length === 0) return null;
  // Già ordinati per confidence DESC dal harvestEmails — primary = primo
  return emails[0]?.email ?? null;
}

function classifyEmptyReason(pagesVisited: number, paths: string[], aborted: boolean): string {
  if (aborted) return 'timeout_exceeded';
  if (pagesVisited === 0) return 'homepage_unreachable';
  if (paths.every((p) => p.includes('robots:blocked'))) return 'robots_blocked';
  if (pagesVisited === 1) return 'no_contact_link_discovered';
  return 'pages_visited_no_email_found';
}

function emptyResult(homeUrl: string, start: number, reason: string): ContactDiscoveryResult {
  let domain = '';
  try { domain = new URL(homeUrl).hostname.replace(/^www\./i, ''); }
  catch { /* keep empty */ }
  // Fallback metadata: titlecase(domain), tutto il resto vuoto.
  const meta = extractHomepageMetadata('', '', domain);
  return {
    emails: [],
    primary_email: null,
    source_page: null,
    pages_visited: 0,
    paths_tried: [],
    domain,
    took_ms: Date.now() - start,
    cache_hit: false,
    company_name: meta.company_name,
    description: '',
    site_language: null,
    content_text: '',
    og_image: null,
    reason_if_empty: reason,
  };
}
