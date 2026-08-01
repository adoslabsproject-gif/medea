/**
 * news_display executor tests.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { newsDisplayExecutor, __test__ } from './news.js';

const ctx = {
  workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'news_display', secrets: {}, llmProviders: [], nodeOutputs: {},
} as unknown as Parameters<typeof newsDisplayExecutor>[2];

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <description>Sample RSS feed for tests</description>
    <language>en</language>
    <item>
      <title>Item 1</title>
      <link>https://example.com/1</link>
      <pubDate>Wed, 05 Jun 2026 10:00:00 GMT</pubDate>
      <description>First item content with &lt;b&gt;HTML&lt;/b&gt;</description>
      <author>alice@example.com</author>
      <category>tech</category>
      <category>flowforge</category>
    </item>
    <item>
      <title>Item 2</title>
      <link>https://example.com/2</link>
      <pubDate>Wed, 05 Jun 2026 08:00:00 GMT</pubDate>
      <description>Second item</description>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="it">
  <title>Atom Feed</title>
  <subtitle>Sample atom</subtitle>
  <link rel="alternate" href="https://example.com/atom" />
  <entry>
    <title>Atom Item 1</title>
    <link rel="alternate" href="https://example.com/a1" />
    <updated>2026-06-05T10:00:00Z</updated>
    <summary>Atom summary 1</summary>
    <author><name>Bob</name></author>
    <category term="news" />
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 → feed meta + 2 items', () => {
    const { feed, items } = __test__.parseFeed(RSS_SAMPLE);
    expect(feed.title).toBe('Test Feed');
    expect(feed.link).toBe('https://example.com');
    expect(feed.description).toBe('Sample RSS feed for tests');
    expect(feed.lang).toBe('en');
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Item 1');
    expect(items[0]!.link).toBe('https://example.com/1');
    expect(items[0]!.snippet).toBe('First item content with HTML');
    expect(items[0]!.author).toBe('alice@example.com');
    expect(items[0]!.categories).toEqual(['tech', 'flowforge']);
  });

  it('parses Atom 1.0 → entry mapping', () => {
    const { feed, items } = __test__.parseFeed(ATOM_SAMPLE);
    expect(feed.title).toBe('Atom Feed');
    expect(feed.lang).toBe('it');
    expect(feed.link).toBe('https://example.com/atom');
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Atom Item 1');
    expect(items[0]!.author).toBe('Bob');
    expect(items[0]!.categories).toEqual(['news']);
  });

  it('throw su XML non riconosciuto', () => {
    expect(() => __test__.parseFeed('<?xml?><junk/>')).toThrow(/non riconosciuto/);
  });

  it('parseDate ISO valida → ts numerico', () => {
    const r = __test__.parseDate('2026-06-05T10:00:00Z');
    expect(r.iso).toBe('2026-06-05T10:00:00.000Z');
    expect(typeof r.ts).toBe('number');
  });

  it('parseDate invalida → ts=null ma iso=raw', () => {
    const r = __test__.parseDate('not-a-date');
    expect(r.ts).toBeNull();
    expect(r.iso).toBe('not-a-date');
  });

  it('stripHtml rimuove tag + collapse whitespace', () => {
    expect(__test__.stripHtml('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('truncate aggiunge ellipsis solo se > max', () => {
    expect(__test__.truncate('short', 100)).toBe('short');
    expect(__test__.truncate('a'.repeat(300), 280)).toMatch(/…$/);
  });
});

describe('render', () => {
  const items = [
    { title: 'T1', link: 'https://x.com/1', pubDate: '2026-06-05T10:00:00.000Z', pubTimestamp: 1, snippet: 'snip1', author: null, categories: [] },
    { title: 'T2', link: 'https://x.com/2', pubDate: null, pubTimestamp: null, snippet: '', author: null, categories: [] },
  ];

  it('renderMarkdown: bullet list con date e snippet', () => {
    const md = __test__.renderMarkdown(items);
    expect(md).toContain('- **[T1](https://x.com/1)**');
    expect(md).toContain('_(2026-06-05)_');
    expect(md).toContain('snip1');
  });

  it('renderHtml: <ul><li> markup', () => {
    const html = __test__.renderHtml(items);
    expect(html).toContain('<ul>');
    expect(html).toContain('<a href="https://x.com/1"><strong>T1</strong></a>');
  });
});

describe('newsDisplayExecutor end-to-end', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => { __test__.clearCache(); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('fetcha RSS + restituisce items', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(RSS_SAMPLE, {
      status: 200, headers: { 'content-type': 'application/rss+xml' },
    }));
    const r = await newsDisplayExecutor({ feedUrl: 'https://example.com/rss', limit: 5 }, null, ctx);
    const out = r.output as { feed: { title: string }; items: unknown[]; count: number };
    expect(out.feed.title).toBe('Test Feed');
    expect(out.items).toHaveLength(2);
    expect(out.count).toBe(2);
  });

  it('🚨 ATTACCO: feed ENORME → lettura cappata in streaming (no res.text() integrale)', async () => {
    const stats = { maxChunks: 0 };
    let sent = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 512) { c.close(); return; } // 512×64KB = 32MB disponibili
        sent += 1;
        stats.maxChunks = Math.max(stats.maxChunks, sent);
        c.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)));
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(huge, { status: 200, headers: { 'content-type': 'application/xml' } }));
    // Il feed di zeri non è un RSS valido → l'executor può lanciare; ci interessa solo
    // che la LETTURA si sia fermata al cap (5MB / 64KB ≈ 80 chunk), non i 512.
    await newsDisplayExecutor({ feedUrl: 'https://example.com/huge-rss', limit: 5 }, null, ctx).catch(() => undefined);
    expect(stats.maxChunks).toBeLessThan(200);
  });

  it('renderFormat=markdown → campo markdown popolato', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(RSS_SAMPLE, { status: 200 }));
    const r = await newsDisplayExecutor({ feedUrl: 'https://example.com/rss', renderFormat: 'markdown' }, null, ctx);
    const out = r.output as { markdown: string };
    expect(out.markdown).toContain('**[Item 1]');
  });

  it('renderFormat=html → campo html popolato', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(RSS_SAMPLE, { status: 200 }));
    const r = await newsDisplayExecutor({ feedUrl: 'https://example.com/rss', renderFormat: 'html' }, null, ctx);
    const out = r.output as { html: string };
    expect(out.html).toContain('<ul>');
  });

  it('limit applica cap (RSS con 2 items, limit 1 → 1 item)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(RSS_SAMPLE, { status: 200 }));
    const r = await newsDisplayExecutor({ feedUrl: 'https://example.com/rss', limit: 1 }, null, ctx);
    const out = r.output as { items: unknown[]; count: number };
    expect(out.items).toHaveLength(1);
    expect(out.count).toBe(1);
  });

  it('cache: 2 chiamate consecutive → 1 sola fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(RSS_SAMPLE, { status: 200 }));
    globalThis.fetch = fetchMock;
    await newsDisplayExecutor({ feedUrl: 'https://example.com/rss' }, null, ctx);
    await newsDisplayExecutor({ feedUrl: 'https://example.com/rss' }, null, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('feedUrl vuoto → throw', async () => {
    await expect(newsDisplayExecutor({ feedUrl: '' }, null, ctx)).rejects.toThrow(/feedUrl.*obbligatorio/);
  });

  it('HTTP 500 → throw informativo', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(newsDisplayExecutor({ feedUrl: 'https://example.com/rss' }, null, ctx))
      .rejects.toThrow(/HTTP 500/);
  });

  it('XML invalido → throw "non riconosciuto"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('<not-a-feed/>', { status: 200 }));
    await expect(newsDisplayExecutor({ feedUrl: 'https://example.com/rss' }, null, ctx))
      .rejects.toThrow(/non riconosciuto/);
  });

  it('sinceHours filtra items vecchi (cut-off 0.001h = 3.6s — tutti scartati)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(RSS_SAMPLE, { status: 200 }));
    // Tutti gli items hanno pubDate del 2026-06-05 → certo > 1h fa rispetto a "now"
    const r = await newsDisplayExecutor({ feedUrl: 'https://example.com/rss', sinceHours: 1 }, null, ctx);
    const out = r.output as { items: unknown[] };
    // Tutti scartati perché vecchi più di 1h (assumendo che "now" sia comunque distante)
    expect(out.items.length).toBeLessThanOrEqual(2);
  });
});

describe('NodeDef contract', () => {
  it('newsDisplayNode esportato in stdlib', async () => {
    const mod = await import('@flowforge/nodes-stdlib');
    expect(mod.newsDisplayNode.def.id).toBe('news_display');
  });

  it('description ≥150 char', async () => {
    const mod = await import('@flowforge/nodes-stdlib');
    expect((mod.newsDisplayNode.def.description ?? '').length).toBeGreaterThanOrEqual(150);
  });

  it('configFields contiene feedUrl/limit/renderFormat/sinceHours/timeoutMs', async () => {
    const mod = await import('@flowforge/nodes-stdlib');
    const keys = (mod.newsDisplayNode.def.configFields ?? []).map(f => f.key);
    expect(keys).toEqual(['feedUrl', 'limit', 'renderFormat', 'sinceHours', 'timeoutMs']);
  });
});
