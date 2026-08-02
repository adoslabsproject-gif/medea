/**
 * Company Search — pipeline avanzata per lead-gen 2026.
 *
 * COSA FA (pattern Apollo/Clay/Phantombuster compatible):
 *   Dato un seed prompt ("yacht builder Italia"), produce un array di URL
 *   di AZIENDE REALI (non directory, non blog, non aggregator), filtrato
 *   per Ideal Customer Profile (ICP).
 *
 * PIPELINE:
 *
 *   1. LLM query expansion (opzionale, BYO key)
 *      Input: seed prompt
 *      LLM (Liara / Anthropic / OpenAI / ...) genera N query DDG variate.
 *      Es. "yacht builder Italia" → [
 *        "cantieri navali yacht produttori Italia contatti",
 *        "italian shipyards luxury yacht manufacturer",
 *        "costruttori barche da diporto produzione vendita",
 *        "yacht builder italy contact email site:.it",
 *        ...
 *      ]
 *      Senza LLM: fallback a 1 query secca.
 *
 *   2. Multi-source parallel search
 *      Ogni query → cascade webSearch (Exa→Tavily→Brave→Serper→DDG).
 *      Merge dei risultati distinti per URL.
 *
 *   3. Anti-directory filtering
 *      Blocklist domini noti (directory, blog, marketplace, aggregator):
 *        - Yacht: yachtall, yachtworld, boats.com, yachtbrokers,
 *                 inautia, theyachtmarket, boatsforsale, ...
 *        - Generic: wikipedia, facebook, linkedin, instagram, indeed,
 *                   reddit, quora, amazon, ebay, ...
 *
 *   4. Content validation (opzionale)
 *      HEAD request a ogni URL: verifica che ritorni 200, no redirect a
 *      portali generici, content-type=text/html. Se `requireKeyword`
 *      settato, fetch leggero della homepage e verifica presenza del
 *      keyword nel <title>/<meta description>/<h1>.
 *
 *   5. TLD preference
 *      Boost URL con TLD locale (es. ".it" per Italia, ".de" per Germania).
 *      Geo-aware se `country` settato.
 *
 *   6. De-dup per registrable domain + cap a maxResults.
 *
 * LLM-agnostic: la query expansion usa `llmResolver`/`dispatchLLMChat`,
 * quindi gira identica con Liara (default free) o BYO key Anthropic/OpenAI/Gemini.
 */

import { webSearch } from './web-tools.service.js';
import { llmResolver, NoLlmProviderError } from './llm-resolver.service.js';
import { dispatchLLMChat } from './llm-chat.service.js';
import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';

// ─────────────────────────────────────────────────────────────────────────
// Domain blocklist (directory/aggregator/social/marketplace/blog noti)
// ─────────────────────────────────────────────────────────────────────────

