/**
 * Tests bot-allowlist — verifica matching UA + reverse-DNS verification
 * + classifyBot 3-way (verified / spoofable / unknown).
 *
 * Standard: zero smoke. Ogni famiglia di bot ha test positivo + test
 * spoofer negativo. Verifica zero-false-positive su UA umani (Chrome,
 * Safari, Firefox).
 */
import { describe, it, expect } from 'vitest';
import {
  LEGITIMATE_BOTS,
  matchLegitimateBot,
  verifyReverseDns,
  classifyBot,
} from '../bot-allowlist.js';

describe('LEGITIMATE_BOTS registry', () => {
  it('è frozen (immutabile)', () => {
    expect(Object.isFrozen(LEGITIMATE_BOTS)).toBe(true);
  });

  it('ogni entry ha name + category + uaPattern + suffix slot', () => {
    for (const b of LEGITIMATE_BOTS) {
      expect(typeof b.name).toBe('string');
      expect(b.name.length).toBeGreaterThan(0);
      expect(typeof b.category).toBe('string');
      expect(b.uaPattern).toBeInstanceOf(RegExp);
      // suffix puo` essere null (UA-only trust) o readonly string[]
      if (b.verifyReverseDnsSuffix !== null) {
        expect(Array.isArray(b.verifyReverseDnsSuffix)).toBe(true);
        expect(b.verifyReverseDnsSuffix.length).toBeGreaterThan(0);
      }
    }
  });

  it('almeno 50 bot legittimi censiti (search/llm/social/seo/uptime/security/cdn)', () => {
    expect(LEGITIMATE_BOTS.length).toBeGreaterThanOrEqual(50);
  });

  it('copre tutte 8 categorie', () => {
    const cats = new Set(LEGITIMATE_BOTS.map((b) => b.category));
    const expected = [
      'search_engine',
      'llm_fetcher',
      'social_preview',
      'seo_tool',
      'uptime_monitor',
      'security_research',
      'generic_crawler',
      'cdn_purge',
    ];
    for (const cat of expected) {
      expect(cats.has(cat as never)).toBe(true);
    }
  });
});

describe('matchLegitimateBot — search engines', () => {
  it.each([
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
    ['Googlebot-Image/1.0', 'Googlebot'],
    ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'Bingbot'],
    [
      'Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)',
      'DuckDuckBot',
    ],
    ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'Yandex'],
    [
      'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
      'Baiduspider',
    ],
    [
      'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
      'Slurp',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 Applebot/0.1',
      'Applebot',
    ],
    [
      'Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
      'PetalBot',
    ],
  ])('UA "%s" → %s', (ua, expectedName) => {
    const m = matchLegitimateBot(ua);
    expect(m?.name).toBe(expectedName);
    expect(m?.category).toBe('search_engine');
  });
});

describe('matchLegitimateBot — LLM fetchers', () => {
  it.each([
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'GPTBot',
    ],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
      'ChatGPT-User',
    ],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot'],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      'PerplexityBot',
    ],
    [
      'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com) AppleWebKit/537.36',
      'Bytespider',
    ],
    [
      'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
      'Amazonbot',
    ],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot'],
  ])('UA "%s" → %s', (ua, expectedName) => {
    const m = matchLegitimateBot(ua);
    expect(m?.name).toBe(expectedName);
    expect(m?.category).toBe('llm_fetcher');
  });
});

describe('matchLegitimateBot — social previews', () => {
  it.each([
    [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'facebookexternalhit',
    ],
    [
      'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
      'facebookexternalhit',
    ],
    ['Twitterbot/1.0', 'Twitterbot'],
    ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1)', 'LinkedInBot'],
    ['WhatsApp/2.21.12.21 A', 'WhatsApp'],
    ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'Discordbot'],
    ['TelegramBot (like TwitterBot)', 'TelegramBot-Preview'],
    ['SkypeUriPreview Preview/0.5', 'SkypeUriPreview'],
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Slackbot-LinkExpanding'],
  ])('UA "%s" → %s', (ua, expectedName) => {
    const m = matchLegitimateBot(ua);
    expect(m?.name).toBe(expectedName);
    expect(m?.category).toBe('social_preview');
  });
});

describe('matchLegitimateBot — SEO tools', () => {
  it.each([
    ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'AhrefsBot'],
    ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'SemrushBot'],
    ['Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)', 'MJ12bot'],
    ['Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)', 'DotBot'],
    [
      'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)',
      'DataForSeoBot',
    ],
  ])('UA "%s" → %s', (ua, expectedName) => {
    const m = matchLegitimateBot(ua);
    expect(m?.name).toBe(expectedName);
    expect(m?.category).toBe('seo_tool');
  });
});

