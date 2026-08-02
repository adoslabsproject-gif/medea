import { describe, it, expect } from 'vitest';
import { PageNumberStrategy } from './page-number.js';
import { OffsetLimitStrategy } from './offset-limit.js';
import { CursorStrategy } from './cursor.js';
import { LinkHeaderStrategy } from './link-header.js';
import { pickByPath, type PaginationContext } from './strategy.js';

const ctx = (over: Partial<PaginationContext> = {}): PaginationContext => ({
  baseUrl: 'https://api.x.com/data',
  maxPages: 3,
  pageSize: 50,
  ...over,
});

describe('pickByPath', () => {
  it('returns whole object on undefined path', () => {
    expect(pickByPath({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it('navigates dot-notation', () => {
    expect(pickByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined on missing path', () => {
    expect(pickByPath({ a: 1 }, 'b')).toBeUndefined();
    expect(pickByPath({ a: { b: 1 } }, 'a.x.y')).toBeUndefined();
  });

  it('returns undefined when traversing null/primitive', () => {
    expect(pickByPath(null, 'a')).toBeUndefined();
    expect(pickByPath(42, 'a')).toBeUndefined();
  });
});

describe('PageNumberStrategy', () => {
  it('default param names + start at page 1', () => {
    const s = new PageNumberStrategy();
    const url = s.nextUrl(ctx(), { pageIndex: 0 });
    expect(url).not.toBeNull();
    const u = new URL(url ?? '');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('limit')).toBe('50');
  });

  it('increments page param', () => {
    const s = new PageNumberStrategy();
    const url = s.nextUrl(ctx(), { pageIndex: 2 });
    const u = new URL(url ?? '');
    expect(u.searchParams.get('page')).toBe('3');
  });

  it('honors custom pageParam / limitParam / startPage', () => {
    const s = new PageNumberStrategy({ pageParam: 'p', limitParam: 'per_page', startPage: 0 });
    const url = s.nextUrl(ctx(), { pageIndex: 0 });
    const u = new URL(url ?? '');
    expect(u.searchParams.get('p')).toBe('0');
    expect(u.searchParams.get('per_page')).toBe('50');
  });

  it('returns null when pageIndex >= maxPages', () => {
    const s = new PageNumberStrategy();
    expect(s.nextUrl(ctx({ maxPages: 3 }), { pageIndex: 3 })).toBeNull();
  });

  it('extractItems pulls itemsField path', () => {
    const s = new PageNumberStrategy();
    expect(s.extractItems({ data: [1, 2, 3] }, 'data')).toEqual([1, 2, 3]);
  });

  it('extractItems returns [response] when path missing (fallback whole body)', () => {
    const s = new PageNumberStrategy();
    expect(s.extractItems({ x: 1 }, 'missing')).toEqual([{ x: 1 }]);
  });

  it('extractItems returns [response] when itemsField undefined', () => {
    const s = new PageNumberStrategy();
    expect(s.extractItems({ x: 1 }, undefined)).toEqual([{ x: 1 }]);
  });

  it('shouldContinue stop at partial page (items < pageSize)', () => {
    const s = new PageNumberStrategy();
    expect(s.shouldContinue(ctx({ pageSize: 50 }), { pageIndex: 0 }, [1, 2, 3])).toBe(false);
    expect(s.shouldContinue(ctx({ pageSize: 50 }), { pageIndex: 0 }, new Array(50).fill(0))).toBe(
      true,
    );
  });
});

describe('OffsetLimitStrategy', () => {
  it('offsets by pageIndex × pageSize', () => {
    const s = new OffsetLimitStrategy();
    const u0 = new URL(s.nextUrl(ctx(), { pageIndex: 0 }) ?? '');
    const u2 = new URL(s.nextUrl(ctx(), { pageIndex: 2 }) ?? '');
    expect(u0.searchParams.get('offset')).toBe('0');
    expect(u2.searchParams.get('offset')).toBe('100');
  });

  it('honors startOffset', () => {
    const s = new OffsetLimitStrategy({ startOffset: 1000 });
    const u = new URL(s.nextUrl(ctx(), { pageIndex: 0 }) ?? '');
    expect(u.searchParams.get('offset')).toBe('1000');
  });

  it('custom param names', () => {
    const s = new OffsetLimitStrategy({ offsetParam: 'skip', limitParam: 'take' });
    const u = new URL(s.nextUrl(ctx(), { pageIndex: 1 }) ?? '');
    expect(u.searchParams.get('skip')).toBe('50');
    expect(u.searchParams.get('take')).toBe('50');
  });
});

describe('CursorStrategy', () => {
  it('first page: no cursor param', () => {
    const s = new CursorStrategy();
    const url = s.nextUrl(ctx(), { pageIndex: 0 });
    const u = new URL(url ?? '');
    expect(u.searchParams.has('cursor')).toBe(false);
  });

  it('subsequent page: extracts next_cursor from lastResponse', () => {
    const s = new CursorStrategy();
    const url = s.nextUrl(ctx(), { pageIndex: 1, lastResponse: { next_cursor: 'abc' } });
    const u = new URL(url ?? '');
    expect(u.searchParams.get('cursor')).toBe('abc');
  });

  it('custom cursor field path (dot notation)', () => {
    const s = new CursorStrategy({ cursorResponseField: 'paging.next' });
    const url = s.nextUrl(ctx(), { pageIndex: 1, lastResponse: { paging: { next: 'xyz' } } });
    expect(new URL(url ?? '').searchParams.get('cursor')).toBe('xyz');
  });

  it('returns null when cursor is empty / missing / non-string', () => {
    const s = new CursorStrategy();
    expect(s.nextUrl(ctx(), { pageIndex: 1, lastResponse: { next_cursor: '' } })).toBeNull();
    expect(s.nextUrl(ctx(), { pageIndex: 1, lastResponse: {} })).toBeNull();
    expect(s.nextUrl(ctx(), { pageIndex: 1, lastResponse: { next_cursor: 42 } })).toBeNull();
  });
});

describe('LinkHeaderStrategy', () => {
  it('first page: returns baseUrl', () => {
    const s = new LinkHeaderStrategy();
    expect(s.nextUrl(ctx(), { pageIndex: 0 })).toBe('https://api.x.com/data');
  });

  it('subsequent page: extracts <url>; rel="next"', () => {
    const s = new LinkHeaderStrategy();
    const url = s.nextUrl(ctx(), {
      pageIndex: 1,
      lastResponseHeaders: {
        link: '<https://api.x.com/data?page=2>; rel="next", <https://api.x.com/data?page=10>; rel="last"',
      },
    });
    expect(url).toBe('https://api.x.com/data?page=2');
  });

  it('handles Link header capital L', () => {
    const s = new LinkHeaderStrategy();
    const url = s.nextUrl(ctx(), {
      pageIndex: 1,
      lastResponseHeaders: { Link: '<https://x.com/next>; rel="next"' },
    });
    expect(url).toBe('https://x.com/next');
  });

  it('handles rel=next without quotes', () => {
    const s = new LinkHeaderStrategy();
    const url = s.nextUrl(ctx(), {
      pageIndex: 1,
      lastResponseHeaders: { link: '<https://x.com/next>; rel=next' },
    });
    expect(url).toBe('https://x.com/next');
  });

  it('returns null when no next rel', () => {
    const s = new LinkHeaderStrategy();
    expect(
      s.nextUrl(ctx(), {
        pageIndex: 1,
        lastResponseHeaders: { link: '<https://x.com/last>; rel="last"' },
      }),
    ).toBeNull();
  });

  it('returns null when Link header missing', () => {
    const s = new LinkHeaderStrategy();
    expect(s.nextUrl(ctx(), { pageIndex: 1, lastResponseHeaders: {} })).toBeNull();
  });
});
