/**
 * Test reali scrape-smart orchestrator. NO smoke fake.
 * Asseriscono pipeline routing, LLM extract integration, pagination follow,
 * output shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrapeSmartNode } from './scrape-smart.js';

vi.mock('@flowforge/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flowforge/safe-fetch')>()),
  safeFetchWithRedirects: vi.fn(),
}));

const { safeFetchWithRedirects } = await import('@flowforge/safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {}, llmProviders: {} } as const;

beforeEach(() => {
  mockedFetch.mockReset();
  delete process.env.FLOWFORGE_BROWSER_ENDPOINT;
  delete process.env.FLOWFORGE_STEALTH_ENDPOINT;
});

describe('scrapeSmartNode.def', () => {
  it('id corretto + 4-stage pipeline esposto in forceStage', () => {
    expect(scrapeSmartNode.def.id).toBe('action_scrape_smart');
    const f = scrapeSmartNode.def.configFields?.find((x) => x.key === 'forceStage');
    const values = f && 'options' in f ? [...(f.options ?? [])].sort() : [];
    expect(values).toEqual(['auto', 'browser_render', 'browser_stealth', 'fetch_simple', 'vision_extract']);
  });

  it('url + prompt required', () => {
    const req = scrapeSmartNode.def.configFields?.filter((f) => f.required).map((f) => f.key);
    expect(req).toContain('url');
    expect(req).toContain('prompt');
  });

  it('outputs include pages + pagesScraped + extracted + paginationDetected', () => {
    expect(scrapeSmartNode.def.outputs).toEqual(
      expect.arrayContaining(['extracted', 'pages', 'pagesScraped', 'pagesSuccessful', 'paginationDetected', 'finalStages']),
    );
  });
});

describe('scrapeSmartNode.executor — validation', () => {
  it('url vuoto → throw', async () => {
    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    await expect(scrapeSmartNode.executor({ prompt: 'p' }, null, ctx)).rejects.toThrow(/url required/);
  });

  it('prompt vuoto → throw', async () => {
    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    await expect(scrapeSmartNode.executor({ url: 'https://t.com' }, null, ctx)).rejects.toThrow(/prompt required/);
  });

  it('schemaJson invalido → throw', async () => {
    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    await expect(
      scrapeSmartNode.executor({ url: 'https://t.com', prompt: 'p', schemaJson: '{bad' }, null, ctx),
    ).rejects.toThrow(/schemaJson invalid JSON/);
  });
});

describe('scrapeSmartNode.executor — single page happy path', () => {
  it('fetch HTML rich → LLM extract → output structured', async () => {
    const richHtml = `<html><body><h1>Product XYZ</h1><span class="price">EUR 49.99</span>${'<p>desc</p>'.repeat(20)}</body></html>`;

    // Fetch call (stage 1)
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, url: 'https://t.com',
      text: async () => richHtml,
    } as unknown as Response);

    // LLM extract call
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"title":"Product XYZ","price":49.99}' } }] }),
    } as unknown as Response);

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      { url: 'https://t.com', prompt: 'estrai titolo e prezzo' }, null, ctx,
    );
    const out = res.output as { extracted: unknown; pagesScraped: number; pagesSuccessful: number; pages: { finalStage: string; extracted: unknown }[] };
    expect(out.pagesScraped).toBe(1);
    expect(out.pagesSuccessful).toBe(1);
    expect(out.pages[0]?.finalStage).toBe('fetch_simple');
    expect(out.extracted).toEqual({ title: 'Product XYZ', price: 49.99 });
  });
});

describe('scrapeSmartNode.executor — adaptive upgrade', () => {
  it('SPA shell scarna → upgrade a browser_render', async () => {
    const spaHtml = '<html><body><div id="root"></div><script src="bundle.js"></script></body></html>';
    const renderedHtml = `<html><body><h1>Rich content</h1>${'<p>data</p>'.repeat(30)}</body></html>`;

    // Stage 1: fetch simple ritorna SPA shell
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200, url: 'https://spa.com',
      text: async () => spaHtml,
    } as unknown as Response);

    // Stage 2: browser_render ritorna HTML rich
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ html: renderedHtml, finalUrl: 'https://spa.com' }),
    } as unknown as Response);

    // LLM extract
    mockedFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"title":"Rich content"}' } }] }),
    } as unknown as Response);

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      { url: 'https://spa.com', prompt: 'p', browserEndpoint: 'https://browser.x.com' },
      null, ctx,
    );
    const out = res.output as { pages: { finalStage: string; pipelineSteps: unknown[] }[] };
    expect(out.pages[0]?.finalStage).toBe('browser_render');
    expect(out.pages[0]?.pipelineSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('anti-bot cloudflare → upgrade a stealth', async () => {
    const cfHtml = '<html><body>Just a moment... Checking your browser</body></html>';
    const stealthHtml = `<html><body><h1>Real content${'<br>data'.repeat(30)}</h1></body></html>`;

    mockedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://x.com', text: async () => cfHtml } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ html: stealthHtml, finalUrl: 'https://x.com' }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) } as unknown as Response);

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      {
        url: 'https://x.com', prompt: 'p',
        stealthEndpoint: 'https://stealth.x.com',
      }, null, ctx,
    );
    const out = res.output as { pages: { finalStage: string }[] };
    expect(out.pages[0]?.finalStage).toBe('browser_stealth');
  });

  it('forceStage=fetch_simple → skippa upgrade anche se HTML scarno', async () => {
    const spaHtml = '<html><body><div id="root"></div><script src="x.js"></script></body></html>';

    mockedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://x.com', text: async () => spaHtml } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) } as unknown as Response);

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      {
        url: 'https://x.com', prompt: 'p', forceStage: 'fetch_simple',
        browserEndpoint: 'https://browser.x.com', // disponibile ma NON usato
      }, null, ctx,
    );
    const out = res.output as { pages: { finalStage: string }[] };
    expect(out.pages[0]?.finalStage).toBe('fetch_simple');
    // mockedFetch chiamato solo per fetch_simple + LLM (2 totali)
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

describe('scrapeSmartNode.executor — pagination', () => {
  it('maxPages=3 + rel="next" trovato → follow 3 pagine', async () => {
    const p1 = '<html><body>page1 ' + 'x'.repeat(600) + '<a rel="next" href="/p/2">Next</a></body></html>';
    const p2 = '<html><body>page2 ' + 'x'.repeat(600) + '<a rel="next" href="/p/3">Next</a></body></html>';
    const p3 = '<html><body>page3 ' + 'x'.repeat(600) + 'no more</body></html>';

    let fetchCount = 0;
    mockedFetch.mockImplementation(async (url, _opts) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
      const urlStr = String(url);
      if (urlStr.includes('/v1/chat/completions')) {
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: `{"page":${(++fetchCount).toString()}}` } }] }),
        } as unknown as Response;
      }
      // fetch HTML
      if (urlStr.endsWith('/p1') || urlStr.endsWith('/page-1')) return { ok: true, status: 200, url: urlStr, text: async () => p1 } as unknown as Response;
      if (urlStr.endsWith('/p/2')) return { ok: true, status: 200, url: urlStr, text: async () => p2 } as unknown as Response;
      if (urlStr.endsWith('/p/3')) return { ok: true, status: 200, url: urlStr, text: async () => p3 } as unknown as Response;
      return { ok: true, status: 200, url: urlStr, text: async () => p1 } as unknown as Response;
    });

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      { url: 'https://x.com/p1', prompt: 'p', maxPages: 3, pageDelayMs: 0 },
      null, ctx,
    );
    const out = res.output as { pagesScraped: number; paginationDetected: boolean; pages: { url: string }[] };
    expect(out.pagesScraped).toBe(3);
    expect(out.paginationDetected).toBe(true);
  });

  it('maxPages=1 → no pagination', async () => {
    const html = '<html><body>x' + 'a'.repeat(600) + '<a rel="next" href="/p/2">N</a></body></html>';
    mockedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://x.com', text: async () => html } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) } as unknown as Response);

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      { url: 'https://x.com', prompt: 'p', maxPages: 1 }, null, ctx,
    );
    const out = res.output as { pagesScraped: number; paginationDetected: boolean };
    expect(out.pagesScraped).toBe(1);
    expect(out.paginationDetected).toBe(false);
  });

  it('next URL === currentUrl → break (no infinite loop)', async () => {
    const html = '<html><body>' + 'x'.repeat(600) + '<a rel="next" href="https://x.com/p1">N</a></body></html>';
    mockedFetch.mockImplementation(async (url) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
      const urlStr = String(url);
      if (urlStr.includes('chat/completions')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }] }) } as unknown as Response;
      }
      return { ok: true, status: 200, url: urlStr, text: async () => html } as unknown as Response;
    });

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor(
      { url: 'https://x.com/p1', prompt: 'p', maxPages: 10, pageDelayMs: 0 }, null, ctx,
    );
    const out = res.output as { pagesScraped: number };
    // page 1 fa rel=next a https://x.com/p1 (same!) → break dopo 1 (current = https://x.com/p1 + 1 same → exit)
    expect(out.pagesScraped).toBe(1);
  });
});

describe('scrapeSmartNode.executor — output shape singular vs array', () => {
  it('1 pagina → extracted singolare', async () => {
    mockedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://x.com', text: async () => '<html><body>' + 'x'.repeat(600) + '</body></html>' } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }) } as unknown as Response);

    if (!scrapeSmartNode.executor) throw new Error('exec mancante');
    const res = await scrapeSmartNode.executor({ url: 'https://x.com', prompt: 'p' }, null, ctx);
    const out = res.output as { extracted: unknown; pages: unknown[] };
    expect(out.extracted).toEqual({ a: 1 });
    expect(Array.isArray(out.extracted)).toBe(false);
  });
});
