/**
 * Test pecArubaReceiveExecutor — wiring IMAP → parse → output PEC strutturato.
 *
 * ImapFlow mockato (zero rete): verifica che l'executor scarichi il SOURCE
 * (source:true), lo parsi e produca la shape { messageId, from, to, subject,
 * body, attachments[], pecHeaders, pecType } promessa dalla description, e che
 * il filtro oggetto (regex) funzioni. Anti-regressione del fix "envelope-only".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchCalls: { query: unknown; opts: unknown }[] = [];
let messagesToYield: { uid: number; envelope: { subject: string }; source: Buffer }[] = [];

vi.mock('imapflow', () => ({
  ImapFlow: class {
    connect = vi.fn(async () => undefined);
    logout = vi.fn(async () => undefined);
    getMailboxLock = vi.fn(async () => ({ release: vi.fn() }));
    fetch(query: unknown, opts: unknown) {
      fetchCalls.push({ query, opts });
      return (async function* () {
        for (const m of messagesToYield) yield m;
      })();
    }
  },
}));

const { pecArubaReceiveExecutor } = await import('./pec-receive.js');

function eml(headers: Record<string, string>, body: string): Buffer {
  const hd = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  return Buffer.from(`${hd}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
}

const ctx = { workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't' } as never;

beforeEach(() => {
  fetchCalls.length = 0;
  messagesToYield = [];
});

describe('pecArubaReceiveExecutor', () => {
  it('🚨 username/password mancanti → throw', async () => {
    await expect(
      pecArubaReceiveExecutor({ username: '', password: '' }, null, ctx),
    ).rejects.toThrow(/username\/password required/u);
  });

  it('🚨 scarica il SOURCE (source:true) e produce la shape PEC completa con pecType', async () => {
    messagesToYield = [
      {
        uid: 1,
        envelope: { subject: 'CONSEGNA' },
        source: eml(
          {
            'Message-ID': '<r@pec.it>',
            From: 'posta-certificata@pec.aruba.it',
            To: 'mittente@pec.it',
            Subject: 'CONSEGNA',
            'X-Ricevuta': 'avvenuta-consegna',
            'X-Riferimento-Message-ID': '<orig@pec.it>',
          },
          'Ricevuta di consegna.',
        ),
      },
    ];
    const r = await pecArubaReceiveExecutor({ username: 'u@pec.it', password: 'p' }, null, ctx);

    // source:true richiesto nella fetch (altrimenti niente body/attachments/header).
    expect((fetchCalls[0]?.opts as { source?: boolean }).source).toBe(true);

    const out = r.output as { count: number; messages: Record<string, unknown>[] };
    expect(out.count).toBe(1);
    const msg = out.messages[0]!;
    expect(msg.messageId).toBe('<r@pec.it>');
    expect(msg.to).toBe('mittente@pec.it');
    expect(msg.body).toContain('Ricevuta di consegna');
    expect(msg.pecType).toBe('delivery');
    expect((msg.pecHeaders as Record<string, string>)['X-Riferimento-Message-ID']).toBe(
      '<orig@pec.it>',
    );
  });

  it('🚨 filtro oggetto (regex) scarta i messaggi non corrispondenti', async () => {
    messagesToYield = [
      {
        uid: 1,
        envelope: { subject: 'Fattura n.1' },
        source: eml(
          { From: 'a@pec.it', Subject: 'Fattura n.1', 'X-Trasporto': 'posta-certificata' },
          'b',
        ),
      },
      {
        uid: 2,
        envelope: { subject: 'Newsletter' },
        source: eml(
          { From: 'b@pec.it', Subject: 'Newsletter', 'X-Trasporto': 'posta-certificata' },
          'b',
        ),
      },
    ];
    const r = await pecArubaReceiveExecutor(
      { username: 'u@pec.it', password: 'p', filterSubject: '^Fattura' },
      null,
      ctx,
    );
    const out = r.output as { count: number; messages: { subject: string }[] };
    expect(out.count).toBe(1);
    expect(out.messages[0]?.subject).toBe('Fattura n.1');
  });
});

describe('pecArubaReceiveExecutor — SSRF host guard (review nodi)', () => {
  it('🔴 host IMAP interno (config.host) → throw, niente connessione alla rete interna', async () => {
    await expect(
      pecArubaReceiveExecutor(
        { username: 'u@pec.it', password: 'p', host: '172.20.0.1' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/non ammesso|SSRF|interno/u);
  });

  it('🔴 host loopback → throw', async () => {
    await expect(
      pecArubaReceiveExecutor(
        { username: 'u@pec.it', password: 'p', host: '127.0.0.1' },
        null,
        ctx,
      ),
    ).rejects.toThrow(/non ammesso|SSRF|interno/u);
  });
});
