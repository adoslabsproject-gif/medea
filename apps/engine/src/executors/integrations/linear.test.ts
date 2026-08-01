/**
 * Linear integration tests.
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: vi.fn().mockReturnValue({
    provider: 'linear', tenantId: 't', label: null,
    credentials: { apiKey: 'lin_api_TestKey123' },
    expiresAt: null, createdAt: Date.now(), id: 'i1', createdByUserId: 'u',
  }),
}));

import { linearExecutor } from './linear.js';

const ctx = {
  workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'integration_linear_create_issue', secrets: {}, llmProviders: [], nodeOutputs: {},
} as unknown as Parameters<typeof linearExecutor>[2];

describe('linearExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  const teamResp = {
    data: { teams: { nodes: [{ id: 'team-uuid-eng', key: 'ENG' }] } },
  };
  const issueCreateResp = {
    data: { issueCreate: { success: true, issue: {
      id: 'issue-uuid', identifier: 'ENG-123', url: 'https://linear.app/x/issue/ENG-123',
      title: 'Bug', state: { name: 'Triage' },
    } } },
  };

  it('happy path: resolve team + create issue', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(teamResp), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(issueCreateResp), { status: 200 }));
    const r = await linearExecutor({ teamKey: 'ENG', title: 'Bug' }, null, ctx);
    const out = r.output as { ok: boolean; identifier: string; url: string };
    expect(out.ok).toBe(true);
    expect(out.identifier).toBe('ENG-123');
    expect(out.url).toContain('linear.app');
  });

  it('team non trovato → throw TEAM_NOT_FOUND', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      data: { teams: { nodes: [] } },
    }), { status: 200 }));
    await expect(linearExecutor({ teamKey: 'XYZ', title: 'Bug' }, null, ctx))
      .rejects.toThrow(/team "XYZ" non trovato/);
  });

  it('teamKey vuoto → throw', async () => {
    await expect(linearExecutor({ teamKey: '', title: 'Bug' }, null, ctx))
      .rejects.toThrow(/"teamKey" obbligatorio/);
  });

  it('title vuoto → throw', async () => {
    await expect(linearExecutor({ teamKey: 'ENG', title: '' }, null, ctx))
      .rejects.toThrow(/"title" obbligatorio/);
  });

  it('assignee non trovato → warning ma issue creata', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(teamResp), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { users: { nodes: [] } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(issueCreateResp), { status: 200 }));
    const r = await linearExecutor({
      teamKey: 'ENG', title: 'Bug', assigneeEmail: 'unknown@x.com',
    }, null, ctx);
    const out = r.output as { warnings: string[] };
    expect(out.warnings.some(w => w.includes('unknown@x.com'))).toBe(true);
  });

  it('labels comma → resolve a id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(teamResp), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { team: { labels: { nodes: [
          { id: 'l1', name: 'bug' },
          { id: 'l2', name: 'production' },
        ] } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(issueCreateResp), { status: 200 }));
    globalThis.fetch = fetchMock;
    await linearExecutor({ teamKey: 'ENG', title: 'Bug', labelNames: 'bug, production' }, null, ctx);
    // 3a fetch (issueCreate) deve avere labelIds nel variables
    const lastCall = JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body) as { variables: { input: { labelIds: string[] } } };
    expect(lastCall.variables.input.labelIds).toEqual(['l1', 'l2']);
  });

  it('GraphQL errors → throw', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      errors: [{ message: 'Invalid token', extensions: { code: 'UNAUTHENTICATED' } }],
    }), { status: 200 }));
    await expect(linearExecutor({ teamKey: 'ENG', title: 'Bug' }, null, ctx))
      .rejects.toThrow(/Invalid token/);
  });

  it('apiKey non valido (no prefix) → throw INVALID_CREDENTIALS', async () => {
    const mod = await import('@/services/integrations/store.js') as unknown as { getIntegration: ReturnType<typeof vi.fn> };
    mod.getIntegration.mockReturnValueOnce({
      provider: 'linear', tenantId: 't', label: null,
      credentials: { apiKey: 'not-valid' },
      expiresAt: null, createdAt: Date.now(), id: 'i1', createdByUserId: 'u',
    });
    await expect(linearExecutor({ teamKey: 'ENG', title: 'Bug' }, null, ctx))
      .rejects.toThrow(/apiKey non valido/);
  });
});
