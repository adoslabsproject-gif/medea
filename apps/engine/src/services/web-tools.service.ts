/**
 * Web tools service — 2026 enterprise-grade tech stack.
 *
 * ════════════════════════════════════════════════════════════════════
 * SEARCH PROVIDERS (cascade, prima → ultima):
 * ════════════════════════════════════════════════════════════════════
 *   1. Tavily AI Search (TAVILY_API_KEY) — ottimizzato per LLM agent,
 *      ritorna `answer` già sintetizzata + content snippet ricchi
 *      (1000 query/mese free). https://tavily.com/
 *   2. Brave Search API (BRAVE_SEARCH_API_KEY) — privacy-first, indexer
 *      proprietario, 2k/mese free, JSON pulito. https://brave.com/search/api/
 *   3. Serper.dev (SERPER_API_KEY) — Google SERP scraping legale, 2.5k
 *      query free. https://serper.dev/
 *   4. DuckDuckGo HTML scraping — fallback gratuito always-on, parser
 *      cheerio sui risultati .result. Niente API key richiesta.
 *
 * ════════════════════════════════════════════════════════════════════
 * FETCH PROVIDERS (cascade, prima → ultima):
 * ════════════════════════════════════════════════════════════════════
 *   1. Jina AI Reader (`r.jina.ai/<url>`) — top 2026, gratuito, gestisce
 *      JS rendering server-side, output markdown già pulito ottimizzato
 *      per LLM. Nessuna auth per uso modesto. https://jina.ai/reader/
 *   2. Cheerio raw — fallback senza dipendenze esterne, strip nav/footer,
 *      prefer <main>/<article>. Usato se Jina è giù o rate-limita.
 *
 *   (NOTA: Mozilla Readability + jsdom rimossi — Jina copre il 95% dei
 *   casi con qualità superiore, e jsdom ha sub-dep problematiche in bundle
 *   esbuild standalone.)
 *
 * ════════════════════════════════════════════════════════════════════
 * GUARDIE SECURITY:
 * ════════════════════════════════════════════════════════════════════
 *   • SSRF guard: blocca localhost/127.x/192.168.x/10.x/172.16-31.x/
 *     169.254.x (link-local AWS metadata), `.internal`, `.local`
 *   • Timeout 10s su tutti i fetch
 *   • Cap 100KB per response, lettura troncata in streaming (flag `truncated`)
 *   • Binary type rejection (PDF/img/video → user usa attachments flow)
 *   • LRU cache 5min × 100 query su search
 */

import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

// ─────────────────────────────────────────────────────────────────────────
// SSRF protection
// ─────────────────────────────────────────────────────────────────────────

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80::/i,
  /\.internal$/i,
  /\.local$/i,
];

function isHostBlocked(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

// ─────────────────────────────────────────────────────────────────────────
// fetchUrl — cascade: Jina Reader → Mozilla Readability → Cheerio
// ─────────────────────────────────────────────────────────────────────────

export interface FetchUrlResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  /** Provider che ha effettivamente prodotto il content (per debug + UI). */
  extractor: 'firecrawl' | 'jina-reader' | 'cheerio';
  title?: string;
  description?: string;
  /** Estratto leggibile. Max ~100KB. */
  content: string;
  /** true se la risposta superava il limite di lettura ed è stata troncata. (Prima
   *  era `truncatedChars`: il conteggio esatto non è calcolabile leggendo in
   *  streaming — e all'LLM serve solo sapere SE il contenuto è incompleto.) */
  truncated: boolean;
}

const MAX_FETCH_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * User-Agent realistic (Chrome 123 macOS): DDG e altri search engine
 * block-listano gli UA contenenti "bot/spider/agent/+http..." come anomaly.
 * Bloccarci con un UA marker-based ci impedisce qualsiasi search gratuito.
 * Per fetch identificabili (sites che vogliono whitelistare il bot), si può
 * usare un secondo UA tramite l'env FLOWFORGE_BOT_UA (override custom).
 */
const USER_AGENT = process.env.FLOWFORGE_BOT_UA
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

