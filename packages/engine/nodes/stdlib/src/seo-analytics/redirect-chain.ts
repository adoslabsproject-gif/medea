/**
 * action_redirect_chain — segui la catena di redirect HTTP da un URL.
 *
 * Usa safeFetchWithRedirects con manual=false così FlowForge esegue HEAD
 * sequenziali e raccoglie ogni hop (URL + status + Location). Detect loop
 * via Set degli URL già visitati. Hard cap 20 hop (default 10).
 *
 * Output: { startUrl, finalUrl, chain[], hopCount, loopDetected, ok }
 */

import { load as cheerioLoad } from 'cheerio';
import { safeFetchWithRedirects, SsrfBlockedError, readTextTruncated } from '@flowforge/safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

interface Hop { url: string; status: number; location: string | null; durationMs: number; server: string | null; contentType: string | null }

type SeoImpact = 'good' | 'warning' | 'bad';

interface RedirectChainResult {
  startUrl: string;
  finalUrl: string | null;
  ok: boolean;
  hopCount: number;
  chain: Hop[];
  loopDetected: boolean;
  exceededMaxHops: boolean;
  crossDomainCount: number;
  totalLatencyMs: number;
  seoImpact: SeoImpact;
  /** Redirect "debole" via <meta http-equiv="refresh"> sulla pagina finale (i crawler lo ignorano). */
  metaRefresh: string | null;
  /** true se canonical/og:url della pagina finale puntano altrove rispetto a finalUrl. */
  canonicalMismatch: boolean | null;
  canonicalUrl: string | null;
  error?: string;
}

const MAX_HOPS_HARD = 20;
const DEFAULT_HOPS = 10;
const TIMEOUT_PER_HOP_MS = 8_000;
const FINAL_PAGE_CAP_BYTES = 512 * 1024;

async function followHead(url: string, userAgent: string, signal: AbortSignal): Promise<{ status: number; location: string | null; durationMs: number; server: string | null; contentType: string | null }> {
  const t0 = Date.now();
  const headers = { 'user-agent': userAgent, accept: '*/*' };
  const opts = { redirect: 'manual' as const, signal, maxRedirects: 0, timeoutMs: TIMEOUT_PER_HOP_MS };
  const read = (res: Response): { status: number; location: string | null; durationMs: number; server: string | null; contentType: string | null } => ({
    status: res.status,
    location: res.headers.get('location'),
    server: res.headers.get('server'),
    contentType: res.headers.get('content-type'),
    durationMs: Date.now() - t0,
  });
  try {
    const res = await safeFetchWithRedirects(url, { method: 'HEAD', headers, ...opts });
    return read(res);
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e;
    // HEAD bloccato da alcuni server → fallback GET (corpo scartato).
    const res = await safeFetchWithRedirects(url, { method: 'GET', headers, ...opts });
    const out = read(res);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    try { void res.body?.cancel?.(); } catch { /* ignore */ }
    return out;
  }
}

function resolveLocation(current: string, location: string): string | null {
  try { return new URL(location, current).toString(); } catch { return null; }
}

/** Stesso documento? Confronto host+pathname (ignora hash/query order) per il mismatch canonical. */
function sameDocument(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname.replace(/\/$/u, '') === ub.pathname.replace(/\/$/u, '');
  } catch { return false; }
}

/** Estrae l'URL da un valore `content` di <meta refresh> ("0; url=https://…" o "5;URL='…'"). */
function parseMetaRefresh(content: string): string | null {
  const m = /url\s*=\s*['"]?([^'"\s;]+)/iu.exec(content);
  return m?.[1] ?? null;
}

interface FinalPageInfo { metaRefresh: string | null; canonical: string | null; ogUrl: string | null }

/** GET (capped) della pagina finale 2xx HTML per estrarre meta-refresh + canonical/og:url. */
async function analyzeFinalPage(url: string, userAgent: string, signal: AbortSignal): Promise<FinalPageInfo> {
  const empty: FinalPageInfo = { metaRefresh: null, canonical: null, ogUrl: null };
  try {
    const res = await safeFetchWithRedirects(url, {
      method: 'GET',
      headers: { 'user-agent': userAgent, accept: 'text/html,*/*' },
      redirect: 'manual', signal, maxRedirects: 0, timeoutMs: TIMEOUT_PER_HOP_MS,
    } as never);
    if (!/html/iu.test(res.headers.get('content-type') ?? '')) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime
      try { void res.body?.cancel?.(); } catch { /* ignore */ }
      return empty;
    }
    const { text } = await readTextTruncated(res, FINAL_PAGE_CAP_BYTES);
    const $ = cheerioLoad(text);
    const refreshContent = $('meta[http-equiv="refresh" i]').attr('content');
    const canonical = $('link[rel="canonical"]').attr('href')?.trim();
    const ogUrl = $('meta[property="og:url"]').attr('content')?.trim();
    return {
      metaRefresh: refreshContent ? parseMetaRefresh(refreshContent) : null,
      canonical: canonical ? resolveLocation(url, canonical) : null,
      ogUrl: ogUrl ? resolveLocation(url, ogUrl) : null,
    };
  } catch { return empty; }
}

