/**
 * Test 2026-grade — executors/paginate.ts (3 pagination strategies).
 *
 * 🚨 3 STRATEGIE: page-number (default) / cursor / link-header (GitHub style).
 *    Bug = pagination infinita o early-stop → dati incompleti.
 *
 * 🚨 SAFETY: maxPages cap (default 100) → no infinite loop su API broken.
 *
 * 🚨 page-number stop: itemsArr.length === 0 → stop (no more data).
 * 🚨 cursor stop: cursorPath retorna null/'' → stop.
 * 🚨 link-header stop: nessun rel="next" → stop.
 *
 * 🚨 SECURITY: headersJson invalid JSON → throw (no silent fallback).
 *    cursor URL-encoded (no injection via cursor value).
 *
 * 🚨 dataPath nested → estrae array da object profondo (es. "response.data").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const safeOutboundFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeOutboundFetchMock,
}));

const { paginateExecutor } = await import('./paginate.js');

const ctx = {
  runId: 'r',
  workflowId: 'w',
  nodeId: 'n',
  tenantId: 't1',
  defId: 'logic_paginate',
  llmProviders: [],
  secrets: {},
  nodeOutputs: {},
} as never;

function mockRes(
  body: unknown,
  opts: { ok?: boolean; status?: number; linkHeader?: string } = {},
): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (h: string) => (h === 'link' ? (opts.linkHeader ?? null) : null),
    } as unknown as Headers,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('🚨 validation', () => {
  it('🚨 urlTemplate missing → THROW', async () => {
    await expect(paginateExecutor({} as never, {} as never, ctx)).rejects.toThrow(
      /missing urlTemplate/,
    );
  });

  it('🚨 headersJson invalid → THROW (no silent fallback)', async () => {
    await expect(
      paginateExecutor(
        { urlTemplate: 'https://api/x', headersJson: 'NOT-JSON{' } as never,
        {} as never,
        ctx,
      ),
    ).rejects.toThrow(/headersJson invalid/);
  });

  it('🚨 res !ok → THROW con status + body preview', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce({
      ...mockRes('error body'),
      ok: false,
      status: 500,
    } as Response);
    await expect(
      paginateExecutor({ urlTemplate: 'https://api/x' } as never, {} as never, ctx),
    ).rejects.toThrow(/paginate 500/);
  });
});

describe('🚨 strategy=page-number (default)', () => {
  it('🚨 raccoglie items finché itemsArr non vuoto', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes([1, 2, 3]))
      .mockResolvedValueOnce(mockRes([4, 5]))
      .mockResolvedValueOnce(mockRes([])); // stop
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?page={{page}}' } as never,
      {} as never,
      ctx,
    );
    expect(r.output).toMatchObject({ items: [1, 2, 3, 4, 5], totalCount: 5 });
  });

  it('🚨 {{page}} sostituito 1, 2, 3...', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([1])).mockResolvedValueOnce(mockRes([]));
    await paginateExecutor(
      { urlTemplate: 'https://api/x?page={{page}}' } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock.mock.calls[0]![0]).toBe('https://api/x?page=1');
  });

  it('🚨 dataPath nested estrae array', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes({ response: { data: [1, 2] } }))
      .mockResolvedValueOnce(mockRes({ response: { data: [] } }));
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}', dataPath: 'response.data' } as never,
      {} as never,
      ctx,
    );
    expect((r.output as { items: number[] }).items).toEqual([1, 2]);
  });

  it('🚨 SAFETY: maxPages=3 → max 3 round (no infinite loop)', async () => {
    safeOutboundFetchMock.mockResolvedValue(mockRes([1])); // sempre non-vuoto
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}', maxPages: 3 } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(3);
    expect((r.output as { items: number[] }).items).toEqual([1, 1, 1]);
  });

  it('🚨 default maxPages=100 (cap di sicurezza)', async () => {
    safeOutboundFetchMock.mockResolvedValue(mockRes([1]));
    await paginateExecutor({ urlTemplate: 'https://api/x?p={{page}}' } as never, {} as never, ctx);
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(100);
  });
});

describe('🚨 strategy=cursor', () => {
  it('🚨 cursor inseguito via cursorPath fino a null', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes({ items: [1, 2], next: 'abc' }))
      .mockResolvedValueOnce(mockRes({ items: [3, 4], next: 'def' }))
      .mockResolvedValueOnce(mockRes({ items: [5], next: null })); // stop
    const r = await paginateExecutor(
      {
        urlTemplate: 'https://api/x?cursor={{cursor}}',
        pageStrategy: 'cursor',
        dataPath: 'items',
        cursorPath: 'next',
      } as never,
      {} as never,
      ctx,
    );
    expect((r.output as { items: number[] }).items).toEqual([1, 2, 3, 4, 5]);
  });

  it('🚨 SECURITY: cursor URL-encoded (no injection via & = etc)', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes({ items: [], next: 'evil&inject=1' }))
      .mockResolvedValueOnce(mockRes({ items: [], next: null }));
    await paginateExecutor(
      {
        urlTemplate: 'https://api/x?c={{cursor}}',
        pageStrategy: 'cursor',
        dataPath: 'items',
        cursorPath: 'next',
      } as never,
      {} as never,
      ctx,
    );
    // Seconda call con cursor encoded
    const secondUrl = safeOutboundFetchMock.mock.calls[1]![0] as string;
    expect(secondUrl).toContain('evil%26inject%3D1');
  });

  it('🚨 cursor empty string → STOP', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes({ items: [1], next: '' }));
    const r = await paginateExecutor(
      {
        urlTemplate: 'https://api/x?c={{cursor}}',
        pageStrategy: 'cursor',
        dataPath: 'items',
        cursorPath: 'next',
      } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    expect((r.output as { items: number[] }).items).toEqual([1]);
  });

  it('🚨 cursor non-string → STOP (type guard)', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes({ items: [1], next: 42 }));
    const r = await paginateExecutor(
      {
        urlTemplate: 'https://api/x?c={{cursor}}',
        pageStrategy: 'cursor',
        dataPath: 'items',
        cursorPath: 'next',
      } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    expect((r.output as { items: number[] }).items).toEqual([1]);
  });
});

describe('🚨 strategy=link-header (GitHub style)', () => {
  it('🚨 segue rel="next" finché presente', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes([1, 2], { linkHeader: '<https://api/x?p=2>; rel="next"' }))
      .mockResolvedValueOnce(mockRes([3, 4], { linkHeader: '<https://api/x?p=3>; rel="next"' }))
      .mockResolvedValueOnce(mockRes([5])); // no link → stop
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p=1', pageStrategy: 'link-header' } as never,
      {} as never,
      ctx,
    );
    expect((r.output as { items: number[] }).items).toEqual([1, 2, 3, 4, 5]);
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(3);
    // Seconda call usa URL del link header
    expect(safeOutboundFetchMock.mock.calls[1]![0]).toBe('https://api/x?p=2');
  });

  it('🚨 link header senza rel="next" → STOP', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(
      mockRes([1, 2], { linkHeader: '<https://api/x?p=2>; rel="prev"' }),
    );
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p=1', pageStrategy: 'link-header' } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock).toHaveBeenCalledTimes(1);
    expect((r.output as { items: number[] }).items).toEqual([1, 2]);
  });

  it('🚨 link header con rel multipli → estrae solo "next"', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(
        mockRes([1], {
          linkHeader: '<https://api/x?p=2>; rel="next", <https://api/x?last>; rel="last"',
        }),
      )
      .mockResolvedValueOnce(mockRes([])); // 2a call con [] termina
    await paginateExecutor(
      { urlTemplate: 'https://api/x?p=1', pageStrategy: 'link-header' } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock.mock.calls[1]![0]).toBe('https://api/x?p=2');
  });
});

describe('🚨 method + headers passati a safeOutboundFetch', () => {
  it('🚨 method default GET', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([]));
    await paginateExecutor({ urlTemplate: 'https://api/x?p={{page}}' } as never, {} as never, ctx);
    expect(safeOutboundFetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('🚨 method POST + uppercase', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([]));
    await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}', method: 'post' } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('🚨 headersJson valido → header propagati', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([]));
    await paginateExecutor(
      {
        urlTemplate: 'https://api/x?p={{page}}',
        headersJson: '{"Authorization":"Bearer X","X-Custom":42}',
      } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: 'Bearer X', 'X-Custom': '42' }, // 42 stringified
    });
  });

  it('🚨 headersJson empty string → headers vuoti', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([]));
    await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}', headersJson: '   ' } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock.mock.calls[0]![1]).toMatchObject({ headers: {} });
  });

  it('🚨 SECURITY: headersJson Array → ignorato (no spread of array vals)', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([]));
    await paginateExecutor(
      { urlTemplate: 'https://api/x', headersJson: '[1,2,3]' } as never,
      {} as never,
      ctx,
    );
    expect(safeOutboundFetchMock.mock.calls[0]![1]).toMatchObject({ headers: {} });
  });
});

describe('🚨 output shape', () => {
  it('🚨 ritorna { items, pages, totalCount }', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([1, 2])).mockResolvedValueOnce(mockRes([]));
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}' } as never,
      {} as never,
      ctx,
    );
    expect(r.output).toMatchObject({ items: [1, 2], totalCount: 2 });
    expect((r.output as { pages: number }).pages).toBeGreaterThanOrEqual(1);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ondata 8d — gap costruiti: offset-limit, cap items/durata, 429, output esteso
// ─────────────────────────────────────────────────────────────────────────────

function mockResH(
  body: unknown,
  opts: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): Response {
  const h = opts.headers ?? {};
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null } as unknown as Headers,
  } as Response;
}

describe('🚨 strategy=offset-limit', () => {
  it('🚨 incrementa offset di limit, stop su pagina incompleta', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes([1, 2]))
      .mockResolvedValueOnce(mockRes([3])); // < limit → stop
    const r = await paginateExecutor(
      {
        urlTemplate: 'https://api/x?offset={{offset}}&limit={{limit}}',
        pageStrategy: 'offset-limit',
        limit: 2,
      } as never,
      {} as never,
      ctx,
    );
    expect((r.output as { items: number[] }).items).toEqual([1, 2, 3]);
    expect(safeOutboundFetchMock.mock.calls[0]![0]).toBe('https://api/x?offset=0&limit=2');
    expect(safeOutboundFetchMock.mock.calls[1]![0]).toBe('https://api/x?offset=2&limit=2');
  });
});

describe('🚨 cap di sicurezza', () => {
  it('🚨 maxItems → tronca + truncated=true', async () => {
    safeOutboundFetchMock.mockResolvedValue(mockRes([1, 2, 3]));
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}', maxItems: 2 } as never,
      {} as never,
      ctx,
    );
    const out = r.output as { items: number[]; truncated: boolean };
    expect(out.items).toEqual([1, 2]);
    expect(out.truncated).toBe(true);
  });

  it('🚨 maxPages superato → truncated=true', async () => {
    safeOutboundFetchMock.mockResolvedValue(mockRes([1]));
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}', maxPages: 2 } as never,
      {} as never,
      ctx,
    );
    expect((r.output as { truncated: boolean }).truncated).toBe(true);
  });
});

describe('🚨 output esteso (requestsCount / finalCursor)', () => {
  it('requestsCount conta le fetch; finalCursor null senza cursor', async () => {
    safeOutboundFetchMock.mockResolvedValueOnce(mockRes([1])).mockResolvedValueOnce(mockRes([]));
    const r = await paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}' } as never,
      {} as never,
      ctx,
    );
    const out = r.output as { requestsCount: number; finalCursor: string | null };
    expect(out.requestsCount).toBe(2);
    expect(out.finalCursor).toBeNull();
  });

  it('finalCursor = ultimo cursore visto (strategy cursor)', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockRes({ items: [1], next: 'c1' }))
      .mockResolvedValueOnce(mockRes({ items: [2], next: null }));
    const r = await paginateExecutor(
      {
        urlTemplate: 'https://api/x?c={{cursor}}',
        pageStrategy: 'cursor',
        dataPath: 'items',
        cursorPath: 'next',
      } as never,
      {} as never,
      ctx,
    );
    expect((r.output as { finalCursor: string | null }).finalCursor).toBe('c1');
  });
});

describe('🚨 429 Retry-After', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  it('🚨 su 429 rispetta Retry-After e ritenta la stessa pagina', async () => {
    safeOutboundFetchMock
      .mockResolvedValueOnce(mockResH([], { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(mockRes([1]))
      .mockResolvedValueOnce(mockRes([]));
    const promise = paginateExecutor(
      { urlTemplate: 'https://api/x?p={{page}}' } as never,
      {} as never,
      ctx,
    );
    await vi.runAllTimersAsync();
    const r = await promise;
    const out = r.output as { items: number[]; requestsCount: number };
    // MUTATION: senza il retry, il 429 verrebbe trattato come !ok → throw.
    expect(out.items).toEqual([1]);
    expect(out.requestsCount).toBe(3); // 429 + retry-ok + stop-vuota
  });
  afterEach(() => {
    vi.useRealTimers();
  });
});
