/**
 * Test 2026-grade — executors/integrations/notion.ts (REST API v1).
 *
 * 🚨 SECRET TOKEN STRICT: integrationToken DEVE iniziare con "secret_".
 *
 * 🚨 4 operations: createPage / updatePage / getPage / queryDatabase.
 *
 * 🚨 PARENT TYPE: createPage parent può essere database_id (default) o page_id.
 *
 * 🚨 PAGE_SIZE CLAMP: queryDatabase 1..100 (Notion API cap).
 *
 * 🚨 FILTER JSON: object/string vuoto/{} → omesso dal body (no filter param).
 *
 * 🚨 NOTION-VERSION HEADER: 2022-06-28 (cambio breaking → tutto rotto).
 *
 * 🚨 RETRYABLE: 5xx + 429. 4xx no retry.
 *
 * 🚨 PAGINATION: has_more + next_cursor propagati in output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IntegrationError } from './common.js';

const safeFetchMock = vi.hoisted(() => vi.fn());
const getIntegrationMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));
vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: getIntegrationMock,
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: async () => undefined,
}));

const { notionExecutor } = await import('./notion.js');

const ctx = () => ({
  runId: 'r', workflowId: 'w', nodeId: 'n', tenantId: 't1',
  defId: 'community_notion', llmProviders: [], nodeOutputs: {}, secrets: {},
} as never);

function mockRes(body: unknown, opts: { status?: number; ok?: boolean; statusText?: string } = {}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    statusText: opts.statusText ?? 'OK',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  getIntegrationMock.mockReturnValue({
    id: 'int-1', provider: 'notion', label: null,
    credentials: { integrationToken: 'secret_VALIDxxx' },
  });
});

describe('🚨 operation validation', () => {
  it('🚨 operation missing → INVALID_PAYLOAD', async () => {
    await expect(
      notionExecutor({ operation: '' } as never, null, ctx()),
    ).rejects.toThrow(/operation.+obbligatorio/u);
  });

  it('🚨 operation sconosciuta → INVALID_PAYLOAD con name', async () => {
    await expect(
      notionExecutor({ operation: 'deleteEverything' } as never, null, ctx()),
    ).rejects.toThrow(/deleteEverything.+non supportata/u);
  });
});

describe('🚨 secret_ token strict', () => {
  it('🚨 token formato "secret_" → ok', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1', properties: {} }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
    } as never, null, ctx());
    expect(safeFetchMock).toHaveBeenCalled();
  });

  it('🚨 token Bearer-style → INVALID_CREDENTIALS', async () => {
    getIntegrationMock.mockReturnValue({
      id: 'int', provider: 'notion', label: null,
      credentials: { integrationToken: 'Bearer wrong' },
    });
    await expect(
      notionExecutor({ operation: 'createPage', parentId: 'd' } as never, null, ctx()),
    ).rejects.toThrow(/INVALID_CREDENTIALS|secret_/u);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 integration NOT configured → NOT_CONFIGURED', async () => {
    getIntegrationMock.mockReturnValue(null);
    await expect(
      notionExecutor({ operation: 'createPage', parentId: 'd' } as never, null, ctx()),
    ).rejects.toThrow(/NOT_CONFIGURED|not configured/u);
  });
});

describe('🚨 createPage', () => {
  it('🚨 parentId obbligatorio', async () => {
    await expect(
      notionExecutor({ operation: 'createPage' } as never, null, ctx()),
    ).rejects.toThrow(/parentId/u);
  });

  it('🚨 parentType default database_id', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1', properties: {} }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-uuid-1',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { parent: Record<string, string> };
    expect(body.parent).toEqual({ database_id: 'db-uuid-1' });
  });

  it('🚨 parentType=page_id → parent.page_id', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1', properties: {} }));
    await notionExecutor({
      operation: 'createPage', parentId: 'page-uuid-2', parentType: 'page_id',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { parent: Record<string, string> };
    expect(body.parent).toEqual({ page_id: 'page-uuid-2' });
  });

  it('🚨 propertiesJson incluso nel body', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1', properties: {} }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
      propertiesJson: '{"Name":{"title":[{"text":{"content":"X"}}]}}',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { properties: Record<string, unknown> };
    expect(body.properties).toEqual({ Name: { title: [{ text: { content: 'X' } }] } });
  });

  it('🚨 POST /v1/pages', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1' }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
    } as never, null, ctx());
    expect(safeFetchMock.mock.calls[0]![0]).toBe('https://api.notion.com/v1/pages');
    expect((safeFetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });
});

describe('🚨 updatePage / getPage', () => {
  it('🚨 updatePage pageId obbligatorio', async () => {
    await expect(
      notionExecutor({ operation: 'updatePage' } as never, null, ctx()),
    ).rejects.toThrow(/pageId/u);
  });

  it('🚨 updatePage: PATCH /pages/:id', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1', properties: {} }));
    await notionExecutor({
      operation: 'updatePage', pageId: 'p1',
      propertiesJson: '{"Status":{"select":{"name":"Done"}}}',
    } as never, null, ctx());
    expect(safeFetchMock.mock.calls[0]![0]).toBe('https://api.notion.com/v1/pages/p1');
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PATCH');
  });

  it('🚨 getPage pageId obbligatorio', async () => {
    await expect(
      notionExecutor({ operation: 'getPage' } as never, null, ctx()),
    ).rejects.toThrow(/pageId/u);
  });

  it('🚨 getPage: GET /pages/:id', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1', properties: {} }));
    await notionExecutor({
      operation: 'getPage', pageId: 'p1',
    } as never, null, ctx());
    expect((safeFetchMock.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });
});

describe('🚨 queryDatabase', () => {
  it('🚨 databaseId obbligatorio', async () => {
    await expect(
      notionExecutor({ operation: 'queryDatabase' } as never, null, ctx()),
    ).rejects.toThrow(/databaseId/u);
  });

  it('🚨 pageSize default 50', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [], has_more: false, next_cursor: null }));
    await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { page_size: number };
    expect(body.page_size).toBe(50);
  });

  it('🚨 pageSize CLAMP >100 → 100', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [], has_more: false, next_cursor: null }));
    await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1', pageSize: 9999,
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { page_size: number };
    expect(body.page_size).toBe(100);
  });

  it('🚨 pageSize CLAMP <1 → 1', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [], has_more: false, next_cursor: null }));
    await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1', pageSize: -5,
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { page_size: number };
    expect(body.page_size).toBe(1);
  });

  it('🚨 filter VUOTO/{} → NON incluso (no filter param)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [], has_more: false, next_cursor: null }));
    await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { filter?: unknown };
    expect(body.filter).toBeUndefined();
  });

  it('🚨 filter object → incluso nel body', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ results: [], has_more: false, next_cursor: null }));
    await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1',
      filterJson: '{"property":"Status","select":{"equals":"Done"}}',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { filter: Record<string, unknown> };
    expect(body.filter).toEqual({ property: 'Status', select: { equals: 'Done' } });
  });

  it('🚨 pagination has_more + next_cursor propagati', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({
      results: [{ id: 'p1' }, { id: 'p2' }],
      has_more: true,
      next_cursor: 'cursor-xyz',
    }));
    const r = await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1',
    } as never, null, ctx());
    const out = r.output as { hasMore: boolean; nextCursor: string | null; count: number };
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toBe('cursor-xyz');
    expect(out.count).toBe(2);
  });
});

describe('🚨 propertiesJson + filterJson — JSON safety', () => {
  it('🚨 SECURITY array → throw INVALID_PAYLOAD', async () => {
    await expect(
      notionExecutor({
        operation: 'createPage', parentId: 'db-1', propertiesJson: '[1,2,3]',
      } as never, null, ctx()),
    ).rejects.toThrow(/parse error|JSON object/u);
  });

  it('🚨 propertiesJson malformato → throw', async () => {
    await expect(
      notionExecutor({
        operation: 'createPage', parentId: 'db-1', propertiesJson: '{not-json',
      } as never, null, ctx()),
    ).rejects.toThrow(/parse error/u);
  });

  it('🚨 propertiesJson string → parsed', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1' }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
      propertiesJson: '{"a":1}',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { properties: Record<string, number> };
    expect(body.properties.a).toBe(1);
  });

  it('🚨 propertiesJson object → as-is', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1' }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
      propertiesJson: { foo: 'bar' },
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { properties: Record<string, string> };
    expect(body.properties.foo).toBe('bar');
  });

  it('🚨 propertiesJson vuoto → {} (no throw)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1' }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1', propertiesJson: '',
    } as never, null, ctx());
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { properties: Record<string, unknown> };
    expect(body.properties).toEqual({});
  });
});

describe('🚨 Notion-Version header strict', () => {
  it('🚨 Notion-Version: 2022-06-28 (cambio breaking → tutto rotto)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p1' }));
    await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
    } as never, null, ctx());
    const headers = safeFetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Notion-Version']).toBe('2022-06-28');
    expect(headers.Authorization).toBe('Bearer secret_VALIDxxx');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('🚨 error handling + retry', () => {
  it('🚨 400 + body code → message inclusivo', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes(
      { message: 'Invalid request', code: 'validation_error' },
      { status: 400, ok: false, statusText: 'Bad Request' },
    ));
    try {
      await notionExecutor({
        operation: 'createPage', parentId: 'db-1',
      } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.httpStatus).toBe(400);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Invalid request');
      expect(err.message).toContain('validation_error');
    }
  });

  it('🚨 429 → retryable=true', async () => {
    safeFetchMock.mockResolvedValue(mockRes(
      'Rate limit', { status: 429, ok: false },
    ));
    try {
      await notionExecutor({
        operation: 'createPage', parentId: 'db-1',
      } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.retryable).toBe(true);
    }
  });

  it('🚨 500 → retryable=true', async () => {
    safeFetchMock.mockResolvedValue(mockRes(
      'ISE', { status: 500, ok: false },
    ));
    try {
      await notionExecutor({
        operation: 'createPage', parentId: 'db-1',
      } as never, null, ctx());
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.retryable).toBe(true);
    }
  });
});

describe('🚨 output shape', () => {
  it('🚨 createPage: pageId set', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 'p-uuid-99' }));
    const r = await notionExecutor({
      operation: 'createPage', parentId: 'db-1',
    } as never, null, ctx());
    expect(r.output).toMatchObject({
      ok: true, pageId: 'p-uuid-99', count: 0, hasMore: false, nextCursor: null,
    });
  });

  it('🚨 queryDatabase: results + count', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({
      results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      has_more: false, next_cursor: null,
    }));
    const r = await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-1',
    } as never, null, ctx());
    expect(r.output).toMatchObject({ ok: true, count: 3, pageId: null });
  });
});