/**
 * Errore: il fetch ha colpito la pagina di WAKE del tenant ("Avvio del
 * workspace…") servita da nginx @waking quando un container FlowForge è in
 * pausa/riavvio. Prima, quell'HTML veniva passato a Liara come "contenuto del
 * sito" (spazzatura) e l'utente vedeva l'errore di wake dentro la chat.
 */
export class WorkspaceWakingError extends Error {
  readonly code = 'WORKSPACE_WAKING';
  constructor(public readonly targetUrl: string) {
    super(
      `Il sito "${targetUrl}" era in pausa o in riavvio (workspace FlowForge in wake): ` +
      'riprova tra qualche secondo, quando l\'ambiente sarà ripartito.',
    );
    this.name = 'WorkspaceWakingError';
  }
}

/**
 * True se il testo è (con alta confidenza) la pagina di wake del tenant. I
 * marker sono il testo che serviamo NOI (vedi wake template): "ambiente si era
 * messo in pausa" è univoco — niente falsi positivi su siti reali. Il titolo
 * "Avvio del workspace" da solo richiede un secondo segnale (5xx @waking o
 * "Riparte in pochi secondi") per evitare match su pagine che lo citano.
 */
export function isWorkspaceWakePage(content: string, status?: number): boolean {
  const hasStrong = content.includes('ambiente si era messo in pausa');
  const hasTitle = content.includes('Avvio del workspace');
  const waking5xx = status !== undefined && [502, 503, 504].includes(status);
  return hasStrong || (hasTitle && (waking5xx || content.includes('Riparte in pochi secondi')));
}

/** Throw `WorkspaceWakingError` se il risultato è la wake page; altrimenti lo passa. */
function assertNotWakePage(result: FetchUrlResult): FetchUrlResult {
  if (isWorkspaceWakePage(result.content, result.status)) {
    throw new WorkspaceWakingError(result.finalUrl || result.url);
  }
  return result;
}

