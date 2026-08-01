/**
 * Legitimate bot allowlist — comprehensive registry of "safe to allow" bots.
 *
 * Used by SENTINEL Layer 2 (User-Agent classification) + analytics script to:
 *   1. EXEMPT verified bots from rate-limit / honeypot scoring (they have
 *      legitimate scraping needs: search indexing, social previews,
 *      uptime monitoring, security research, LLM training)
 *   2. DETECT spoofers: if UA dichiara Googlebot ma reverse-DNS != *.googlebot.com
 *      → marca come bot_spoofato + bonus to behavioral score
 *
 * Categories:
 *   - search_engine: Google/Bing/Baidu/Yandex/Yahoo/DuckDuckGo
 *   - llm_fetcher: GPTBot/ClaudeBot/PerplexityBot/Amazonbot/CCBot/Bytespider
 *   - social_preview: facebook/twitter/linkedin/discord/whatsapp/telegram (OG fetch)
 *   - seo_tool: ahrefs/semrush/moz/dotbot/mj12/serpstat
 *   - uptime_monitor: uptimerobot/pingdom/statuscake/gtmetrix
 *   - security_research: censys/shodan/binaryedge/zoominfo/internetmeasurement
 *   - cdn_purge: cloudflare-prefetch/akamai/fastly/cloudfront origin pulls
 *   - generic_crawler: archive.org/commoncrawl/openalex
 *
 * Reverse-DNS verification: per il subset di bot che pubblicano il suffisso
 * ufficiale (Google: *.googlebot.com / *.google.com, Bing: *.search.msn.com).
 * Per gli altri (UA-only): si fida solo dell'UA — non verificabile in DNS.
 *
 * Reference:
 *   - Googlebot:  https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot
 *   - Bingbot:    https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0
 *   - DuckDuckBot: https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot
 *   - Applebot:    https://support.apple.com/en-us/119829
 *   - GPTBot:      https://platform.openai.com/docs/gptbot
 *   - ClaudeBot:   https://docs.anthropic.com/en/api/web-search#claudebot-and-claude-user
 *   - PerplexityBot: https://docs.perplexity.ai/guides/bots
 */

export type BotCategory =
  | 'search_engine'
  | 'llm_fetcher'
  | 'social_preview'
  | 'seo_tool'
  | 'uptime_monitor'
  | 'security_research'
  | 'cdn_purge'
  | 'generic_crawler';

export interface LegitimateBot {
  /** Display name (es. "Googlebot"). */
  readonly name: string;
  /** Categoria comportamentale per scoring. */
  readonly category: BotCategory;
  /** Pattern UA — usa /i implicito. */
  readonly uaPattern: RegExp;
  /** Suffix DNS che il reverse del IP DEVE matchare. null se UA-only trust. */
  readonly verifyReverseDnsSuffix: readonly string[] | null;
  /** Opzionale: link doc ufficiale (audit trail). */
  readonly docUrl?: string;
}

/**
 * Registry completo bot legittimi. Ordinato per famiglia per leggibilità.
 *
 * IMPORTANT: l'ordine NON conta (matchLegitimateBot fa lookup esatto via UA
 * regex). Ma manteniamolo per famiglia per debug + manutenzione.
 */
