/**
 * Tests for WhatsApp Cloud API client.
 *
 * No smoke. Every test exercises a real branch:
 *   • normaliseRecipient: strips chars + enforces 8–15 digit E.164 bound
 *   • sendText: payload shape pinned (preview_url, body, type)
 *   • sendText body length cap
 *   • sendTemplate: payload shape with components
 *   • sendTemplate language code regex (it / en_US / invalid)
 *   • error mapping: Meta error.code → WhatsAppApiError, HTTP 500 → WhatsAppTransportError
 *   • non-JSON body → WhatsAppTransportError
 *   • auth guards: phoneNumberId digit-only, accessToken min length
 */

import { describe, it, expect } from 'vitest';
import {
  normaliseRecipient,
  sendText,
  sendTemplate,
  WhatsAppApiError,
  WhatsAppTransportError,
  type WhatsAppHttpTransport,
} from './cloud-api-client.js';

function makeTransport() {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const queue: { status: number; text: string }[] = [];
  const transport: WhatsAppHttpTransport = {
    async post(args) {
      calls.push({ url: args.url, body: args.body, headers: { ...args.headers } });
      const next = queue.shift();
      if (!next) throw new Error('transport queue exhausted');
      return next;
    },
  };
  return { transport, calls, queue };
}

const AUTH = {
  phoneNumberId: '1234567890',
  accessToken: 'EAA' + 'x'.repeat(30),
};

// ────────────────────────────────────────────────────────────────────────────
// Recipient normalisation
// ────────────────────────────────────────────────────────────────────────────