describe('matchLegitimateBot — security research', () => {
  it.each([
    ['Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)', 'CensysInspect'],
    ['InternetMeasurement (+https://internet-measurement.com/)', 'InternetMeasurement'],
    ['Mozilla/5.0 (compatible; BinaryEdge/1.0; +https://www.binaryedge.io/)', 'BinaryEdge'],
  ])('UA "%s" → %s', (ua, expectedName) => {
    const m = matchLegitimateBot(ua);
    expect(m?.name).toBe(expectedName);
    expect(m?.category).toBe('security_research');
  });
});

describe('matchLegitimateBot — UA umani NON matchano (zero false positive)', () => {
  const humanUas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  ];
  for (const ua of humanUas) {
    it(`umano "${ua.slice(0, 50)}…" → null`, () => {
      expect(matchLegitimateBot(ua)).toBeNull();
    });
  }
});

describe('verifyReverseDns', () => {
  it('PTR null → false', () => {
    expect(verifyReverseDns(null, ['.googlebot.com'])).toBe(false);
  });

  it('PTR su googlebot.com → true (Google match)', () => {
    expect(verifyReverseDns('crawl-66-249-72-1.googlebot.com', ['.googlebot.com'])).toBe(true);
  });

  it('PTR con trailing dot tollerato', () => {
    expect(verifyReverseDns('crawl.googlebot.com.', ['.googlebot.com'])).toBe(true);
  });

  it('PTR su evil-spoofer.com → false (no match)', () => {
    expect(verifyReverseDns('attacker.evil.com', ['.googlebot.com'])).toBe(false);
  });

  it('PTR multi-suffix: matcha ANY (google.com + googlebot.com)', () => {
    expect(
      verifyReverseDns('googlebot-instance.google.com', ['.googlebot.com', '.google.com']),
    ).toBe(true);
  });

  it('case-insensitive (PTR uppercase)', () => {
    expect(verifyReverseDns('CRAWL.GOOGLEBOT.COM', ['.googlebot.com'])).toBe(true);
  });

  it('non matcha substring (foo.googlebot.com.attacker.com ≠ ok)', () => {
    expect(verifyReverseDns('foo.googlebot.com.attacker.com', ['.googlebot.com'])).toBe(false);
  });
});

describe('classifyBot — verified vs spoofable vs unknown', () => {
  const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0';

  it('UA Googlebot + PTR googlebot.com → verified_legit', () => {
    const r = classifyBot(GOOGLEBOT_UA, 'crawl-66-249-72-1.googlebot.com');
    expect(r.status).toBe('verified_legit');
    expect(r.match?.name).toBe('Googlebot');
  });

  it('UA Googlebot + PTR aws.amazonaws.com → ua_claimed_spoofable', () => {
    const r = classifyBot(GOOGLEBOT_UA, 'ec2-13-49-73-217.eu-north-1.compute.amazonaws.com');
    expect(r.status).toBe('ua_claimed_spoofable');
    expect(r.match?.name).toBe('Googlebot');
  });

  it('UA Googlebot + PTR null → ua_claimed_spoofable (sospetto)', () => {
    const r = classifyBot(GOOGLEBOT_UA, null);
    expect(r.status).toBe('ua_claimed_spoofable');
  });

  it('UA Chrome (umano) → unknown', () => {
    const r = classifyBot(CHROME_UA, 'some-residential-ptr.isp.com');
    expect(r.status).toBe('unknown');
    expect(r.match).toBeNull();
  });

  it('UA GPTBot (no DNS suffix richiesto) → verified_legit via UA-trust', () => {
    const r = classifyBot(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      null,
    );
    expect(r.status).toBe('verified_legit');
    expect(r.match?.name).toBe('GPTBot');
  });

  it('UA Bingbot + PTR msn.com → verified_legit', () => {
    const r = classifyBot(
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'msnbot-40-77-167-1.search.msn.com',
    );
    expect(r.status).toBe('verified_legit');
    expect(r.match?.name).toBe('Bingbot');
  });
});

describe('classifyBot — anti-spoofing real-world cases', () => {
  // Caso REALE 2026-06-02: IP 192.178.4.x AWS si dichiara Googlebot
  // (visti nei nostri log, 200+ hit oggi). Reverse-DNS = AWS, NON google.
  it('FALSE-Googlebot AWS Stockholm: UA Googlebot + AWS PTR → spoofable', () => {
    const r = classifyBot(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'ec2-13-49-73-217.eu-north-1.compute.amazonaws.com',
    );
    expect(r.status).toBe('ua_claimed_spoofable');
    expect(r.match?.name).toBe('Googlebot');
  });

  it('Real Googlebot da Google Cloud → verified_legit', () => {
    const r = classifyBot(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'crawl-66-249-72-1.googlebot.com',
    );
    expect(r.status).toBe('verified_legit');
  });
});
