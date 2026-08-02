/**
 * Tests for the recursive spider engine + node wrapper.
 *
 * Strategy: mock `safeFetchWithRedirects` with a programmable URL → Response
 * map so every code path (queue dedup, depth cap, maxPages cap, robots.txt
 * Disallow, per-host rate limit, error tolerance) runs in pure memory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseRobotsTxt, isPathAllowed, normalizeUrl, sameOrigin, runSpider } from './recursive-spider-engine.js';
import { recursiveSpiderNode } from './recursive-spider.js';

vi.mock('@medea/engine-safe-fetch', () => ({
  safeFetchWithRedirects: vi.fn(),
  SsrfBlockedError: class extends Error {},
}));
const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = safeFetchWithRedirects as unknown as ReturnType<typeof vi.fn>;

function htmlResponse(body: string, url = 'https://example.com/'): Response {
  const res = new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  // `Response.url` is read-only by default — DefineProperty overrides it so
  // the spider engine sees the post-redirect URL the mock declares.
  Object.defineProperty(res, 'url', { value: url, writable: false, configurable: true });
  return res;
}

function programFetch(map: Record<string, () => Response>): void {
  mockedFetch.mockImplementation(async (url: unknown) => {
    const key = typeof url === 'string' ? url : '';
    const fn = map[key];
    if (fn) return fn();
    return new Response('not found', { status: 404 });
  });
}

beforeEach(() => mockedFetch.mockReset());

describe('parseRobotsTxt', () => {
  it('returns empty rules for blank input', () => {
    expect(parseRobotsTxt('', 'X-Bot')).toEqual({ disallowed: [], crawlDelayMs: null });
  });

  it('picks * group when UA does not match any explicit group', () => {
    const txt = `User-agent: GoogleBot\nDisallow: /admin\n\nUser-agent: *\nDisallow: /private\n`;
    expect(parseRobotsTxt(txt, 'FlowForge-Spider').disallowed).toEqual(['/private']);
  });

  it('picks UA-specific group when UA substring matches', () => {
    const txt = `User-agent: spider\nDisallow: /custom\n\nUser-agent: *\nDisallow: /private\n`;
    expect(parseRobotsTxt(txt, 'FlowForge-Spider').disallowed).toEqual(['/custom']);
  });

  it('extracts Crawl-Delay in milliseconds', () => {
    const txt = 'User-agent: *\nCrawl-delay: 2\n';
    expect(parseRobotsTxt(txt, 'x').crawlDelayMs).toBe(2000);
  });

  it('ignores comments + malformed lines', () => {
    const txt = '# comment\nUser-agent: *\nNotAField\nDisallow: /a\n';
    expect(parseRobotsTxt(txt, 'x').disallowed).toEqual(['/a']);
  });
});

describe('isPathAllowed', () => {
  it('allows everything when disallow is empty', () => {
    expect(isPathAllowed({ disallowed: [], crawlDelayMs: null }, '/anything')).toBe(true);
  });
  it('blocks prefix matches', () => {
    expect(isPathAllowed({ disallowed: ['/admin'], crawlDelayMs: null }, '/admin/users')).toBe(false);
  });
  it('treats Disallow: / as block-all', () => {
    expect(isPathAllowed({ disallowed: ['/'], crawlDelayMs: null }, '/anything')).toBe(false);
  });
});

describe('normalizeUrl / sameOrigin', () => {
  it('strips fragment + resolves relative', () => {
    expect(normalizeUrl('/a#frag', 'https://x.com/page')).toBe('https://x.com/a');
  });
  it('rejects non-http schemes', () => {
    expect(normalizeUrl('javascript:alert(1)', 'https://x.com')).toBeNull();
    expect(normalizeUrl('mailto:a@b.c', 'https://x.com')).toBeNull();
    expect(normalizeUrl('tel:+39', 'https://x.com')).toBeNull();
  });
  it('compares host + protocol', () => {
    expect(sameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
    expect(sameOrigin('http://a.com', 'https://a.com')).toBe(false);
    expect(sameOrigin('https://a.com', 'https://b.com')).toBe(false);
  });
});

describe('runSpider — engine', () => {
  it('follows links within maxDepth + dedupes', async () => {
    programFetch({
      'https://x.test/robots.txt': () => new Response('', { status: 404 }),
      'https://x.test/': () => htmlResponse('<a href="/a">A</a><a href="/b">B</a><a href="/a">DUP</a>', 'https://x.test/'),
      'https://x.test/a': () => htmlResponse('<a href="/c">C</a>', 'https://x.test/a'),
      'https://x.test/b': () => htmlResponse('<a href="/x">X</a>', 'https://x.test/b'),
      'https://x.test/c': () => htmlResponse('leaf', 'https://x.test/c'),
      'https://x.test/x': () => htmlResponse('leaf', 'https://x.test/x'),
    });
    const r = await runSpider({
      seeds: ['https://x.test/'], maxDepth: 2, maxPages: 50,
      sameOriginOnly: true, allowDomains: [], denyPatterns: [],
      userAgent: 'test-bot', perHostMinDelayMs: 0, concurrency: 4,
      respectRobots: false, timeoutMs: 5000,
    });
    const urls = r.pages.map((p) => p.url).sort();
    expect(urls).toEqual(['https://x.test/', 'https://x.test/a', 'https://x.test/b', 'https://x.test/c', 'https://x.test/x']);
    expect(r.stats.pagesFetched).toBe(5);
  });

  it('honours maxPages and leaves remainder in frontier for resume', async () => {
    programFetch({
      'https://x.test/robots.txt': () => new Response('', { status: 404 }),
      'https://x.test/': () => htmlResponse(
        Array.from({ length: 20 }, (_, i) => `<a href="/p${String(i)}">p${String(i)}</a>`).join(''),
        'https://x.test/',
      ),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
        `https://x.test/p${String(i)}`,
        () => htmlResponse('leaf', `https://x.test/p${String(i)}`),
      ])),
    });
    const r = await runSpider({
      seeds: ['https://x.test/'], maxDepth: 2, maxPages: 5,
      sameOriginOnly: true, allowDomains: [], denyPatterns: [],
      userAgent: 'test', perHostMinDelayMs: 0, concurrency: 2,
      respectRobots: false, timeoutMs: 5000,
    });
    expect(r.pages.length).toBeLessThanOrEqual(5);
    expect(r.frontier.length).toBeGreaterThan(0);
  });

  it('respects robots.txt Disallow', async () => {
    programFetch({
      'https://x.test/robots.txt': () => new Response('User-agent: *\nDisallow: /private\n', { status: 200 }),
      'https://x.test/': () => htmlResponse('<a href="/public">P</a><a href="/private">X</a>', 'https://x.test/'),
      'https://x.test/public': () => htmlResponse('ok', 'https://x.test/public'),
      'https://x.test/private': () => htmlResponse('SECRET', 'https://x.test/private'),
    });
    const r = await runSpider({
      seeds: ['https://x.test/'], maxDepth: 2, maxPages: 50,
      sameOriginOnly: true, allowDomains: [], denyPatterns: [],
      userAgent: 'test', perHostMinDelayMs: 0, concurrency: 2,
      respectRobots: true, timeoutMs: 5000,
    });
    const urls = r.pages.map((p) => p.url);
    expect(urls).toContain('https://x.test/public');
    expect(urls).not.toContain('https://x.test/private');
    expect(r.stats.pagesSkippedByRobots).toBeGreaterThanOrEqual(1);
  });

  it('applies allowDomains whitelist (rejects out-of-list hosts)', async () => {
    programFetch({
      'https://x.test/robots.txt': () => new Response('', { status: 404 }),
      'https://y.test/robots.txt': () => new Response('', { status: 404 }),
      'https://x.test/': () => htmlResponse('<a href="https://y.test/ok">Y</a><a href="https://z.test/no">Z</a>', 'https://x.test/'),
      'https://y.test/ok': () => htmlResponse('y', 'https://y.test/ok'),
    });
    const r = await runSpider({
      seeds: ['https://x.test/'], maxDepth: 2, maxPages: 50,
      sameOriginOnly: false, allowDomains: ['x.test', 'y.test'], denyPatterns: [],
      userAgent: 'test', perHostMinDelayMs: 0, concurrency: 2,
      respectRobots: false, timeoutMs: 5000,
    });
    const urls = r.pages.map((p) => p.url);
    expect(urls).toContain('https://y.test/ok');
    expect(urls.every((u) => !u.includes('z.test'))).toBe(true);
  });

  it('applies denyPatterns regex', async () => {
    programFetch({
      'https://x.test/robots.txt': () => new Response('', { status: 404 }),
      'https://x.test/': () => htmlResponse('<a href="/a.html">A</a><a href="/b.pdf">B</a>', 'https://x.test/'),
      'https://x.test/a.html': () => htmlResponse('ok', 'https://x.test/a.html'),
    });
    const r = await runSpider({
      seeds: ['https://x.test/'], maxDepth: 2, maxPages: 50,
      sameOriginOnly: true, allowDomains: [], denyPatterns: [/\.pdf$/],
      userAgent: 'test', perHostMinDelayMs: 0, concurrency: 2,
      respectRobots: false, timeoutMs: 5000,
    });
    expect(r.pages.map((p) => p.url)).toEqual(['https://x.test/', 'https://x.test/a.html']);
  });

  it('does not crash on fetch error (records error string, continues)', async () => {
    programFetch({
      'https://x.test/robots.txt': () => new Response('', { status: 404 }),
      'https://x.test/': () => htmlResponse('<a href="/bad">B</a><a href="/ok">O</a>', 'https://x.test/'),
      'https://x.test/ok': () => htmlResponse('ok', 'https://x.test/ok'),
    });
    mockedFetch.mockImplementation(async (url: string) => {
      if (url === 'https://x.test/bad') throw new Error('boom');
      const def = (url === 'https://x.test/robots.txt') ? new Response('', { status: 404 }) :
        url === 'https://x.test/' ? htmlResponse('<a href="/bad">B</a><a href="/ok">O</a>', 'https://x.test/') :
        url === 'https://x.test/ok' ? htmlResponse('ok', 'https://x.test/ok') :
        new Response('not found', { status: 404 });
      return def;
    });
    const r = await runSpider({
      seeds: ['https://x.test/'], maxDepth: 2, maxPages: 50,
      sameOriginOnly: true, allowDomains: [], denyPatterns: [],
      userAgent: 'test', perHostMinDelayMs: 0, concurrency: 1,
      respectRobots: false, timeoutMs: 5000,
    });
    expect(r.stats.errorCount).toBe(1);
    const bad = r.pages.find((p) => p.url === 'https://x.test/bad');
    expect(bad?.error).toMatch(/boom/);
  });
});

describe('recursiveSpiderNode — NodeModule', () => {
  it('declares the expected NodeDef shape', () => {
    expect(recursiveSpiderNode.def.id).toBe('action_recursive_spider');
    expect(recursiveSpiderNode.def.type).toBe('action');
    expect(typeof recursiveSpiderNode.executor).toBe('function');
    const fields = recursiveSpiderNode.def.configFields ?? [];
    const keys = new Set(fields.map((f) => f.key));
    for (const required of ['seeds', 'maxDepth', 'maxPages', 'concurrency', 'respectRobots']) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it('throws when seeds is empty', async () => {
    await expect(recursiveSpiderNode.executor!(
      { seeds: '   ' }, {}, { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    )).rejects.toThrow(/seeds required/);
  });

  it('throws when seeds contains no http(s) URL', async () => {
    await expect(recursiveSpiderNode.executor!(
      { seeds: 'ftp://x.com' }, {}, { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    )).rejects.toThrow(/no valid seed URL/);
  });

  it('coerces config + delegates to engine (smoke run)', async () => {
    mockedFetch.mockImplementation(async (url: unknown) => {
      const u = typeof url === 'string' ? url : '';
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return htmlResponse('seed only, no links', 'https://x.test/');
    });
    const r = await recursiveSpiderNode.executor!(
      { seeds: 'https://x.test/', maxPages: '1', concurrency: '1', respectRobots: 'false' },
      {}, { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} },
    );
    const out = r.output as { stats: { pagesFetched: number } };
    expect(out.stats.pagesFetched).toBe(1);
  });
});