export async function fetchUrl(rawUrl: string): Promise<FetchUrlResult> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new Error(`URL non valido: ${rawUrl}`); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Solo http/https supportati (ricevuto: ${url.protocol})`);
  }
  if (isHostBlocked(url.hostname)) {
    throw new Error(`Host bloccato per security policy (SSRF guard): ${url.hostname}`);
  }
  // Secondo livello (#194 M2): bloccare IP privati/cloud metadata anche se
  // hostname legit; protegge da DNS rebind verso CNAME malevoli risolti
  // a 169.254.169.254.
  const { validateUrlForFetch } = await import('@flowforge/safe-fetch');
  const ssrf = validateUrlForFetch(url.toString());
  if (!ssrf.ok) {
    throw new Error(`SSRF guard: ${ssrf.reason} (${ssrf.detail ?? 'invalid'})`);
  }

  // CASCADE 0: FireCrawl (Vercel-grade, Playwright rendering + antibot bypass).
  // Top tier 2026 per SPA React/Vue/Next.js. Opt-in via FIRECRAWL_API_KEY.
  // Quando settata, batte Jina su content quality + JS-heavy sites.
  if (process.env.FIRECRAWL_API_KEY) {
    let fcResult: FetchUrlResult | null = null;
    try {
      fcResult = await firecrawlFetch(rawUrl, process.env.FIRECRAWL_API_KEY);
    } catch (e) {
      logger.warn({ err: e, url: rawUrl }, 'FireCrawl fallita, fallback Jina Reader');
    }
    // assertNotWakePage FUORI dal try: la wake page NON deve far ricadere sul
    // prossimo extractor (otterrebbe la stessa wake page) — deve propagare.
    if (fcResult) return assertNotWakePage(fcResult);
  }

  // CASCADE 1: Jina AI Reader — gratuito, gestisce JS rendering, markdown pulito
  let jinaResult: FetchUrlResult | null = null;
  try {
    jinaResult = await jinaReaderFetch(rawUrl);
  } catch (e) {
    logger.warn({ err: e, url: rawUrl }, 'Jina Reader fallita, fallback Readability');
  }
  if (jinaResult) return assertNotWakePage(jinaResult);

  // CASCADE 2+3: fetch raw poi prova Readability poi Cheerio
  // SSRF-safe redirect handling (#194 M2): seguo redirect MANUALMENTE
  // ri-validando ogni Location con ssrf-guard (max 5 hop). Senza, un
  // attaccante pubblica `https://evil.com/r` che 302 a `http://127.0.0.1:6379`.
  const ctrl = new AbortController();
  const to = setTimeout(() => { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  let res: Response;
  let currentUrl = url.toString();
  let hops = 0;
  const MAX_REDIRECTS = 5;
  try {
     
    while (true) {
      res = await safeOutboundFetch(currentUrl, {
        externalSignal: ctrl.signal, timeoutMs: 0,
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'it,en;q=0.8',
        },
      });
      if (res.status < 300 || res.status >= 400) break;          // non e` un redirect
      const loc = res.headers.get('location');
      if (!loc) break;
      if (++hops > MAX_REDIRECTS) throw new Error(`Troppi redirect (>${MAX_REDIRECTS})`);
      const next = new URL(loc, currentUrl).toString();
      const nextSsrf = validateUrlForFetch(next);
      if (!nextSsrf.ok) {
        throw new Error(`SSRF guard redirect: ${nextSsrf.reason} (${nextSsrf.detail ?? 'invalid'})`);
      }
      currentUrl = next;
    }
  } catch (e) {
    clearTimeout(to);
    throw new Error(`fetch fallito: ${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(to);

  const contentType = (res.headers.get('content-type') ?? 'text/plain').toLowerCase();
  if (/^(application\/pdf|image\/|video\/|audio\/|application\/zip|application\/octet-stream)/.test(contentType)) {
    throw new Error(`Content-type "${contentType}" non testuale. Per immagini usa attachments della chat.`);
  }

  // Lettura TRONCATA in streaming (anti-OOM): prima `await res.text()` bufferizzava
  // l'INTERO body e solo dopo tagliava a 100KB → una pagina da centinaia di MB veniva
  // letta tutta in RAM prima del taglio. Ora il taglio avviene durante il download.
  const { text: limited, truncated } = await readTextTruncated(res, MAX_FETCH_BYTES);

  if (contentType.includes('json')) {
    let content = limited;
    try { content = JSON.stringify(JSON.parse(limited), null, 2); } catch { /* keep raw */ }
    return {
      url: rawUrl, finalUrl: res.url, status: res.status, contentType,
      extractor: 'cheerio', content, truncated,
    };
  }

  if (contentType.includes('html')) {
    // CASCADE 2: Cheerio raw (strip nav/footer/script, prefer main/article)
    return assertNotWakePage(cheerioExtract(rawUrl, res.url, res.status, contentType, limited, truncated));
  }

  return assertNotWakePage({
    url: rawUrl, finalUrl: res.url, status: res.status, contentType,
    extractor: 'cheerio', content: limited, truncated,
  });
}

/**
 * FireCrawl — Vercel-grade scraper con Playwright rendering + antibot bypass.
 * Top tier 2026 per JS-heavy sites (React/Vue/Next.js SPA). Restituisce
 * markdown + metadata strutturati. Tier free 500 req/mo, pay-as-you-go oltre.
 *
 * API: POST /v0/scrape { url, formats: ['markdown'], onlyMainContent: false }
 * (onlyMainContent=false PERCHÉ ci servono anche footer e nav per le email)
 */
async function firecrawlFetch(rawUrl: string, apiKey: string): Promise<FetchUrlResult | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => { ctrl.abort(); }, 20_000); // FireCrawl JS render può essere lento
  try {
    const res = await safeOutboundFetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      externalSignal: ctrl.signal, timeoutMs: 0,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: rawUrl,
        formats: ['markdown', 'html'],
        onlyMainContent: false, // mantieni footer/nav (email vivono lì)
        timeout: 18000,
        waitFor: 2000, // wait 2s per JS hydration su SPA
      }),
    });
    if (!res.ok) return null;
    const json = await readJsonCapped<{
      success?: boolean;
      data?: {
        markdown?: string;
        html?: string;
        metadata?: { title?: string; description?: string; sourceURL?: string; statusCode?: number };
      };
    }>(res);
    if (!json.success || !json.data?.markdown) return null;
    const md = json.data.markdown;
    const truncated = md.length > MAX_FETCH_BYTES;
    const content = truncated ? md.slice(0, MAX_FETCH_BYTES) : md;
    return {
      url: rawUrl,
      finalUrl: json.data.metadata?.sourceURL ?? rawUrl,
      status: json.data.metadata?.statusCode ?? 200,
      contentType: 'text/markdown',
      extractor: 'firecrawl',
      ...(json.data.metadata?.title ? { title: json.data.metadata.title } : {}),
      ...(json.data.metadata?.description ? { description: json.data.metadata.description } : {}),
      content,
      truncated,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** Jina AI Reader: r.jina.ai/<url> → markdown ottimizzato per LLM. */
async function jinaReaderFetch(rawUrl: string): Promise<FetchUrlResult | null> {
  const jinaUrl = `https://r.jina.ai/${rawUrl}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await safeOutboundFetch(jinaUrl, {
      externalSignal: ctrl.signal, timeoutMs: 0,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/markdown',
        // Header opzionale per autenticazione se JINA_READER_KEY è settato
        // (rate-limit più alti). Senza key funziona comunque per traffico modesto.
        ...(process.env.JINA_READER_KEY ? { 'Authorization': `Bearer ${process.env.JINA_READER_KEY}` } : {}),
      },
    });
    if (!res.ok) return null;
    // Lettura troncata in streaming (anti-OOM, era `res.text()` integrale poi slice).
    const { text: content, truncated } = await readTextTruncated(res, MAX_FETCH_BYTES);
    if (!content || content.length < 50) return null;
    // Jina mette `Title: ...` come prima riga. Parse-out se presente.
    const titleMatch = /^Title:\s*(.+)$/m.exec(content);
    const urlMatch = /^URL Source:\s*(.+)$/m.exec(content);
    return {
      url: rawUrl,
      finalUrl: urlMatch?.[1]?.trim() ?? rawUrl,
      status: 200,
      contentType: 'text/markdown',
      extractor: 'jina-reader',
      ...(titleMatch?.[1] ? { title: titleMatch[1].trim() } : {}),
      content,
      truncated,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** Cheerio fallback — strip nav/footer/script, prefer <main>/<article>. */
function cheerioExtract(
  rawUrl: string, finalUrl: string, status: number, contentType: string,
  html: string, truncated: boolean,
): FetchUrlResult {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const description = ($('meta[name="description"]').attr('content')?.trim()
                  ?? $('meta[property="og:description"]').attr('content')?.trim()
                  ?? '');
  $('script, style, noscript, iframe, nav, footer, header, aside, [aria-hidden="true"]').remove();
  const main = $('main').first().text() || $('article').first().text() || $('body').text();
  const content = main.replace(/\s+/g, ' ').trim();
  return {
    url: rawUrl, finalUrl, status, contentType,
    extractor: 'cheerio',
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    content,
    truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// webSearch — cascade: Tavily → Brave → Serper → DuckDuckGo
// ─────────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  provider: 'exa' | 'tavily' | 'brave' | 'serper' | 'jina' | 'searx' | 'duckduckgo' | 'wikipedia';
  /** Sintesi pronta dal motore (Tavily answer / Serper answerBox / Wiki summary). */
  answer?: string;
  results: SearchResult[];
}

const searchCache = new Map<string, { ts: number; data: SearchResponse }>();
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX = 100;

function cacheGet(key: string): SearchResponse | null {
  const e = searchCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > SEARCH_CACHE_TTL_MS) { searchCache.delete(key); return null; }
  return e.data;
}
function cacheSet(key: string, data: SearchResponse): void {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const first = searchCache.keys().next().value;
    if (first) searchCache.delete(first);
  }
  searchCache.set(key, { ts: Date.now(), data });
}

