/**
 * Telegram integration tests.
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: vi.fn().mockReturnValue({
    provider: 'telegram',
    tenantId: 't',
    label: null,
    credentials: { botToken: '123456789:ABCdefGhIjKlMnOpQrStUvWxYz' },
    expiresAt: null,
    createdAt: Date.now(),
    id: 'i1',
    createdByUserId: 'u',
  }),
}));

import { telegramExecutor } from './telegram.js';

const ctx = {
  workflowId: 'wf',
  runId: 'r',
  nodeId: 'n',
  tenantId: 't',
  userId: 'u',
  defId: 'integration_telegram_send',
  secrets: {},
  llmProviders: [],
  nodeOutputs: {},
} as unknown as Parameters<typeof telegramExecutor>[2];

describe('telegramExecutor', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('sendMessage text → ok + messageId', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 42, chat: { id: -1001234567890 }, date: 1717599999 },
        }),
        { status: 200 },
      ),
    );
    const r = await telegramExecutor({ chatId: '-1001234567890', text: 'Hello' }, null, ctx);
    const out = r.output as { ok: boolean; messageId: number; mode: string };
    expect(out.ok).toBe(true);
    expect(out.messageId).toBe(42);
    expect(out.mode).toBe('message');
  });

  it('sendPhoto se photoUrl valorizzato', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 43, chat: { id: 100 }, date: 0 },
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;
    const r = await telegramExecutor(
      {
        chatId: '100',
        text: 'Caption',
        photoUrl: 'https://example.com/img.png',
      },
      null,
      ctx,
    );
    const out = r.output as { mode: string };
    expect(out.mode).toBe('photo');
    expect(fetchMock.mock.calls[0]![0] as string).toContain('/sendPhoto');
  });

  it('parseMode invalido → throw INVALID_PAYLOAD', async () => {
    await expect(
      telegramExecutor(
        {
          chatId: '1',
          text: 't',
          parseMode: 'WrongMode',
        },
        null,
        ctx,
      ),
    ).rejects.toThrow(/parseMode.*non supportato/);
  });

  it('chatId vuoto → throw', async () => {
    await expect(telegramExecutor({ chatId: '', text: 't' }, null, ctx)).rejects.toThrow(
      /"chatId" e\\` obbligatorio/,
    );
  });

  it('no text + no photoUrl → throw', async () => {
    await expect(telegramExecutor({ chatId: '1' }, null, ctx)).rejects.toThrow(
      /serve almeno uno tra "text" e "photoUrl"/,
    );
  });

  it('Telegram API error → throw con descrizione', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
        { status: 400 },
      ),
    );
    await expect(telegramExecutor({ chatId: 'invalid', text: 't' }, null, ctx)).rejects.toThrow(
      /Telegram API error 400/,
    );
  });

  it('disableNotification → payload include disable_notification', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, chat: { id: 1 }, date: 0 },
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;
    await telegramExecutor({ chatId: '1', text: 't', disableNotification: true }, null, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      disable_notification: boolean;
    };
    expect(body.disable_notification).toBe(true);
  });

  it('parseMode=none → omette parse_mode dal payload', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, chat: { id: 1 }, date: 0 },
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;
    await telegramExecutor({ chatId: '1', text: 't', parseMode: 'none' }, null, ctx);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body.parse_mode).toBeUndefined();
  });
});
