/**
 * Test 2026-grade — executors/integrations/gmail.ts (nodo Gmail dedicato).
 *
 * Nessuna rete: mock di requireIntegration (vault), google-oauth (auto-refresh)
 * e jsonFetch (HTTP). Verifica:
 *  - send: costruzione RFC822 corretta (To/Subject/body, encoded-word non-ASCII,
 *    multipart/alternative su text+html, multipart/mixed con allegato)
 *  - auto-refresh: il token "fresh" da ensureFreshGoogleAccessToken finisce
 *    nella chiamata HTTP
 *  - list: arricchimento metadata (from/subject/date)
 *  - get: parsing di bodyText/bodyHtml + allegati
 *  - errori: to mancante, body mancante, credenziali incomplete, op ignota
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  requireIntegration: vi.fn(),
  ensureFresh: vi.fn(),
  buildOAuthClient: vi.fn(),
  jsonFetch: vi.fn(),
}));

vi.mock('./common.js', async (orig) => {
  const actual = await orig<typeof import('./common.js')>();
  return {
    ...actual,
    requireIntegration: m.requireIntegration,
    withRetry: <T>(fn: () => Promise<T>) => fn(), // pass-through, no backoff nei test
  };
});

vi.mock('./google-oauth.js', () => ({
  buildOAuthClient: m.buildOAuthClient,
  ensureFreshGoogleAccessToken: m.ensureFresh,
}));

vi.mock('./saas-shared.js', () => ({
  jsonFetch: m.jsonFetch,
  getIntegrationLabel: (cfg: Record<string, unknown>) =>
    typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null,
}));

const { gmailExecutor } = await import('./gmail.js');

const ctx = { tenantId: 'ten-1', runId: 'run-1', nodeId: 'node-1' } as unknown as Parameters<
  typeof gmailExecutor
>[2];

/** Ultima chiamata jsonFetch che matcha un pezzo di URL. */
function callFor(urlPart: string): {
  url: string;
  token: string | null;
  opts: { method?: string; body?: { raw?: string } };
} {
  const calls = m.jsonFetch.mock.calls as unknown[][];
  const hit = [...calls].reverse().find((c) => String(c[1]).includes(urlPart));
  if (!hit) throw new Error(`nessuna jsonFetch per "${urlPart}"`);
  return {
    url: String(hit[1]),
    token: hit[2] as string | null,
    opts: (hit[3] ?? {}) as { method?: string; body?: { raw?: string } },
  };
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.requireIntegration.mockReturnValue({
    id: 'int-1',
    provider: 'gmail',
    tenantId: 'ten-1',
    credentials: {
      accessToken: 'stale',
      refreshToken: 'refresh',
      scope: 'gmail.send',
      userEmail: 'me@gmail.com',
    },
    expiresAt: Date.now() + 3600_000,
  });
  m.buildOAuthClient.mockResolvedValue({
    clientId: 'cid',
    clientSecret: 'sec',
    defaultRedirectUri: undefined,
  });
  m.ensureFresh.mockResolvedValue('fresh-token');
  m.jsonFetch.mockResolvedValue({});
});

describe('🚨 gmail send — costruzione MIME + auth', () => {
  it('send testo: To/Subject/body corretti + usa il token refreshato', async () => {
    m.jsonFetch.mockResolvedValueOnce({ id: 'm1', threadId: 't1', labelIds: ['SENT'] });
    const r = await gmailExecutor(
      { operation: 'send', to: 'dest@x.it', subject: 'Ciao', bodyText: 'Corpo del messaggio' },
      null,
      ctx,
    );
    const out = r.output as { ok: boolean; id: string; threadId: string };
    expect(out).toMatchObject({ ok: true, id: 'm1', threadId: 't1' });
    const send = callFor('/messages/send');
    expect(send.opts.method).toBe('POST');
    expect(send.token).toBe('fresh-token'); // auto-refresh usato
    const raw = decodeRaw(send.opts.body!.raw!);
    expect(raw).toContain('To: dest@x.it');
    expect(raw).toContain('Subject: Ciao');
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain(Buffer.from('Corpo del messaggio', 'utf8').toString('base64'));
  });

  it('🚨 subject non-ASCII → MIME encoded-word (=?UTF-8?B?…?=)', async () => {
    m.jsonFetch.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    await gmailExecutor(
      { operation: 'send', to: 'd@x.it', subject: 'Però è così — €', bodyText: 'x' },
      null,
      ctx,
    );
    const raw = decodeRaw(callFor('/messages/send').opts.body!.raw!);
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).not.toContain('Subject: Però'); // il raw non contiene il testo non codificato
  });

  it('text + html → multipart/alternative', async () => {
    m.jsonFetch.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    await gmailExecutor(
      { operation: 'send', to: 'd@x.it', subject: 's', bodyText: 'plain', bodyHtml: '<b>rich</b>' },
      null,
      ctx,
    );
    const raw = decodeRaw(callFor('/messages/send').opts.body!.raw!);
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
  });

  it('con allegato → multipart/mixed + Content-Disposition attachment', async () => {
    m.jsonFetch.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    const b64 = Buffer.from('PDFDATA').toString('base64');
    await gmailExecutor(
      {
        operation: 'send',
        to: 'd@x.it',
        subject: 's',
        bodyText: 'body',
        attachmentsJson: JSON.stringify([
          { filename: 'report.pdf', content: b64, mimeType: 'application/pdf' },
        ]),
      },
      null,
      ctx,
    );
    const raw = decodeRaw(callFor('/messages/send').opts.body!.raw!);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(raw).toContain('Content-Type: application/pdf');
  });

  it('accetta allegati anche in forma { name, base64, contentType } e come array già parsato', async () => {
    m.jsonFetch.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    const b64 = Buffer.from('X').toString('base64');
    await gmailExecutor(
      {
        operation: 'send',
        to: 'd@x.it',
        subject: 's',
        bodyText: 'b',
        attachmentsJson: [{ name: 'a.txt', base64: b64, contentType: 'text/plain' }],
      },
      null,
      ctx,
    );
    const raw = decodeRaw(callFor('/messages/send').opts.body!.raw!);
    expect(raw).toContain('filename="a.txt"');
  });

  it('send senza "to" → INVALID_PAYLOAD, nessuna chiamata send', async () => {
    await expect(gmailExecutor({ operation: 'send', bodyText: 'x' }, null, ctx)).rejects.toThrow(
      /destinatario/i,
    );
  });

  it('send senza corpo → INVALID_PAYLOAD', async () => {
    await expect(gmailExecutor({ operation: 'send', to: 'd@x.it' }, null, ctx)).rejects.toThrow(
      /bodyText.*bodyHtml/,
    );
  });
});