describe('normaliseRecipient', () => {
  it('strips + spaces dashes parens, keeping digits only', () => {
    expect(normaliseRecipient('+39 333-123 4567')).toBe('393331234567');
    expect(normaliseRecipient('(+39) 333.1234567')).toBe('393331234567');
  });
  it('rejects 7-digit numbers', () => {
    expect(() => normaliseRecipient('1234567')).toThrow(/not a valid E\.164/);
  });
  it('rejects 16-digit numbers', () => {
    expect(() => normaliseRecipient('1234567890123456')).toThrow(/not a valid E\.164/);
  });
  it('rejects non-string', () => {
    expect(() => normaliseRecipient(123 as unknown as string)).toThrow(/string/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// sendText
// ────────────────────────────────────────────────────────────────────────────

describe('sendText — happy path', () => {
  it('posts the canonical Meta payload and returns the messages array', async () => {
    const { transport, calls, queue } = makeTransport();
    queue.push({
      status: 200,
      text: JSON.stringify({
        messaging_product: 'whatsapp',
        contacts: [{ input: '393331234567', wa_id: '393331234567' }],
        messages: [{ id: 'wamid.abc' }],
      }),
    });
    const out = await sendText(
      AUTH,
      { recipient: '+39 333 1234567', body: 'Ciao Mario', previewUrl: false },
      transport,
      { timeoutMs: 10_000 },
    );
    expect(out.messages?.[0]?.id).toBe('wamid.abc');

    const call = calls[0]!;
    expect(call.url).toBe('https://graph.facebook.com/v20.0/1234567890/messages');
    expect(call.headers.Authorization).toBe(`Bearer ${AUTH.accessToken}`);
    expect(call.headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(call.body) as Record<string, unknown>;
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '393331234567',
      type: 'text',
      text: { body: 'Ciao Mario', preview_url: false },
    });
  });

  it('rejects an empty body', async () => {
    const { transport } = makeTransport();
    await expect(
      sendText(AUTH, { recipient: '393331234567', body: '' }, transport, { timeoutMs: 1000 }),
    ).rejects.toThrow(/body required/);
  });

  it('rejects body > 4096 chars', async () => {
    const { transport } = makeTransport();
    await expect(
      sendText(AUTH, { recipient: '393331234567', body: 'x'.repeat(4097) }, transport, {
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/4096/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// sendTemplate
// ────────────────────────────────────────────────────────────────────────────

describe('sendTemplate — happy path', () => {
  it('emits the canonical template payload with components', async () => {
    const { transport, calls, queue } = makeTransport();
    queue.push({
      status: 200,
      text: JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 't.1' }] }),
    });
    await sendTemplate(
      AUTH,
      {
        recipient: '393331234567',
        templateName: 'pec_ricevuta_consegna',
        languageCode: 'it',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Mario Rossi' },
              { type: 'text', text: '2026-06-04' },
            ],
          },
        ],
      },
      transport,
      { timeoutMs: 10_000 },
    );
    const payload = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(payload.type).toBe('template');
    const tpl = payload.template as Record<string, unknown>;
    expect(tpl.name).toBe('pec_ricevuta_consegna');
    expect((tpl.language as { code: string }).code).toBe('it');
    const comps = tpl.components as Record<string, unknown>[];
    expect(comps[0]?.type).toBe('body');
    const params = comps[0]?.parameters as { type: string; text: string }[];
    expect(params[0]?.text).toBe('Mario Rossi');
  });

  it('accepts the long locale form (en_US, it_IT, ...)', async () => {
    const { transport, queue } = makeTransport();
    queue.push({
      status: 200,
      text: JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'x' }] }),
    });
    await expect(
      sendTemplate(
        AUTH,
        { recipient: '393331234567', templateName: 'tpl', languageCode: 'en_US' },
        transport,
        { timeoutMs: 1000 },
      ),
    ).resolves.toBeDefined();
  });

  it('rejects an invalid language code', async () => {
    const { transport } = makeTransport();
    await expect(
      sendTemplate(
        AUTH,
        { recipient: '393331234567', templateName: 'tpl', languageCode: 'italian' },
        transport,
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/languageCode/);
  });

  it('rejects missing templateName', async () => {
    const { transport } = makeTransport();
    await expect(
      sendTemplate(
        AUTH,
        { recipient: '393331234567', templateName: '', languageCode: 'it' },
        transport,
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/templateName/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Auth guards (anti-misuse)
// ────────────────────────────────────────────────────────────────────────────

describe('auth guards', () => {
  it('rejects non-numeric phoneNumberId (common mistake: passing the phone)', async () => {
    const { transport } = makeTransport();
    await expect(
      sendText(
        { phoneNumberId: '+39333123456', accessToken: AUTH.accessToken },
        { recipient: '393331234567', body: 'x' },
        transport,
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/digits-only/);
  });

  it('rejects an absurdly short access token', async () => {
    const { transport } = makeTransport();
    await expect(
      sendText(
        { phoneNumberId: '1', accessToken: 'short' },
        { recipient: '393331234567', body: 'x' },
        transport,
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/accessToken/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error mapping
// ────────────────────────────────────────────────────────────────────────────

describe('error mapping', () => {
  it('throws WhatsAppApiError on Meta error JSON', async () => {
    const { transport, queue } = makeTransport();
    queue.push({
      status: 400,
      text: JSON.stringify({
        error: {
          code: 131047,
          message: 'Re-engagement message outside 24-hour window',
          type: 'OAuthException',
          fbtrace_id: 'X',
        },
      }),
    });
    try {
      await sendText(AUTH, { recipient: '393331234567', body: 'x' }, transport, {
        timeoutMs: 1000,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppApiError);
      expect((err as WhatsAppApiError).metaCode).toBe(131047);
      expect((err as WhatsAppApiError).status).toBe(400);
    }
  });

  it('throws WhatsAppTransportError on HTTP 500 with no Meta JSON', async () => {
    const { transport, queue } = makeTransport();
    queue.push({ status: 500, text: '<html>boom</html>' });
    await expect(
      sendText(AUTH, { recipient: '393331234567', body: 'x' }, transport, { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(WhatsAppTransportError);
  });

  it('throws WhatsAppTransportError when the body is not JSON', async () => {
    const { transport, queue } = makeTransport();
    queue.push({ status: 200, text: 'NOT JSON' });
    await expect(
      sendText(AUTH, { recipient: '393331234567', body: 'x' }, transport, { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(WhatsAppTransportError);
  });
});