export async function webSearch(query: string, limit = 10): Promise<SearchResponse> {
  const q = query.trim();
  if (!q) throw new Error('Query vuota');
  const cacheKey = `${limit.toString()}:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const exaKey = process.env.EXA_API_KEY ?? '';
  const tavilyKey = process.env.TAVILY_API_KEY ?? '';
  const braveKey = process.env.BRAVE_SEARCH_API_KEY ?? '';
  const serperKey = process.env.SERPER_API_KEY ?? '';

  let response: SearchResponse | null = null;
  // Exa.ai (semantic neural search, top-tier 2026) — preferito quando disponibile
  // perché ritorna risultati semanticamente simili senza match keyword esatto:
  // killer per cold outreach "siti simili a X" / "competitor di Y".
  if (exaKey) {
    try { response = await exaSearch(q, limit, exaKey); }
    catch (e) { logger.warn({ err: e, query: q }, 'Exa fallita, fallback Tavily/Brave/Serper/DDG'); }
  }
  if (!response && tavilyKey) {
    try { response = await tavilySearch(q, limit, tavilyKey); }
    catch (e) { logger.warn({ err: e, query: q }, 'Tavily fallita, fallback Brave/Serper/DDG'); }
  }
  if (!response && braveKey) {
    try { response = await braveSearch(q, limit, braveKey); }
    catch (e) { logger.warn({ err: e, query: q }, 'Brave fallita, fallback Serper/DDG'); }
  }
  if (!response && serperKey) {
    try { response = await serperSearch(q, limit, serperKey); }
    catch (e) { logger.warn({ err: e, query: q }, 'Serper fallita, fallback Jina/DDG'); }
  }
  // Jina Search — opt-in via JINA_READER_KEY. Quando configurato, è il
  // provider più affidabile per cold outreach (semantic + cloud-IP friendly).
  if (!response && process.env.JINA_READER_KEY) {
    try { response = await jinaSearch(q, limit); }
    catch (e) { logger.warn({ err: e, query: q }, 'Jina Search fallita, fallback Searx'); }
  }
  // Searx (federated public instances) — NO API key, cloud-IP friendly.
  // Inserito PRIMA di DDG perché su IP cloud (Hetzner/AWS/GCP/Vercel) DDG
  // blocca silenziosamente con 202+CAPTCHA. Incident 24 mag 2026 confermato:
  // DDG ha ritornato 0 risultati per 9 query Liara consecutive su Hetzner IP.
  if (!response) {
    try { response = await searxSearch(q, limit); }
    catch (e) { logger.warn({ err: e, query: q }, 'Searx fallita (tutte istanze pubbliche unreachable), fallback DDG'); }
  }
  if (!response || response.results.length === 0) {
    try {
      const ddg = await duckDuckGoSearch(q, limit);
      if (ddg.results.length > 0) response = ddg;
    } catch (e) { logger.warn({ err: e, query: q }, 'DDG fallita, fallback Wikipedia'); }
  }
  // Se DDG ha ritornato 0 (es. blocco bot), prova Wikipedia (sempre disponibile,
  // perfetta per query enciclopediche / brand / siti noti)
  if (!response || response.results.length === 0) {
    try {
      const wiki = await wikipediaSearch(q, limit);
      if (wiki.results.length > 0 || wiki.answer) response = wiki;
    } catch (e) {
      logger.warn({ err: e, query: q }, 'Wikipedia fallita — nessun provider disponibile');
      response ??= { query: q, provider: 'duckduckgo', results: [] };
    }
  }

  cacheSet(cacheKey, response!);
  return response!;
}

/**
 * Wikipedia API search — gratuita, no key, no captcha, JSON ufficiale.
 * Strategia: opensearch endpoint per lista pagine + REST summary endpoint
 * per la PRIMA pagina (intro + thumbnail). L'intro di Wikipedia è una
 * sintesi enciclopedica perfetta come `answer` LLM-ready.
 *
 * Tenta prima it.wikipedia, poi en.wikipedia se la query italiana ritorna vuota.
 */
async function wikipediaSearch(query: string, limit: number): Promise<SearchResponse> {
  const tryLang = async (lang: 'it' | 'en'): Promise<SearchResponse | null> => {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit.toString()}&namespace=0&format=json&origin=*`;
    const res = await safeOutboundFetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      timeoutMs: 8000,
    });
    if (!res.ok) return null;
    // opensearch shape: [query, [titles], [descriptions], [urls]]
    const data = await readJsonCapped<[string, string[], string[], string[]]>(res);
    const titles = data[1] ?? [];
    const descs = data[2] ?? [];
    const urls = data[3] ?? [];
    if (titles.length === 0) return null;
    const results: SearchResult[] = titles.slice(0, limit).map((t, i) => ({
      title: t,
      url: urls[i] ?? '',
      snippet: descs[i] ?? '',
    }));
    // Fetch summary REST per la prima pagina come `answer` enciclopedica
    let answer: string | undefined;
    const firstTitle = titles[0];
    if (firstTitle) {
      try {
        const sumRes = await safeOutboundFetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstTitle)}`, {
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
          timeoutMs: 5000,
        });
        if (sumRes.ok) {
          const sumJson = await readJsonCapped<{ extract?: string }>(sumRes);
          answer = sumJson.extract ?? undefined;
        }
      } catch { /* ignore */ }
    }
    return {
      query, provider: 'wikipedia',
      ...(answer ? { answer } : {}),
      results,
    };
  };
  const it = await tryLang('it');
  if (it && it.results.length > 0) return it;
  const en = await tryLang('en');
  return en ?? { query, provider: 'wikipedia', results: [] };
}

/**
 * Exa.ai (formerly Metaphor) — semantic neural search. State-of-the-art 2026
 * per cold outreach perché trova risultati semanticamente affini senza match
 * keyword esatto. Endpoint /search supporta 2 modi:
 *   - type=neural (default): embedding-based, ottimo per "siti simili a X"
 *   - type=keyword: fallback à la Google
 * useAutoprompt: Exa riscrive la query in formato ottimale (es. "yacht
 * shipyards Italy contact emails" diventa "Italian yacht builders contact pages").
 */
async function exaSearch(query: string, limit: number, apiKey: string): Promise<SearchResponse> {
  const res = await safeOutboundFetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query,
      numResults: limit,
      type: 'auto', // Exa decide neural vs keyword
      useAutoprompt: true,
      contents: { text: { maxCharacters: 1000 } },
    }),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Exa ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
  const json = await readJsonCapped<{
    autopromptString?: string;
    results?: { title?: string; url?: string; text?: string; snippet?: string }[];
  }>(res);
  return {
    query,
    provider: 'exa',
    ...(json.autopromptString ? { answer: `Autoprompt: ${json.autopromptString}` } : {}),
    results: (json.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '(no title)',
      url: r.url ?? '',
      snippet: r.snippet ?? r.text?.slice(0, 300) ?? '',
    })),
  };
}

/** Tavily AI Search — ottimizzato per LLM agents, include answer sintetizzata. */
async function tavilySearch(query: string, limit: number, apiKey: string): Promise<SearchResponse> {
  const res = await safeOutboundFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      include_answer: true,
      search_depth: 'advanced',
      include_raw_content: false,
    }),
    timeoutMs: 15_000,  // Tavily advanced può essere più lento
  });
  if (!res.ok) throw new Error(`Tavily ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
  const json = await readJsonCapped<{
    answer?: string;
    results?: { title?: string; url?: string; content?: string }[];
  }>(res);
  return {
    query,
    provider: 'tavily',
    ...(json.answer ? { answer: json.answer } : {}),
    results: (json.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '(no title)',
      url: r.url ?? '',
      snippet: r.content ?? '',
    })),
  };
}

