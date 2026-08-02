/**
 * Quick contract tests per github/hubspot/notion/salesforce + ui_open_history.
 *
 * Per ogni: validation errors, success path 1 chiamata, output shape.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: vi.fn((args: { provider: string }) => {
    const credsByProvider: Record<string, Record<string, unknown>> = {
      github: { token: 'ghp_test123' },
      hubspot: { accessToken: 'pat-test-abc' },
      notion: { integrationToken: 'secret_test123' },
      salesforce: {
        instanceUrl: 'https://test.my.salesforce.com',
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
        clientId: 'cid',
        clientSecret: 'secret',
      },
    };
    return {
      provider: args.provider, tenantId: 't', label: null,
      credentials: credsByProvider[args.provider] ?? {},
      expiresAt: null, createdAt: Date.now(), id: 'i1', createdByUserId: 'u',
    };
  }),
  saveIntegration: vi.fn(),
}));

import { githubExecutor } from './github.js';
import { hubspotExecutor } from './hubspot.js';
import { notionExecutor } from './notion.js';
import { salesforceExecutor } from './salesforce.js';

const ctx = {
  workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'community_x', secrets: {}, llmProviders: [], nodeOutputs: {},
} as unknown as Parameters<typeof githubExecutor>[2];

describe('githubExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('createIssue happy path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      number: 42, title: 'Bug', html_url: 'https://github.com/x/y/issues/42',
    }), { status: 201, headers: { 'x-ratelimit-remaining': '4999' } }));
    const r = await githubExecutor({
      operation: 'createIssue', owner: 'flowforge', repo: 'platform', title: 'Bug',
    }, null, ctx);
    const out = r.output as { ok: boolean; rateLimitRemaining: number };
    expect(out.ok).toBe(true);
    expect(out.rateLimitRemaining).toBe(4999);
  });

  it('listIssues con count', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { number: 1 }, { number: 2 },
    ]), { status: 200 }));
    const r = await githubExecutor({
      operation: 'listIssues', owner: 'x', repo: 'y',
    }, null, ctx);
    const out = r.output as { count: number };
    expect(out.count).toBe(2);
  });

  it('operation invalida → throw', async () => {
    await expect(githubExecutor({
      operation: 'rmrf', owner: 'x', repo: 'y',
    }, null, ctx)).rejects.toThrow(/operation "rmrf" non supportata/);
  });

  it('owner mancante → throw', async () => {
    await expect(githubExecutor({
      operation: 'listIssues', owner: '', repo: 'y',
    }, null, ctx)).rejects.toThrow(/"owner" obbligatorio/);
  });

  it('createIssue senza title → throw', async () => {
    await expect(githubExecutor({
      operation: 'createIssue', owner: 'x', repo: 'y',
    }, null, ctx)).rejects.toThrow(/"title" obbligatorio/);
  });
});

describe('hubspotExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('createContact happy path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: '100', properties: { email: 'a@b.it' },
    }), { status: 201 }));
    const r = await hubspotExecutor({
      operation: 'createContact', email: 'a@b.it', propertiesJson: '{"firstname":"Mario"}',
    }, null, ctx);
    const out = r.output as { ok: boolean; objectId: string };
    expect(out.ok).toBe(true);
    expect(out.objectId).toBe('100');
  });

  it('updateContact senza objectId/email → throw', async () => {
    await expect(hubspotExecutor({
      operation: 'updateContact', propertiesJson: '{"firstname":"Mario"}',
    }, null, ctx)).rejects.toThrow(/objectId o email/);
  });

  it('propertiesJson invalido → throw', async () => {
    await expect(hubspotExecutor({
      operation: 'createContact', email: 'a@b.it', propertiesJson: 'not-json',
    }, null, ctx)).rejects.toThrow(/propertiesJson parse error/);
  });
});

describe('notionExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('createPage happy path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'page-uuid-123', properties: {},
    }), { status: 200 }));
    const r = await notionExecutor({
      operation: 'createPage', parentId: 'db-uuid', parentType: 'database_id',
      propertiesJson: '{"Name":{"title":[{"text":{"content":"Hi"}}]}}',
    }, null, ctx);
    const out = r.output as { pageId: string };
    expect(out.pageId).toBe('page-uuid-123');
  });

  it('createPage senza parentId → throw', async () => {
    await expect(notionExecutor({
      operation: 'createPage', propertiesJson: '{}',
    }, null, ctx)).rejects.toThrow(/createPage richiede parentId/);
  });

  it('queryDatabase con results array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ id: 'p1' }, { id: 'p2' }], has_more: false, next_cursor: null,
    }), { status: 200 }));
    const r = await notionExecutor({
      operation: 'queryDatabase', databaseId: 'db-uuid',
    }, null, ctx);
    const out = r.output as { count: number; hasMore: boolean };
    expect(out.count).toBe(2);
    expect(out.hasMore).toBe(false);
  });
});

describe('salesforceExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('query SOQL happy path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      records: [{ Id: '001', Name: 'X' }], totalSize: 1, done: true,
    }), { status: 200 }));
    const r = await salesforceExecutor({
      operation: 'query', soql: 'SELECT Id, Name FROM Lead LIMIT 1',
    }, null, ctx);
    const out = r.output as { totalSize: number };
    expect(out.totalSize).toBe(1);
  });

  it('create senza sobject → throw', async () => {
    await expect(salesforceExecutor({
      operation: 'create', recordJson: '{}',
    }, null, ctx)).rejects.toThrow(/"sobject" obbligatorio per create/);
  });

  it('upsert senza externalIdField → throw', async () => {
    await expect(salesforceExecutor({
      operation: 'upsert', sobject: 'Lead', externalIdValue: 'x', recordJson: '{}',
    }, null, ctx)).rejects.toThrow(/externalIdField/);
  });

  it('query senza soql → throw', async () => {
    await expect(salesforceExecutor({
      operation: 'query',
    }, null, ctx)).rejects.toThrow(/"soql" obbligatorio/);
  });
});

describe('ui_open_history (executor smoke)', async () => {
  const mod = await import('../ui-open-history.js');
  const exec = mod.uiOpenHistoryExecutor;
  const fakeCtx = { ...ctx, workflowId: 'wf-xyz' };

  it('genera URL con query params filtri', async () => {
    const r = await exec({
      baseUrl: 'https://x.app.automazionezeli.com',
      statusFilter: 'error', dateFrom: '2026-06-01',
    }, null, fakeCtx);
    const out = r.output as { url: string; workflowId: string };
    expect(out.url).toContain('https://x.app.automazionezeli.com');
    expect(out.url).toContain('view=runs');
    expect(out.url).toContain('workflowId=wf-xyz');
    expect(out.url).toContain('status=error');
    expect(out.url).toContain('from=2026-06-01');
  });

  it('senza baseUrl + senza env → throw', async () => {
    const origEnv = process.env.MEDEA_PUBLIC_BASE_URL;
    delete process.env.MEDEA_PUBLIC_BASE_URL;
    try {
      await expect(exec({ statusFilter: 'all' }, null, fakeCtx))
        .rejects.toThrow(/nessun baseUrl disponibile/);
    } finally {
      if (origEnv) process.env.MEDEA_PUBLIC_BASE_URL = origEnv;
    }
  });

  it('status=all omette il param', async () => {
    const r = await exec({
      baseUrl: 'https://x.com', statusFilter: 'all',
    }, null, fakeCtx);
    const out = r.output as { url: string };
    expect(out.url).not.toContain('status=');
  });
});