describe('gmail list — arricchimento metadata', () => {
  it('lista + recupera from/subject/date/snippet per ogni messaggio', async () => {
    m.jsonFetch
      .mockResolvedValueOnce({ messages: [{ id: 'a', threadId: 'ta' }], resultSizeEstimate: 1 })
      .mockResolvedValueOnce({
        id: 'a',
        threadId: 'ta',
        snippet: 'anteprima',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'mittente@x.it' },
            { name: 'Subject', value: 'Oggetto X' },
            { name: 'Date', value: 'Wed, 3 Jul 2026' },
          ],
        },
      });
    const r = await gmailExecutor(
      { operation: 'list', query: 'is:unread', maxResults: 5 },
      null,
      ctx,
    );
    const out = r.output as {
      count: number;
      messages: { from: string; subject: string; snippet: string }[];
    };
    expect(out.count).toBe(1);
    expect(out.messages[0]).toMatchObject({
      from: 'mittente@x.it',
      subject: 'Oggetto X',
      snippet: 'anteprima',
    });
    // la query è finita nell'URL
    expect(callFor('/messages?').url).toContain('q=is%3Aunread');
  });
});

describe('gmail get — parsing corpo + allegati', () => {
  it('estrae bodyText, bodyHtml e allegati da payload multipart', async () => {
    m.jsonFetch.mockResolvedValueOnce({
      id: 'g1',
      threadId: 'tg',
      snippet: 's',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'a@b.it' },
          { name: 'Subject', value: 'Sub' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('ciao testo', 'utf8').toString('base64url') },
          },
          {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>ciao</p>', 'utf8').toString('base64url') },
          },
          {
            mimeType: 'application/pdf',
            filename: 'f.pdf',
            body: { attachmentId: 'att1', size: 1234 },
          },
        ],
      },
    });
    const r = await gmailExecutor({ operation: 'get', messageId: 'g1' }, null, ctx);
    const out = r.output as {
      bodyText: string;
      bodyHtml: string;
      subject: string;
      attachments: { filename: string; size: number }[];
    };
    expect(out.bodyText).toBe('ciao testo');
    expect(out.bodyHtml).toBe('<p>ciao</p>');
    expect(out.subject).toBe('Sub');
    expect(out.attachments).toEqual([
      { filename: 'f.pdf', mimeType: 'application/pdf', attachmentId: 'att1', size: 1234 },
    ]);
  });

  it('get senza messageId → INVALID_PAYLOAD', async () => {
    await expect(gmailExecutor({ operation: 'get' }, null, ctx)).rejects.toThrow(/messageId/);
  });
});

describe('gmail — auth e operazioni', () => {
  it('🚨 credenziali senza refreshToken → INVALID_CREDENTIALS (no chiamata)', async () => {
    m.requireIntegration.mockReturnValueOnce({
      id: 'int-1',
      provider: 'gmail',
      tenantId: 'ten-1',
      credentials: { accessToken: 'x', scope: 'gmail.send' },
      expiresAt: null,
    });
    await expect(
      gmailExecutor({ operation: 'send', to: 'd@x.it', bodyText: 'b' }, null, ctx),
    ).rejects.toThrow(/Riconnetti Google/);
    expect(m.jsonFetch).not.toHaveBeenCalled();
  });

  it('operazione ignota → INVALID_PAYLOAD', async () => {
    await expect(gmailExecutor({ operation: 'archive' }, null, ctx)).rejects.toThrow(
      /non supportata/,
    );
  });
});
