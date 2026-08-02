/**
 * Slack integration executor tests.
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: vi.fn().mockReturnValue({
    provider: 'slack',
    tenantId: 't',
    label: null,
    credentials: { botToken: 'xoxb-test-1234567890-abcdef' },
    expiresAt: null,
    createdAt: Date.now(),
    id: 'i1',
    createdByUserId: 'u',
  }),
}));

import { slackExecutor } from './slack.js';

const ctx = {
  workflowId: 'wf',
  runId: 'r',
  nodeId: 'n',
  tenantId: 't',
  userId: 'u',
  defId: 'integration_slack_post',
  secrets: {},
  llmProviders: [],
  nodeOutputs: {},
} as unknown as Parameters<typeof slackExecutor>[2];

describe('slackExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('postMessage successo → output.ts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          ts: '1717599999.123456',
          channel: 'C123',
          message: { text: 'Hello', ts: '1717599999.123456' },
        }),
        { status: 200 },
      ),
    );
    const r = await slackExecutor({ channel: '#general', text: 'Hello' }, null, ctx);
    const out = r.output as { ok: boolean; ts: string; channel: string };
    expect(out.ok).toBe(true);
    expect(out.ts).toBe('1717599999.123456');
    expect(out.channel).toBe('C123');
  });

  it('blocks JSON parsed e passato a Slack', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          ts: '1.2',
          channel: 'C1',
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;
    const blocks = JSON.stringify([{ type: 'section', text: { type: 'mrkdwn', text: '*x*' } }]);
    await slackExecutor({ channel: 'C1', text: 'fb', blocks }, null, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      blocks: unknown[];
    };
    expect(body.blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: '*x*' } }]);
  });

  it('threadTs → thread_ts nel payload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, ts: '2.0' }), { status: 200 }),
      );
    globalThis.fetch = fetchMock;
    await slackExecutor({ channel: 'C1', text: 't', threadTs: '1.0' }, null, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      thread_ts: string;
    };
    expect(body.thread_ts).toBe('1.0');
  });

  it('Slack error ok:false → throw con error code', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'channel_not_found',
        }),
        { status: 200 },
      ),
    );
    await expect(slackExecutor({ channel: 'C-no-exists', text: 't' }, null, ctx)).rejects.toThrow(
      /channel_not_found/,
    );
  });

  it('channel vuoto → throw INVALID_PAYLOAD', async () => {
    await expect(slackExecutor({ channel: '', text: 't' }, null, ctx)).rejects.toThrow(
      /"channel" e\\` obbligatorio/,
    );
  });

  it('text vuoto → throw INVALID_PAYLOAD', async () => {
    await expect(slackExecutor({ channel: 'C1', text: '' }, null, ctx)).rejects.toThrow(
      /"text" e\\` obbligatorio/,
    );
  });

  it('blocks JSON malformato → throw', async () => {
    await expect(
      slackExecutor({ channel: 'C1', text: 'fb', blocks: 'not-json' }, null, ctx),
    ).rejects.toThrow(/blocks JSON parse fallito/);
  });

  it('HTTP 500 → throw API_HTTP_ERROR dopo retry', async () => {
    // 4 chiamate: initial + 3 retries con exp-backoff (~1+2+4 = 7s totale)
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(slackExecutor({ channel: 'C1', text: 't' }, null, ctx)).rejects.toThrow(
      /Slack HTTP 500/,
    );
  }, 15_000); // 15s timeout (default 5s troppo breve per exp-backoff)
});