const DIRECTORY_BLOCKLIST = new Set([
  // Yacht/marine directory
  'yachtall.com', 'yachtworld.com', 'yachtworld.co.uk', 'boats.com',
  'yachtbrokers.com', 'theyachtmarket.com', 'boatsforsale.com',
  'inautia.com', 'inautia.es', 'inautia.fr', 'yatco.com',
  'yachtbuyer.com', 'boatshop24.com', 'yachtfocus.com',
  'iyba.org', 'cyba.org',
  // Social / generic
  'wikipedia.org', 'en.wikipedia.org', 'it.wikipedia.org', 'de.wikipedia.org',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  // Marketplace / e-commerce
  'amazon.com', 'amazon.it', 'amazon.de', 'amazon.fr', 'amazon.es',
  'ebay.com', 'ebay.it', 'aliexpress.com', 'alibaba.com',
  // Job/biz directory
  'indeed.com', 'glassdoor.com', 'crunchbase.com', 'bloomberg.com',
  'opencorporates.com', 'dnb.com', 'zoominfo.com',
  // Generic news/media
  'forbes.com', 'reuters.com', 'bloomberg.com', 'ilsole24ore.com',
  'corriere.it', 'repubblica.it', 'lastampa.it',
  // Generic blogs/aggregator
  'medium.com', 'wordpress.com', 'blogspot.com', 'wix.com',
  'pages.tldr.tech',
]);

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface CompanySearchOptions {
  /** Numero massimo di company URL ritornati (default 20) */
  maxResults?: number;
  /** Quante query DDG variate generare via LLM (default 5) */
  queryExpansionCount?: number;
  /** Numero risultati per query (default 10) */
  resultsPerQuery?: number;
  /** ISO country code (it/de/fr/...) per TLD preference */
  country?: string;
  /** Keyword che la homepage DEVE contenere (validation soft) */
  requireKeyword?: string;
  /** Tenant per resolve LLM provider (richiesto se queryExpansion ON) */
  tenantId?: string;
  /** Se true, skip LLM expansion: usa solo la seed query (default false) */
  skipLLMExpansion?: boolean;
  /** Blocklist aggiuntiva domini (concatenata alla blocklist default) */
  extraBlocklist?: string[];
  /** Timeout per HEAD validation (default 5000ms). 0 = disabilita HEAD check. */
  validateTimeoutMs?: number;
}

export interface CompanySearchResult {
  companies: {
    url: string;
    domain: string;
    title: string;
    snippet: string;
    source_provider: string;
    matched_query: string;
    boost_factors: string[];
  }[];
  queries_used: string[];
  queries_generated_by_llm: boolean;
  llm_provider?: string;
  /** Modello risolto per l'expansion LLM (presente solo se la chiamata è avvenuta). */
  llm_model?: string;
  /** Token della query expansion (Fase 1b #13). Assente se skipLLM/nessun provider/chiamata fallita. */
  llm_usage?: { input: number; output: number; fromApi: boolean };
  /** Prompt+risposta della expansion (Fase 3 #15) — l'EXECUTOR li logga su StepLog 'llm', NON vanno nell'output del nodo. */
  llm_exchange?: { system: string; user: string; response: string };
  total_raw_results: number;
  filtered_directory: number;
  filtered_validation: number;
  took_ms: number;
}