async function braveSearch(query: string, limit: number, apiKey: string): Promise<SearchResponse> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit.toString()}&search_lang=it&country=IT`;
  const res = await safeOutboundFetch(url, {
    headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error(`Brave ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
  const json = await readJsonCapped<{ web?: { results?: { title?: string; url?: string; description?: string }[] } }>(res);
  return {
    query, provider: 'brave',
    results: (json.web?.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '(no title)', url: r.url ?? '', snippet: r.description ?? '',
    })),
  };
}

/** Serper.dev — Google SERP scraping legale via API. */
async function serperSearch(query: string, limit: number, apiKey: string): Promise<SearchResponse> {
  const res = await safeOutboundFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: limit, gl: 'it', hl: 'it' }),
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error(`Serper ${res.status.toString()}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 200)}`);
  const json = await readJsonCapped<{
    organic?: { title?: string; link?: string; snippet?: string }[];
    answerBox?: { answer?: string; snippet?: string };
  }>(res);
  const answer = json.answerBox?.answer ?? json.answerBox?.snippet;
  return {
    query, provider: 'serper',
    ...(answer ? { answer } : {}),
    results: (json.organic ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '(no title)', url: r.link ?? '', snippet: r.snippet ?? '',
    })),
  };
}

/**
 * DuckDuckGo fallback gratuito. Cascade interna:
 *   a) lite.duckduckgo.com/lite/?q=... (GET, sopravvive a tutti i refactor DDG,
 *      no JS, format ultra-stabile da anni)
 *   b) html.duckduckgo.com/html/ (POST form-urlencoded — il `state_hidden`
 *      è opzionale, la versione current accetta POST minimale)
 *
 * lite.duckduckgo.com restituisce una tabella semplice con `<a class="result-link">`
 * + `<td class="result-snippet">`, parsata banalmente con cheerio. È il
 * pattern usato da search aggregator open-source (SearXNG inclusi).
 */
