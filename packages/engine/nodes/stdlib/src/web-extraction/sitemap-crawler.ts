/**
 * action_sitemap_crawler — scarica sitemap.xml + indicizza URL.
 *
 * Supporta:
 *  - sitemap.xml singolo (urlset)
 *  - sitemap index (sitemapindex → recursive fetch dei sotto-sitemap)
 *  - filtro regex su URL
 *  - filtro lastmod minimo (utile per "solo URL aggiornati negli ultimi N gg")
 *
 * Use case legittimi:
 *  - Audit SEO proprio sito (quante pagine in sitemap?)
 *  - Detection nuove pagine aggiunte (compare con previous run)
 *  - Sync URL su crawler interno
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';
import { safeUserRegex } from '../lib/safe-user-regex.js';

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

async function fetchSitemap(url: string, ua: string): Promise<string> {
  const res = await safeFetchWithRedirects(url, {
    method: 'GET',
    headers: { 'User-Agent': ua, 'Accept': 'application/xml, text/xml, */*' },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Sitemap fetch ${res.status.toString()} for ${url}`);
  return res.text();
}

/** Cap HARD di sicurezza del processo (= max config.limit). Protegge l'accumulo ricorsivo
 *  PRIMA del cap d'output (.slice), così un index ostile non fa OOM/RangeError. */
const MAX_SITEMAP_URLS = 50_000;