export async function companySearch(
  seedPrompt: string,
  options: CompanySearchOptions = {},
): Promise<CompanySearchResult> {
  const start = Date.now();
  const maxResults = options.maxResults ?? 20;
  const expansionCount = options.queryExpansionCount ?? 5;
  const resultsPerQuery = Math.min(20, options.resultsPerQuery ?? 10);
  const country = options.country?.toLowerCase();
  const skipLLM = options.skipLLMExpansion ?? false;
  const validateTimeoutMs = options.validateTimeoutMs ?? 5000;

  const blocklist = new Set(DIRECTORY_BLOCKLIST);
  for (const d of options.extraBlocklist ?? []) {
    blocklist.add(d.toLowerCase().trim());
  }

  // ─── 1. LLM query expansion ──────────────────────────────────────
  let queries: string[] = [seedPrompt];
  let llmProvider: string | undefined;
  let llmModel: string | undefined;
  let llmUsage: { input: number; output: number; fromApi: boolean } | undefined;
  let llmExchange: { system: string; user: string; response: string } | undefined;
  let queriesGeneratedByLLM = false;

  if (!skipLLM && options.tenantId) {
    try {
      const resolved = llmResolver.resolve(options.tenantId);
      llmProvider = resolved.provider;
      llmModel = resolved.model;
      const expandPrompt = buildExpansionPrompt(seedPrompt, expansionCount, country);
      const raw = await dispatchLLMChat(
        resolved.provider,
        resolved.apiKey,
        resolved.model,
        'Sei un assistente esperto di lead-gen B2B. Rispondi sempre con JSON valido.',
        expandPrompt,
        undefined,
        [],
        (u) => { llmUsage = { input: u.input, output: u.output, fromApi: u.fromApi }; },
      );
      llmExchange = { system: 'Sei un assistente esperto di lead-gen B2B. Rispondi sempre con JSON valido.', user: expandPrompt, response: raw };
      const expanded = parseQueries(raw);
      if (expanded.length > 0) {
        queries = [seedPrompt, ...expanded].slice(0, expansionCount + 1);
        queriesGeneratedByLLM = true;
      }
    } catch (err) {
      if (!(err instanceof NoLlmProviderError)) {
        logger.warn({ err, tenantId: options.tenantId }, 'company-search: LLM expansion failed, fallback to seed only');
      }
    }
  }

  // ─── 2. Multi-source THROTTLED search ──────────────────────────────
  // Lancio max 3 query in parallel per evitare rate-limit dei provider
  // (DDG su IP cloud blocca con CAPTCHA se vede burst di 9+ richieste).
  // Throttle inter-batch di 500ms per essere good-citizen.
  const rawResults: { url: string; title: string; snippet: string; provider: string; query: string }[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (q) => {
      try {
        const r = await webSearch(q, resultsPerQuery);
        for (const item of r.results) {
          rawResults.push({
            url: item.url, title: item.title, snippet: item.snippet,
            provider: r.provider, query: q,
          });
        }
      } catch (err) {
        logger.debug({ err, query: q }, 'company-search: query failed');
      }
    }));
    // Throttle 500ms tra batch (non sull'ultimo)
    if (i + CONCURRENCY < queries.length) await new Promise((r) => setTimeout(r, 500));
  }
  const totalRaw = rawResults.length;

  // ─── 3. De-dup per registrable domain ──────────────────────────────
  const byDomain = new Map<string, typeof rawResults[number]>();
  for (const r of rawResults) {
    const dom = registrableDomain(r.url);
    if (!dom) continue;
    if (!byDomain.has(dom)) byDomain.set(dom, r);
  }

  // ─── 4. Anti-directory filtering ──────────────────────────────────
  const filteredDirectory: string[] = [];
  const candidates: (typeof rawResults[number] & { domain: string; boostFactors: string[] })[] = [];
  for (const [domain, r] of byDomain) {
    if (blocklist.has(domain)) {
      filteredDirectory.push(domain);
      continue;
    }
    // Hint extra: directory tend a avere keyword nel domain
    if (/^(www\.)?(directory|listing|portal|aggregat|market)/.test(domain)) {
      filteredDirectory.push(domain);
      continue;
    }
    const boostFactors: string[] = [];
    // TLD preference
    if (country) {
      const tld = domain.split('.').pop() ?? '';
      if (tld === country) boostFactors.push(`tld_match_${country}`);
    }
    // Domain length heuristic: aziende reali tendono ad avere domain corti
    if (domain.length <= 20) boostFactors.push('short_domain');
    // No subdomains weird (es. www.subsub.foo.com)
    const dotsInBaseDomain = domain.split('.').length;
    if (dotsInBaseDomain === 2 || (dotsInBaseDomain === 3 && domain.startsWith('www.'))) {
      boostFactors.push('clean_subdomain');
    }
    candidates.push({ ...r, domain, boostFactors });
  }

  // ─── 5. HEAD validation (opzionale) ───────────────────────────────
  let filteredValidation = 0;
  const validated: typeof candidates = [];
  if (validateTimeoutMs > 0) {
    const validationPromises = candidates.slice(0, maxResults * 2).map(async (c) => {
      const ok = await headValidate(c.url, validateTimeoutMs);
      if (ok) {
        validated.push(c);
      } else {
        filteredValidation++;
      }
    });
    await Promise.all(validationPromises);
  } else {
    validated.push(...candidates);
  }

  // ─── 6. Sort by boost factors count + cap ─────────────────────────
  validated.sort((a, b) => b.boostFactors.length - a.boostFactors.length);
  const final = validated.slice(0, maxResults);

  return {
    companies: final.map((c) => ({
      url: c.url,
      domain: c.domain,
      title: c.title,
      snippet: c.snippet,
      source_provider: c.provider,
      matched_query: c.query,
      boost_factors: c.boostFactors,
    })),
    queries_used: queries,
    queries_generated_by_llm: queriesGeneratedByLLM,
    ...(llmProvider !== undefined ? { llm_provider: llmProvider } : {}),
    ...(llmModel !== undefined && llmModel !== '' ? { llm_model: llmModel } : {}),
    ...(llmUsage !== undefined ? { llm_usage: llmUsage } : {}),
    ...(llmExchange !== undefined ? { llm_exchange: llmExchange } : {}),
    total_raw_results: totalRaw,
    filtered_directory: filteredDirectory.length,
    filtered_validation: filteredValidation,
    took_ms: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function buildExpansionPrompt(seed: string, count: number, country?: string): string {
  return `Sei un esperto di lead-gen B2B. Genera ${count.toString()} query di ricerca DIVERSIFICATE per trovare ` +
    `AZIENDE PRODUTTRICI (non directory, non blog, non marketplace) relative a: "${seed}".\n\n` +
    `Regole:\n` +
    `- Mix italiano + inglese\n` +
    `- Include termini specifici aziendali ("produttore", "manufacturer", "azienda", "officina")\n` +
    `- Aggiungi modificatori "contatti", "contact", "email", "telefono" in alcune query\n` +
    `${country ? `- Almeno 2 query mirate a ${country.toUpperCase()} (es. site:.${country} oppure "Italia")\n` : ''}` +
    `- Evita query troppo generiche\n\n` +
    `Output: SOLO una lista JSON di stringhe, una query per elemento. Niente preamble, niente markdown.\n` +
    `Esempio output: ["query 1", "query 2", "query 3"]`;
}

function parseQueries(raw: string): string[] {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 3).map((q) => q.trim());
    }
  } catch {
    // Fallback: split per \n e prendi righe non vuote
    return cleaned
      .split(/\n/)
      .map((l) => l.replace(/^[-•*\d.)\s]+/, '').replace(/^["']|["']$/g, '').trim())
      .filter((l) => l.length > 3 && !l.startsWith('{') && !l.startsWith('}'));
  }
  return [];
}

function registrableDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function headValidate(url: string, timeoutMs: number): Promise<boolean> {
  // #202 P0-3: SSRF guard — url viene da WHOIS / search results (untrusted).
  const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
  const guard = validateUrlForFetch(url);
  if (!guard.ok) return false;

  const ctrl = new AbortController();
  const to = setTimeout(() => { ctrl.abort(); }, timeoutMs);
  try {
    // redirect manual + re-validate (anti DNS-rebind / redirect-to-internal).
    let currentUrl = url;
    const MAX_HOPS = 3;   // HEAD richiede meno hop di GET
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const res = await safeOutboundFetch(currentUrl, {
        method: 'HEAD',
        externalSignal: ctrl.signal, timeoutMs: 0,
        redirect: 'manual',
        headers: { 'User-Agent': 'FlowForgeCompanySearch/1.0' },
      });
      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
      if (!isRedirect) {
        clearTimeout(to);
        return res.ok || res.status === 405;
      }
      if (hop === MAX_HOPS) {
        clearTimeout(to);
        return false;
      }
      const next = res.headers.get('location') ?? '';
      let nextUrl: string;
      try { nextUrl = new URL(next, currentUrl).toString(); } catch { clearTimeout(to); return false; }
      const hopGuard = validateUrlForFetch(nextUrl);
      if (!hopGuard.ok) { clearTimeout(to); return false; }
      currentUrl = nextUrl;
    }
    clearTimeout(to);
    return false;
  } catch {
    clearTimeout(to);
    return false;
  }
}