/**
 * Jina Search — opt-in via JINA_READER_KEY (dal 2025 non più gratuito anonimo).
 * Quando l'utente HA la key, è il fallback più affidabile da IP cloud.
 */
async function jinaSearch(query: string, limit: number): Promise<SearchResponse> {
  if (!process.env.JINA_READER_KEY) throw new Error('JINA_READER_KEY not configured');
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => { ctrl.abort(); }, 12_000);
  try {
    const res = await safeOutboundFetch(url, {
      externalSignal: ctrl.signal, timeoutMs: 0,
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Respond-With': 'no-content',
        'Authorization': `Bearer ${process.env.JINA_READER_KEY}`,
      },
    });
    if (!res.ok) throw new Error(`Jina Search ${res.status.toString()}`);
    const json = await readJsonCapped<{ data?: { title?: string; url?: string; description?: string; content?: string }[] }>(res);
    return {
      query, provider: 'jina',
      results: (json.data ?? []).slice(0, limit).map((r) => ({
        title: r.title ?? '(no title)',
        url: r.url ?? '',
        snippet: r.description ?? r.content?.slice(0, 300) ?? '',
      })),
    };
  } finally { clearTimeout(to); }
}

/**
 * Searx public instances — federated meta-search, NO API key, cloud-IP friendly.
 * Searx aggrega risultati da Google/Bing/DDG/altri e li espone via JSON public.
 *
 * Strategy: prova istanze in ordine (fallback se una è down/rate-limited).
 * Public list maintained at https://searx.space; selezionate le top 3 per
 * uptime+JSON support+CORS-allow.
 */