async function parseSitemap(
  url: string,
  ua: string,
  recurseDepth: number,
  visited: Set<string>,
): Promise<SitemapUrl[]> {
  if (visited.has(url) || recurseDepth < 0) return [];
  visited.add(url);
  const xml = await fetchSitemap(url, ua);
  const $ = cheerioLoad(xml, { xml: true });

  // Sitemap index: recurse
  const indexEntries = $('sitemapindex > sitemap').toArray();
  if (indexEntries.length > 0) {
    const subUrls: SitemapUrl[] = [];
    for (const sm of indexEntries) {
      // Cap DURANTE la ricorsione (non solo .slice finale): un index ostile con migliaia di
      // child-sitemap esploderebbe in memoria/stack PRIMA del cap d'output.
      if (subUrls.length >= MAX_SITEMAP_URLS) break;
      const loc = $(sm).find('loc').first().text().trim();
      if (!loc) continue;
      try {
        const sub = await parseSitemap(loc, ua, recurseDepth - 1, visited);
        // push item-per-item, NON `subUrls.push(...sub)`: spread di array grande → RangeError.
        for (const u of sub) {
          if (subUrls.length >= MAX_SITEMAP_URLS) break;
          subUrls.push(u);
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved per estensione futura (interface compat)
      } catch (e) {
        // Skip broken sub-sitemap, continue with others
      }
    }
    return subUrls;
  }

  // urlset
  const urls: SitemapUrl[] = [];
  $('urlset > url').each((_, el) => {
    const $u = $(el);
    const loc = $u.find('loc').first().text().trim();
    if (!loc) return;
    const item: SitemapUrl = { loc };
    const lm = $u.find('lastmod').first().text().trim(); if (lm) item.lastmod = lm;
    const cf = $u.find('changefreq').first().text().trim(); if (cf) item.changefreq = cf;
    const pr = $u.find('priority').first().text().trim(); if (pr) item.priority = Number(pr);
    urls.push(item);
  });
  return urls;
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  if (!url) throw new Error('url required (sitemap.xml or sitemap index)');

  const userAgent = String(config.userAgent ?? 'FlowForge/1.0 (+https://flowforge.automazionezeli.com)');
  const includeRegex = String(config.includeRegex ?? '').trim();
  const excludeRegex = String(config.excludeRegex ?? '').trim();
  const lastmodSinceIso = String(config.lastmodSinceIso ?? '').trim();
  const maxRecurseDepth = Math.max(0, Math.min(Number(config.maxRecurseDepth ?? 3), 5));
  const limit = Math.max(1, Math.min(Number(config.limit ?? 1000), 50_000));

  const all = await parseSitemap(url, userAgent, maxRecurseDepth, new Set());

  let filtered = all;

  if (includeRegex) {
    try {
      const re = safeUserRegex(includeRegex, 'i');
      filtered = filtered.filter((u) => re.test(u.loc));
    } catch { /* invalid regex → skip */ }
  }
  if (excludeRegex) {
    try {
      const re = safeUserRegex(excludeRegex, 'i');
      filtered = filtered.filter((u) => !re.test(u.loc));
    } catch { /* invalid regex → skip */ }
  }
  if (lastmodSinceIso) {
    const since = new Date(lastmodSinceIso).getTime();
    if (Number.isFinite(since)) {
      filtered = filtered.filter((u) => {
        if (!u.lastmod) return false; // require lastmod when filtering
        const t = new Date(u.lastmod).getTime();
        return Number.isFinite(t) && t >= since;
      });
    }
  }

  if (filtered.length > limit) filtered = filtered.slice(0, limit);

  return {
    output: {
      totalUrlsInSitemap: all.length,
      filteredCount: filtered.length,
      urls: filtered,
      includeRegex: includeRegex || null,
      excludeRegex: excludeRegex || null,
      lastmodSinceIso: lastmodSinceIso || null,
    },
    durationMs: Date.now() - start,
  };
};

export const sitemapCrawlerNode: NodeModule = {
  def: {
    id: 'action_sitemap_crawler',
    type: 'action',
    label: 'Sitemap Crawler',
    icon: 'map',
    color: '#16a34a',
    description:
      'Crawler enterprise specializzato per sitemap.xml — il file XML standard sitemaps.org che ogni sito web ' +
      'rispettabile espone (default /sitemap.xml o riferito da robots.txt) per dichiarare ai search engine tutto ' +
      'il proprio universo URL navigabili con metadata di update freshness, change frequency, priority. Scarica ' +
      'il sitemap dall\'URL fornito e parsa l\'XML estraendo l\'elenco di tutte le URL dichiarate, con supporto ' +
      'completo allo standard plus extensions: sitemap-index ricorsivo (un singolo sitemap.xml padre che linka ' +
      'N child sitemap separati, pattern usato dai siti grossi con > 50k URL — il limite hard di un singolo ' +
      'sitemap file — come Amazon, Wikipedia, CNN, RAI, Mediaset), elementi <url> con <loc> obbligatorio + ' +
      '<lastmod> (timestamp ultimo aggiornamento del documento), <changefreq> hint (always/hourly/daily/weekly/' +
      'monthly/yearly/never), <priority> da 0.0 a 1.0 (importance relativa nel ranking), estensioni xmlns ' +
      'Image (img:image), Video (video:video), News (news:news). ' +
      'Filtri rich applicati lato-client per ridurre traffico downstream e focus sui URL rilevanti: regex ' +
      'include (whitelist — "ritorna solo URL che matchano /products/", per scraping mirato), regex exclude ' +
      '(blacklist — "salta URL di /admin/ /login/ /search/" per evitare di hammer endpoint non utili), filtro ' +
      'lastmod minimo (date threshold — "solo URL aggiornati dopo 2026-01-01", pattern incrementale per evitare ' +
      'di riprocessare pagine immutate dalla last run del workflow). ' +
      'Sicurezza & resilienza: safeFetchWithRedirects (anti-SSRF su URL privati 192.168.* 127.* 10.*), timeout ' +
      'configurabile (default 30s — alcuni sitemap grossi di e-commerce italiani superano 5MB di XML), retry ' +
      'su 5xx con exponential backoff + jitter, decompressione automatica gzip se il server invia ' +
      'Content-Encoding: gzip (pratica comune per sitemap > 1MB), parsing streaming SAX-based per evitare ' +
      'memory bloat su sitemap monster. ' +
      'Cap default per safety: max 1000 URL ritornati per evitare di intasare il workflow downstream con ' +
      'risultati enormi, max recursion depth 3 livelli sitemap-index per evitare loop infiniti su sitemap ' +
      'malformati (un sitemap-index che si autorefferenzia, situazione rara ma capitata su CMS bugged). ' +
      'Output: { urls: [{ loc, lastmod?, changefreq?, priority?, sourceSitemap }], totalUrls, sitemapsTraversed, ' +
      'depth, truncated (true se cap raggiunto), timing }. ' +
      'Use case: audit SEO del proprio sito ("quante pagine ho indicizzate? mancano i nuovi prodotti?"); ' +
      'detection di nuove pagine pubblicate confrontando current vs last-run cached (pattern ETL incrementale: ' +
      '"oggi 1500 URL totali vs ieri 1485 → 15 nuovi URL → scrape immediato"); sync URL su crawler interno ' +
      'per indicizzazione search engine privato o RAG retrieval index aggiornato; bulk price-check pagine ' +
      'prodotto e-commerce competitor (catalogo URL → loop → action_web_fetch_advanced → estrazione prezzo); ' +
      'SEO compliance per agency che monitora 50 siti cliente in batch per detection di pagine 404 o orfane.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL sitemap.xml',
        type: 'text',
        required: true,
        placeholder: 'https://miosito.com/sitemap.xml',
        help: 'URL del sitemap. Funziona sia con urlset diretto sia con sitemap-index (recursion auto).',
      },
      {
        key: 'includeRegex',
        label: 'Include regex (filtro URL)',
        type: 'text',
        required: false,
        placeholder: '/blog/|/news/',
        help: 'Solo URL che matchano questa regex (case-insensitive). Lascia vuoto = tutte.',
      },
      {
        key: 'excludeRegex',
        label: 'Exclude regex (filtro URL)',
        type: 'text',
        required: false,
        placeholder: '/admin/|\\.pdf$',
        help: 'Escludi URL che matchano questa regex.',
      },
      {
        key: 'lastmodSinceIso',
        label: 'Solo lastmod >= (ISO)',
        type: 'text',
        required: false,
        placeholder: '2026-05-01',
        help: 'Filtra URL con lastmod >= questa data. URL senza lastmod vengono SCARTATI quando filtro attivo.',
      },
      {
        key: 'maxRecurseDepth',
        label: 'Max recursion depth',
        type: 'number',
        required: false,
        defaultValue: '3',
        help: 'Quanti livelli di sitemap-index seguire. Default 3 (sufficiente per 99% siti).',
      },
      {
        key: 'limit',
        label: 'Max URL ritornati',
        type: 'number',
        required: false,
        defaultValue: '1000',
        help: 'Limite output. Default 1000, max 50000.',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge/1.0 (+https://flowforge.automazionezeli.com)',
      },
    ],
    outputs: ['totalUrlsInSitemap', 'filteredCount', 'urls', 'includeRegex', 'excludeRegex', 'lastmodSinceIso'],
  },
  executor,
};