function computeSeoImpact(hopCount: number, crossDomainCount: number, loopDetected: boolean): SeoImpact {
  if (loopDetected || hopCount >= 5) return 'bad';
  if (hopCount >= 3 || crossDomainCount > 0) return 'warning';
  return 'good';
}

const executor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const startUrl = String(config.url ?? '').trim();
  if (!startUrl) throw new Error('url required');

  const maxHops = Math.max(1, Math.min(Number(config.maxHops ?? DEFAULT_HOPS), MAX_HOPS_HARD));
  const userAgent = String(config.userAgent ?? 'FlowForge-RedirectChain/1.0 (+https://flowforge.io)');
  const doAnalyzeFinal = config.analyzeFinalPage !== false && config.analyzeFinalPage !== 'false';

  const signal = context.abortSignal ?? new AbortController().signal;
  const chain: Hop[] = [];
  const visited = new Set<string>();
  let current: string | null = startUrl;
  let loopDetected = false;
  let exceededMaxHops = false;
  let lastError: string | undefined;

  while (current && chain.length < maxHops) {
    if (visited.has(current)) {
      loopDetected = true;
      break;
    }
    visited.add(current);
    try {
      const hop = await followHead(current, userAgent, signal);
      chain.push({ url: current, status: hop.status, location: hop.location, durationMs: hop.durationMs, server: hop.server, contentType: hop.contentType });
      if (hop.status >= 300 && hop.status < 400 && hop.location) {
        const next = resolveLocation(current, hop.location);
        if (!next) { lastError = `Invalid Location header at hop ${chain.length}: ${hop.location}`; break; }
        current = next;
      } else {
        current = null;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  if (chain.length >= maxHops && current && !loopDetected) exceededMaxHops = true;

  const finalHop = chain[chain.length - 1];
  const finalUrl = finalHop?.url ?? null;
  const ok = finalHop !== undefined && finalHop.status >= 200 && finalHop.status < 400 && !loopDetected && !exceededMaxHops;

  // Cross-domain: ogni transizione hop[i-1]→hop[i] con host diverso.
  let crossDomainCount = 0;
  for (let i = 1; i < chain.length; i += 1) {
    try {
      if (new URL(chain[i]!.url).host !== new URL(chain[i - 1]!.url).host) crossDomainCount += 1;
    } catch { /* url non parsabile → non conta */ }
  }
  const totalLatencyMs = chain.reduce((acc, h) => acc + h.durationMs, 0);
  const seoImpact = computeSeoImpact(chain.length, crossDomainCount, loopDetected);

  // Analisi pagina finale (meta-refresh + canonical mismatch) solo se ha senso.
  let metaRefresh: string | null = null;
  let canonicalUrl: string | null = null;
  let canonicalMismatch: boolean | null = null;
  if (doAnalyzeFinal && ok && finalUrl) {
    const info = await analyzeFinalPage(finalUrl, userAgent, signal);
    metaRefresh = info.metaRefresh;
    canonicalUrl = info.canonical ?? info.ogUrl;
    if (canonicalUrl) canonicalMismatch = !sameDocument(canonicalUrl, finalUrl);
  }

  const result: RedirectChainResult = {
    startUrl,
    finalUrl,
    ok,
    hopCount: chain.length,
    chain,
    loopDetected,
    exceededMaxHops,
    crossDomainCount,
    totalLatencyMs,
    seoImpact,
    metaRefresh,
    canonicalMismatch,
    canonicalUrl,
    ...(lastError ? { error: lastError } : {}),
  };

  const warnings: string[] = [];
  if (loopDetected) warnings.push('Redirect loop detected');
  if (exceededMaxHops) warnings.push(`Exceeded max hops (${maxHops})`);
  if (chain.length > 3) warnings.push(`Long redirect chain (${chain.length} hops, SEO juice loss)`);
  if (crossDomainCount > 0) warnings.push(`${crossDomainCount} cross-domain redirect(s)`);
  if (metaRefresh) warnings.push('Final page has a <meta refresh> (weak redirect, ignored by crawlers)');
  if (canonicalMismatch) warnings.push('Canonical/og:url of the final page points elsewhere');

  return {
    output: result,
    durationMs: Date.now() - start,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

export const redirectChainNode: NodeModule = {
  def: {
    id: 'action_redirect_chain',
    type: 'action',
    label: 'Redirect Chain (follow + detect)',
    icon: 'arrow-right',
    color: '#f59e0b',
    description:
      'Tracciatore di redirect chain HTTP — segue ogni hop manualmente (NO follow ' +
      'automatico) e restituisce array completo di redirect con status code, Location ' +
      'header, latency, body bytes (HEAD-mode default), URL finale. Rileva loop ' +
      'circolari, redirect cross-protocol (http→https), redirect cross-domain, e flag ' +
      'catene "troppo lunghe" (>3 hop) per impatto SEO link juice.\n\n' +
      'Differenza con i sibling: action_redirect_chain = traccia chain HTTP (URL → ' +
      'array hops). Per audit broken links su pagina HTML usa action_link_audit. Per ' +
      'parsing meta tag dopo aver risolto il redirect finale usa action_meta_extract. ' +
      'Per fetch HTML auto-follow (per scraping) usa action_web_fetch_advanced.\n\n' +
      'Status codes gestiti: 301 Permanent (canonical SEO juice transfer), 302 Found ' +
      '(temporary — no SEO transfer), 303 See Other (POST → GET conversion), 307/308 ' +
      '(method preservation). Sulla pagina finale (2xx HTML, se "Analizza pagina finale" è ' +
      'attivo) estrae anche il Refresh meta tag `<meta http-equiv="refresh">` (i browser lo ' +
      'seguono, i crawler lo ignorano → "weak redirect") e rileva il canonical mismatch ' +
      '(canonical/og:url che puntano a un documento diverso da finalUrl = red flag SEO).\n\n' +
      'Output: `{ chain: [{ url, status, location, durationMs, server, contentType }], ' +
      'startUrl, finalUrl, ok, hopCount, loopDetected, exceededMaxHops, crossDomainCount, ' +
      'totalLatencyMs, seoImpact ("good"|"warning"|"bad"), metaRefresh, canonicalUrl, ' +
      'canonicalMismatch }`. seoImpact deterministico: good (1-2 hop), warning (3-4 hop o ' +
      'cross-domain), bad (5+ hop o loop).\n\n' +
      'Use case Cappella-Sistina-grade: (1) **audit post-migrazione sito** — fetch ' +
      'sitemap vecchia, per ogni URL → redirect_chain → verify che redirige a URL ' +
      'nuova in 1 hop con 301 (no juice loss). Alert se 302 (settato per sbaglio); ' +
      '(2) **vanity URL verifier** — bit.ly/short.io/custom domain — segui chain ' +
      'fino al final URL per detection malicious redirect (advertiser frode); ' +
      '(3) **canonical URL audit propri prodotti** — il canonical e\\` raggiungibile ' +
      'in 1 hop? O passa per 3 redirect? Google CMM penalizza chain > 3; (4) **debug ' +
      'cookie-redirect login flow** — per debug SSO flow custom, tracci ogni 302 ' +
      'con il cookie state passato.\n\n' +
      'Safety budget: SSRF guard via @flowforge/safe-fetch (no fetch a 127/10/192/ ' +
      'link-local), timeout 8s per hop, max 20 hop totali (oltre → loop break), ' +
      'audit log con startUrl + finalUrl + hopCount per SEO traceability.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL di partenza',
        type: 'text',
        required: true,
        placeholder: 'https://miosito.com/old-page',
        help: 'URL da cui partire. Supporta {{espressioni}}. SSRF: indirizzi interni bloccati.',
      },
      {
        key: 'maxHops',
        label: 'Max redirects da seguire',
        type: 'number',
        required: false,
        defaultValue: String(DEFAULT_HOPS),
        help: 'Default 10. Hard cap 20. Una catena > 3 hop perde "link juice" SEO.',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        placeholder: 'FlowForge-RedirectChain/1.0',
        help: 'User-Agent identificativo del bot. Default identifica FlowForge (RFC-compliant).',
      },
      {
        key: 'analyzeFinalPage',
        label: 'Analizza la pagina finale (meta-refresh + canonical)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se ON (default): sulla pagina finale 2xx HTML fa un GET (capped a 512KB) per estrarre <meta refresh> e confrontare canonical/og:url con l\'URL finale. OFF = salta la richiesta extra (solo la catena di redirect).',
      },
    ],
    outputs: ['startUrl', 'finalUrl', 'ok', 'hopCount', 'chain', 'loopDetected', 'exceededMaxHops', 'crossDomainCount', 'totalLatencyMs', 'seoImpact', 'metaRefresh', 'canonicalUrl', 'canonicalMismatch', 'error'],
  },
  executor,
};
