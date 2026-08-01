import { describe, it, expect, vi } from 'vitest';
import { paginationWalker } from './walker.js';
import { PageNumberStrategy } from './page-number.js';
import { CursorStrategy } from './cursor.js';
import { LinkHeaderStrategy } from './link-header.js';

const okResponse = (body: unknown, headers: Record<string, string> = {}) => ({
  body, headers, status: 200,
});

describe('paginationWalker', () => {
  it('PageNumber: aggrega items finche` partial page', async () => {
    const fetchPage = vi.fn(async (url: string) => {
      const u = new URL(url);
      const page = Number(u.searchParams.get('page'));
      // page 1 → 50 items, page 2 → 50, page 3 → 20 (last)
      const sizes: Record<number, number> = { 1: 50, 2: 50, 3: 20 };
      const count = sizes[page] ?? 0;
      return okResponse({ data: new Array(count).fill(page) });
    });
    const r = await paginationWalker({
      strategy: new PageNumberStrategy(),
      ctx: { baseUrl: 'https://x.com/u', maxPages: 10, pageSize: 50 },
      itemsField: 'data',
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(r.items).toHaveLength(120);
    expect(r.lastStatus).toBe(200);
  });

  it('PageNumber: rispetta maxPages', async () => {
    const fetchPage = vi.fn(async () => okResponse({ data: new Array(50).fill(0) })); // always full
    const r = await paginationWalker({
      strategy: new PageNumberStrategy(),
      ctx: { baseUrl: 'https://x.com/u', maxPages: 3, pageSize: 50 },
      itemsField: 'data',
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(r.items).toHaveLength(150);
  });

  it('🚨 [REGRESSION] pagina con array enorme NON crasha (no spread-args RangeError)', async () => {
    // Sul codice vecchio `items.push(...pageItems)` una pagina da 200k → RangeError.
    const fetchPage = vi.fn(async () => okResponse({ data: new Array(200_000).fill(1) }));
    const r = await paginationWalker({
      strategy: new PageNumberStrategy(),
      ctx: { baseUrl: 'https://x.com/u', maxPages: 1, pageSize: 200_000 },
      itemsField: 'data',
      fetchPage,
    });
    expect(r.items).toHaveLength(200_000);
  });

  it('Cursor: segue next_cursor finche` null', async () => {
    let call = 0;
    const fetchPage = vi.fn(async () => {
      call += 1;
      return okResponse({
        items: [call * 10],
        next_cursor: call < 3 ? `c${String(call)}` : null,
      });
    });
    const r = await paginationWalker({
      strategy: new CursorStrategy(),
      ctx: { baseUrl: 'https://x.com/u', maxPages: 10, pageSize: 50 },
      itemsField: 'items',
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(r.items).toEqual([10, 20, 30]);
  });

  it('LinkHeader: segue rel="next"', async () => {
    let call = 0;
    const fetchPage = vi.fn(async () => {
      call += 1;
      const headers: Record<string, string> = call < 3
        ? { link: `<https://x.com/p${String(call + 1)}>; rel="next"` }
        : {};
      return okResponse([call], headers);
    });
    const r = await paginationWalker({
      strategy: new LinkHeaderStrategy(),
      ctx: { baseUrl: 'https://x.com/p1', maxPages: 10, pageSize: 50 },
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(r.items).toEqual([1, 2, 3]);
  });

  it('stops on non-2xx status', async () => {
    let call = 0;
    const fetchPage = vi.fn(async () => {
      call += 1;
      if (call === 1) return okResponse({ data: new Array(50).fill(1) });
      return { body: null, headers: {}, status: 503 };
    });
    const r = await paginationWalker({
      strategy: new PageNumberStrategy(),
      ctx: { baseUrl: 'https://x.com/u', maxPages: 10, pageSize: 50 },
      itemsField: 'data',
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(r.items).toHaveLength(50);
    expect(r.lastStatus).toBe(503);
  });

  it('validateUrl rejects unsafe Link header URL', async () => {
    const fetchPage = vi.fn(async () =>
      okResponse([1], { link: '<http://169.254.169.254/imds>; rel="next"' }),
    );
    await expect(paginationWalker({
      strategy: new LinkHeaderStrategy(),
      ctx: { baseUrl: 'https://x.com/p1', maxPages: 10, pageSize: 50 },
      fetchPage,
      validateUrl: (url) => url.includes('169.254')
        ? { ok: false, reason: 'CLOUD_METADATA' }
        : { ok: true },
    })).rejects.toThrow(/CLOUD_METADATA/);
  });

  it('abort signal interrupts walker', async () => {
    const ctrl = new AbortController();
    const fetchPage = vi.fn(async () => {
      ctrl.abort();
      return okResponse({ data: new Array(50).fill(0) });
    });
    await expect(paginationWalker({
      strategy: new PageNumberStrategy(),
      ctx: { baseUrl: 'https://x.com/u', maxPages: 10, pageSize: 50 },
      itemsField: 'data',
      fetchPage,
      signal: ctrl.signal,
    })).rejects.toThrow(/Aborted/);
  });
});