export const LEGITIMATE_BOTS: readonly LegitimateBot[] = Object.freeze([
  // ─── Search engines ─────────────────────────────────────────────
  {
    name: 'Googlebot',
    category: 'search_engine',
    uaPattern: /Googlebot(?:\/|-Image|-Video|-News)/i,
    verifyReverseDnsSuffix: ['.googlebot.com', '.google.com'],
    docUrl: 'https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot',
  },
  {
    name: 'Googlebot-Mobile',
    category: 'search_engine',
    uaPattern: /Googlebot-Mobile/i,
    verifyReverseDnsSuffix: ['.googlebot.com'],
  },
  {
    name: 'Google-InspectionTool',
    category: 'search_engine',
    uaPattern: /Google-InspectionTool|Google-Site-Verification/i,
    verifyReverseDnsSuffix: ['.googlebot.com', '.google.com'],
  },
  {
    name: 'AdsBot-Google',
    category: 'search_engine',
    uaPattern: /AdsBot-Google/i,
    verifyReverseDnsSuffix: ['.googlebot.com'],
  },
  {
    name: 'Bingbot',
    category: 'search_engine',
    uaPattern: /bingbot/i,
    verifyReverseDnsSuffix: ['.search.msn.com'],
    docUrl: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0',
  },
  {
    name: 'MicrosoftPreview',
    category: 'search_engine',
    uaPattern: /BingPreview/i,
    verifyReverseDnsSuffix: ['.search.msn.com'],
  },
  {
    name: 'Yandex',
    category: 'search_engine',
    uaPattern: /YandexBot|YandexImages|YandexNews|YandexMobileBot/i,
    verifyReverseDnsSuffix: ['.yandex.com', '.yandex.ru', '.yandex.net'],
  },
  {
    name: 'Baiduspider',
    category: 'search_engine',
    uaPattern: /Baiduspider/i,
    verifyReverseDnsSuffix: ['.baidu.com', '.baidu.jp'],
  },
  {
    name: 'DuckDuckBot',
    category: 'search_engine',
    uaPattern: /DuckDuckBot|DuckDuckGo-Favicons-Bot/i,
    verifyReverseDnsSuffix: ['.duckduckgo.com'],
    docUrl: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot',
  },
  {
    name: 'Slurp',
    category: 'search_engine',
    uaPattern: /Yahoo!\s*Slurp|Yahoo-MMCrawler/i,
    verifyReverseDnsSuffix: ['.crawl.yahoo.net'],
  },
  {
    name: 'Sogou',
    category: 'search_engine',
    uaPattern: /Sogou (?:web|inst|news|orion|blog) spider/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'NaverBot',
    category: 'search_engine',
    uaPattern: /Yeti(?:\/|bot)|NaverBot/i,
    verifyReverseDnsSuffix: ['.naver.com'],
  },
  {
    name: 'Applebot',
    category: 'search_engine',
    uaPattern: /Applebot/i,
    verifyReverseDnsSuffix: ['.applebot.apple.com', '.apple.com'],
    docUrl: 'https://support.apple.com/en-us/119829',
  },
  {
    name: 'PetalBot',
    category: 'search_engine',
    uaPattern: /PetalBot|Petalbot/i,
    verifyReverseDnsSuffix: ['.petalsearch.com', '.huawei.com'],
  },
  {
    name: 'SeznamBot',
    category: 'search_engine',
    uaPattern: /SeznamBot/i,
    verifyReverseDnsSuffix: ['.seznam.cz'],
  },
  {
    name: 'Qwant',
    category: 'search_engine',
    uaPattern: /Qwantify|qwantbot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Brave-Bot',
    category: 'search_engine',
    uaPattern: /BraveBot|Search\.brave\.com/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Kagi-Bot',
    category: 'search_engine',
    uaPattern: /Kagibot/i,
    verifyReverseDnsSuffix: null,
  },

  // ─── LLM fetchers (training + RAG) ──────────────────────────────
  {
    name: 'GPTBot',
    category: 'llm_fetcher',
    uaPattern: /GPTBot/i,
    verifyReverseDnsSuffix: null,
    docUrl: 'https://platform.openai.com/docs/gptbot',
  },
  {
    name: 'ChatGPT-User',
    category: 'llm_fetcher',
    uaPattern: /ChatGPT-User|OAI-SearchBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'ClaudeBot',
    category: 'llm_fetcher',
    uaPattern: /ClaudeBot|claude-web/i,
    verifyReverseDnsSuffix: null,
    docUrl: 'https://docs.anthropic.com/en/api/web-search',
  },
  {
    name: 'anthropic-ai',
    category: 'llm_fetcher',
    uaPattern: /anthropic-ai/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'PerplexityBot',
    category: 'llm_fetcher',
    uaPattern: /PerplexityBot|Perplexity-User/i,
    verifyReverseDnsSuffix: null,
    docUrl: 'https://docs.perplexity.ai/guides/bots',
  },
  {
    name: 'Bytespider',
    category: 'llm_fetcher',
    uaPattern: /Bytespider/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Amazonbot',
    category: 'llm_fetcher',
    uaPattern: /Amazonbot/i,
    verifyReverseDnsSuffix: ['.crawl.amazon.com'],
  },
  {
    name: 'CCBot',
    category: 'llm_fetcher',
    uaPattern: /CCBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Google-Extended',
    category: 'llm_fetcher',
    uaPattern: /Google-Extended/i,
    verifyReverseDnsSuffix: ['.googlebot.com'],
  },
  {
    name: 'Cohere-AI',
    category: 'llm_fetcher',
    uaPattern: /cohere-ai|cohere-training/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'DiffBot',
    category: 'llm_fetcher',
    uaPattern: /Diffbot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'omgili',
    category: 'llm_fetcher',
    uaPattern: /omgili/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'MistralAI-User',
    category: 'llm_fetcher',
    uaPattern: /MistralAI-User/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'YouBot',
    category: 'llm_fetcher',
    uaPattern: /YouBot/i,
    verifyReverseDnsSuffix: null,
  },

  // ─── Social previews (Open Graph fetch) ─────────────────────────
  {
    name: 'facebookexternalhit',
    category: 'social_preview',
    uaPattern: /facebookexternalhit|FacebookBot|meta-externalagent/i,
    verifyReverseDnsSuffix: ['.fbsbx.com', '.facebook.com'],
  },
  {
    // NB: TelegramBot DEVE essere ordinato PRIMA di Twitterbot perché alcuni
    // UA Telegram contengono il fragment "like TwitterBot" → match-first-wins
    // andrebbe sul pattern Twitterbot sbagliando categoria.
    name: 'TelegramBot-Preview',
    category: 'social_preview',
    uaPattern: /TelegramBot(?=\s|\/|$|\()/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Twitterbot',
    category: 'social_preview',
    uaPattern: /Twitterbot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'LinkedInBot',
    category: 'social_preview',
    uaPattern: /LinkedInBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'WhatsApp',
    category: 'social_preview',
    uaPattern: /WhatsApp\/|WhatsApp$/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Discordbot',
    category: 'social_preview',
    uaPattern: /Discordbot/i,
    verifyReverseDnsSuffix: null,
  },
  // TelegramBot definito sopra come TelegramBot-Preview (ordine ANTI-spoof
  // vs Twitterbot). Vecchia entry rimossa per dedupe.
  {
    name: 'SkypeUriPreview',
    category: 'social_preview',
    uaPattern: /SkypeUriPreview/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Slackbot-LinkExpanding',
    category: 'social_preview',
    uaPattern: /Slackbot-LinkExpanding|Slack-ImgProxy/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Pinterest',
    category: 'social_preview',
    uaPattern: /Pinterest(?:\/|bot|imageresolver)/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'redditbot',
    category: 'social_preview',
    uaPattern: /redditbot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Mastodon-Preview',
    category: 'social_preview',
    uaPattern: /Mastodon\/|Pleroma\//i,
    verifyReverseDnsSuffix: null,
  },

  // ─── SEO tools ──────────────────────────────────────────────────
  {
    name: 'AhrefsBot',
    category: 'seo_tool',
    uaPattern: /AhrefsBot|AhrefsSiteAudit/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'SemrushBot',
    category: 'seo_tool',
    uaPattern: /SemrushBot|Semrush\//i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'MJ12bot',
    category: 'seo_tool',
    uaPattern: /MJ12bot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'DotBot',
    category: 'seo_tool',
    uaPattern: /DotBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'rogerbot',
    category: 'seo_tool',
    uaPattern: /rogerbot|MozBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'DataForSeoBot',
    category: 'seo_tool',
    uaPattern: /DataForSeoBot|DataForSEO/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'SerpstatBot',
    category: 'seo_tool',
    uaPattern: /SerpstatBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'LinkpadBot',
    category: 'seo_tool',
    uaPattern: /LinkpadBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'SeokicksBot',
    category: 'seo_tool',
    uaPattern: /SeokicksBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'YandexMetrika',
    category: 'seo_tool',
    uaPattern: /YandexMetrika/i,
    verifyReverseDnsSuffix: ['.yandex.com', '.yandex.ru'],
  },

  // ─── Uptime monitoring ──────────────────────────────────────────
  {
    name: 'UptimeRobot',
    category: 'uptime_monitor',
    uaPattern: /UptimeRobot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Pingdom',
    category: 'uptime_monitor',
    uaPattern: /Pingdom/i,
    verifyReverseDnsSuffix: ['.pingdom.com'],
  },
  {
    name: 'StatusCake',
    category: 'uptime_monitor',
    uaPattern: /StatusCake/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'GTmetrix',
    category: 'uptime_monitor',
    uaPattern: /GTmetrix/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'newrelic',
    category: 'uptime_monitor',
    uaPattern: /NewRelicPinger|newrelic_pinger/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Site24x7',
    category: 'uptime_monitor',
    uaPattern: /Site24x7/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'BetterUptime',
    category: 'uptime_monitor',
    uaPattern: /BetterUptime|Better Stack/i,
    verifyReverseDnsSuffix: null,
  },

  // ─── Security research ──────────────────────────────────────────
  {
    name: 'CensysInspect',
    category: 'security_research',
    uaPattern: /CensysInspect/i,
    verifyReverseDnsSuffix: ['.censys-scanner.com', '.censys.io'],
  },
  {
    name: 'InternetMeasurement',
    category: 'security_research',
    uaPattern: /InternetMeasurement|Internet-Measurement/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'BinaryEdge',
    category: 'security_research',
    uaPattern: /BinaryEdge|binaryedge\.ninja/i,
    verifyReverseDnsSuffix: ['.binaryedge.ninja'],
  },
  {
    name: 'Shodan-Crawler',
    category: 'security_research',
    uaPattern: /Shodan/i,
    verifyReverseDnsSuffix: ['.shodan.io'],
  },
  {
    name: 'NetSystemsResearch',
    category: 'security_research',
    uaPattern: /NetSystemsResearch/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Mozilla-Observatory',
    category: 'security_research',
    uaPattern: /Mozilla\/.*Observatory/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Qualys-SSL-Labs',
    category: 'security_research',
    uaPattern: /SSL Labs|Qualys SSL Labs/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'SecurityTrails',
    category: 'security_research',
    uaPattern: /SecurityTrails/i,
    verifyReverseDnsSuffix: null,
  },

  // ─── Generic crawlers (archive / commons) ──────────────────────
  {
    name: 'ia_archiver',
    category: 'generic_crawler',
    uaPattern: /ia_archiver|archive\.org_bot/i,
    verifyReverseDnsSuffix: ['.archive.org'],
  },
  {
    name: 'CommonCrawl',
    category: 'generic_crawler',
    uaPattern: /commoncrawl\.org|CCBot/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'OpenAlex',
    category: 'generic_crawler',
    uaPattern: /OpenAlex/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Wayback-Machine',
    category: 'generic_crawler',
    uaPattern: /Wayback Machine Live Record/i,
    verifyReverseDnsSuffix: ['.archive.org'],
  },
  {
    name: 'curl-user',
    category: 'generic_crawler',
    // curl LEGIT (es. utente che testa endpoint pubblico). Score basso ma
    // non hostile come "curl/X.Y.Z" da scanner. Differenziamo solo se UA
    // contiene "curl/" senza altri suffissi (= probably real user).
    uaPattern: /^curl\/[0-9]+\.[0-9]+(?:\.[0-9]+)?$/i,
    verifyReverseDnsSuffix: null,
  },

  // ─── CDN purge / pre-cache ─────────────────────────────────────
  {
    name: 'Cloudflare-AlwaysOnline',
    category: 'cdn_purge',
    uaPattern: /Cloudflare-AlwaysOnline|cf-prefetch|cloudflare-traffic/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'CloudFront',
    category: 'cdn_purge',
    uaPattern: /Amazon CloudFront/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Fastly-Healthcheck',
    category: 'cdn_purge',
    uaPattern: /Fastly Healthcheck|Fastly-Test/i,
    verifyReverseDnsSuffix: null,
  },
  {
    name: 'Akamai-NetSession',
    category: 'cdn_purge',
    uaPattern: /Akamai NetSession Interface|Akamai-SiteShield/i,
    verifyReverseDnsSuffix: null,
  },
]);

export interface BotMatch {
  readonly name: string;
  readonly category: BotCategory;
  readonly verifyReverseDnsSuffix: readonly string[] | null;
}

/**
 * Match a UA against the allowlist. Returns the first match (UA family).
 *
 * @returns BotMatch on hit, null otherwise.
 */
export function matchLegitimateBot(userAgent: string): BotMatch | null {
  if (!userAgent || userAgent.length === 0) return null;
  for (const b of LEGITIMATE_BOTS) {
    if (b.uaPattern.test(userAgent)) {
      return {
        name: b.name,
        category: b.category,
        verifyReverseDnsSuffix: b.verifyReverseDnsSuffix,
      };
    }
  }
  return null;
}

/**
 * Verifica reverse DNS forte: PTR(ip) → hostname, hostname.endsWith(suffix)
 * per ALMENO uno dei suffixi pubblicati dal vendor del bot. Pattern
 * anti-spoofing standard usato da Google/Bing/Yandex.
 *
 * @param reverseDnsHostname il PTR del IP (es. "crawl-66-249-72-1.googlebot.com")
 * @param expectedSuffixes lista di suffixi che ANY-match accetta
 * @returns true se confermato come legittimo bot, false altrimenti.
 */
export function verifyReverseDns(
  reverseDnsHostname: string | null,
  expectedSuffixes: readonly string[],
): boolean {
  if (!reverseDnsHostname) return false;
  const host = reverseDnsHostname.toLowerCase().replace(/\.$/, '');
  return expectedSuffixes.some((sfx) => {
    const s = sfx.toLowerCase().replace(/^\.?/, '.');
    return host.endsWith(s);
  });
}

/**
 * Classifica un IP/UA in 3 categorie:
 *  - 'verified_legit': UA matcha allowlist + reverse-DNS confermato (o vendor
 *    senza DNS suffix obbligatorio → UA-trust-only).
 *  - 'ua_claimed_spoofable': UA matcha allowlist MA vendor pubblica suffix DNS
 *    e il reverse non matcha → SPOOFER (es. UA dichiara Googlebot ma è IP AWS).
 *  - 'unknown': UA non in allowlist (potrebbe essere bot non listato O umano).
 */
export type BotVerificationStatus = 'verified_legit' | 'ua_claimed_spoofable' | 'unknown';

export function classifyBot(
  userAgent: string,
  reverseDnsHostname: string | null,
): { status: BotVerificationStatus; match: BotMatch | null } {
  const match = matchLegitimateBot(userAgent);
  if (!match) return { status: 'unknown', match: null };
  // UA-only trust (vendor non pubblica suffix DNS) → accettiamo l'UA
  if (match.verifyReverseDnsSuffix === null) {
    return { status: 'verified_legit', match };
  }
  // Vendor pubblica DNS suffix → DOBBIAMO verificare
  const ok = verifyReverseDns(reverseDnsHostname, match.verifyReverseDnsSuffix);
  return {
    status: ok ? 'verified_legit' : 'ua_claimed_spoofable',
    match,
  };
}