// SearXNG interno per-tenant PRIMA delle istanze pubbliche (2026-07-08): su IP
// datacenter (Hetzner) le istanze pubbliche + DDG sono rate-limitate a
// intermittenza → ricerca inaffidabile. `SEARXNG_URL` (iniettato nel container
// tenant, punta all'istanza self-hosted sulla docker network) è provato per
// primo: le query NON escono dal server, nessuna dipendenza da terzi. Le
// pubbliche restano come fallback se l'env non è settato o l'istanza è giù.
/**
 * Lista istanze SearXNG in ordine di preferenza: la self-hosted (SEARXNG_URL,
 * normalizzata senza slash finale) PRIMA, poi le pubbliche di fallback. Pura →
 * testabile senza toccare process.env.
 */
export function buildSearxInstances(searxngUrl: string | undefined): string[] {
  const internal = (searxngUrl ?? '').trim().replace(/\/+$/, '');
  return [
    ...(internal !== '' ? [internal] : []),
    'https://searx.be',
    'https://search.bus-hit.me',
    'https://priv.au',
  ];
}

const SEARX_INSTANCES = buildSearxInstances(process.env.SEARXNG_URL);

/** L'istanza interna self-hosted (SEARXNG_URL) è raggiungibile SOLO con
 *  allowPrivateHost (host docker/IP privato); le istanze pubbliche NO (restano
 *  protette dal guard SSRF). Confronto esatto sull'origin normalizzato. */
const INTERNAL_SEARX = process.env.SEARXNG_URL ? process.env.SEARXNG_URL.replace(/\/+$/, '') : '';

async function searxSearch(query: string, limit: number): Promise<SearchResponse> {
  for (const instance of SEARX_INSTANCES) {
    const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=it&safesearch=0`;
    const isInternal = INTERNAL_SEARX !== '' && instance === INTERNAL_SEARX;
    const ctrl = new AbortController();
    const to = setTimeout(() => { ctrl.abort(); }, 10_000);
    try {
      const res = await safeOutboundFetch(url, {
        externalSignal: ctrl.signal, timeoutMs: 0,
        ...(isInternal ? { allowPrivateHost: true } : {}),
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
      });
      clearTimeout(to);
      if (!res.ok) continue;
      const json = await readJsonCapped<{ results?: { title?: string; url?: string; content?: string }[] }>(res);
      const results = (json.results ?? []).slice(0, limit).map((r) => ({
        title: r.title ?? '(no title)',
        url: r.url ?? '',
        snippet: r.content ?? '',
      }));
      if (results.length === 0) continue;
      return { query, provider: 'searx', results };
    } catch {
      clearTimeout(to);
    }
  }
  throw new Error('Searx: nessuna istanza raggiungibile (interna + pubbliche)');
}

async function duckDuckGoSearch(query: string, limit: number): Promise<SearchResponse> {
  // STRATEGIA A — lite.duckduckgo.com (GET, HTML stabile)
  try {
    const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=it-it`;
    const res = await safeOutboundFetch(liteUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      timeoutMs: 8000,
    });
    if (res.ok) {
      // HTML SERP DDG (anti-OOM, cap generoso 2MB: una pagina di risultati è KB).
      const { text: html } = await readTextTruncated(res, 2_000_000);
      const results = parseLiteDuckDuckGoHtml(html, limit);
      if (results.length > 0) return { query, provider: 'duckduckgo', results };
    }
  } catch (e) {
    logger.debug({ err: e, query }, 'lite.duckduckgo.com failed, trying html.duckduckgo.com');
  }

  // STRATEGIA B — html.duckduckgo.com via POST (il GET ora richiede form token)
  const htmlUrl = 'https://html.duckduckgo.com/html/';
  const formBody = new URLSearchParams({ q: query, kl: 'it-it' }).toString();
  const res = await safeOutboundFetch(htmlUrl, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://html.duckduckgo.com/',
    },
    body: formBody,
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status.toString()}`);
  const { text: html } = await readTextTruncated(res, 2_000_000);
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $('.result').each((_, el) => {
    if (results.length >= limit) return false;
    const $el = $(el);
    const title = $el.find('.result__title').text().trim();
    const href = $el.find('.result__url').attr('href') ?? $el.find('.result__title a').attr('href') ?? '';
    const snippet = $el.find('.result__snippet').text().trim();
    if (!title || !href) return;
    let cleanUrl = href;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      cleanUrl = uddg ? decodeURIComponent(uddg) : u.toString();
    } catch { /* keep raw */ }
    results.push({ title, url: cleanUrl, snippet });
    return undefined;
  });
  return { query, provider: 'duckduckgo', results };
}

/** Parse lite.duckduckgo.com HTML — tabella con `<a class="result-link">`. */
function parseLiteDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  // Lite format: ogni risultato è una riga tabella con due celle:
  //   <td><a class="result-link" href="URL">TITLE</a></td>
  //   <td class="result-snippet">SNIPPET</td>
  // Le righe sono raggruppate a triple: title-row, snippet-row, url-row.
  $('a.result-link').each((_, el) => {
    if (results.length >= limit) return false;
    const $a = $(el);
    const title = $a.text().trim();
    let href = $a.attr('href') ?? '';
    // Lite usa redirect /l/?uddg=encoded_url — decodifica
    try {
      const u = new URL(href, 'https://lite.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      href = uddg ? decodeURIComponent(uddg) : u.toString();
    } catch { /* keep raw */ }
    // Snippet è nella cella successiva nella stessa <tr> dello snippet
    const $tr = $a.closest('tr');
    const $snippetTr = $tr.next('tr');
    const snippet = $snippetTr.find('td.result-snippet').text().trim()
                ?? $snippetTr.find('td').last().text().trim();
    if (!title || !href) return;
    results.push({ title, url: href, snippet });
    return undefined;
  });
  return results;
}
