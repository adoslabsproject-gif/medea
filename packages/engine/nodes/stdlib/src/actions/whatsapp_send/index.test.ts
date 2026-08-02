/**
 * `action_whatsapp_send` — executor E2E tests.
 *
 * Coverage:
 *   • schema cross-field: text needs body, template needs templateName + languageCode
 *   • happy path text + template — output shape (messageId, recipient, mode, response)
 *   • Meta error → ValidationError with metaCode in context
 *   • HTTP transport → HttpError on Meta 500
 *   • abort propagation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { whatsAppSendExecutor } from './executor.js';
import { WhatsAppSendConfigSchema } from './schema.js';
import { HttpError, ValidationError, AbortedError } from '../../core/node-error.js';

vi.mock('@medea/engine-safe-fetch', () => ({
  safeFetchWithRedirects: vi.fn(),
  assertUrlSafe: vi.fn(),
}));

const { safeFetchWithRedirects } = await import('@medea/engine-safe-fetch');
const mockedFetch = vi.mocked(safeFetchWithRedirects);

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };

const TOKEN = 'EAA' + 'x'.repeat(40);
const BASE = {
  phoneNumberId: '1234567890',
  accessToken: TOKEN,
  recipient: '+39 333 1234567',
};

function rsp(text: string, status = 200): Response {
  return new Response(text, { status });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

// ────────────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────────────

describe('WhatsAppSendConfigSchema', () => {
  it('rejects mode=text without body', () => {
    const r = WhatsAppSendConfigSchema.safeParse({ ...BASE, mode: 'text' });
    expect(r.success).toBe(false);
  });
  it('rejects mode=template without templateName', () => {
    const r = WhatsAppSendConfigSchema.safeParse({ ...BASE, mode: 'template', languageCode: 'it' });
    expect(r.success).toBe(false);
  });
  it('rejects mode=template without languageCode', () => {
    const r = WhatsAppSendConfigSchema.safeParse({ ...BASE, mode: 'template', templateName: 'x' });
    expect(r.success).toBe(false);
  });
  it('rejects phoneNumberId with leading +', () => {
    const r = WhatsAppSendConfigSchema.safeParse({ ...BASE, phoneNumberId: '+1234567890' });
    expect(r.success).toBe(false);
  });
  it('rejects malformed componentsJson', () => {
    const r = WhatsAppSendConfigSchema.safeParse({
      ...BASE, mode: 'template', templateName: 't', languageCode: 'it',
      componentsJson: '{not array}',
    });
    expect(r.success).toBe(false);
  });
  it('accepts minimal text config', () => {
    const r = WhatsAppSendConfigSchema.safeParse({ ...BASE, body: 'hello' });
    expect(r.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Happy paths
// ────────────────────────────────────────────────────────────────────────────

describe('whatsAppSendExecutor — text mode', () => {
  it('returns messageId and shapes output', async () => {
    mockedFetch.mockResolvedValueOnce(rsp(JSON.stringify({
      messaging_product: 'whatsapp',
      messages: [{ id: 'wamid.111' }],
    })));
    const out = await whatsAppSendExecutor({ ...BASE, mode: 'text', body: 'Ciao Mario' }, null, ctx);
    const o = out.output as Record<string, unknown>;
    expect(o.messageId).toBe('wamid.111');
    expect(o.mode).toBe('text');
    expect(o.recipient).toBe('+39 333 1234567');
  });

  it('emits pipelineSteps when log is on', async () => {
    mockedFetch.mockResolvedValueOnce(rsp(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'x' }] })));
    const out = await whatsAppSendExecutor({ ...BASE, mode: 'text', body: 'x' }, null, ctx);
    const steps = (out.output as Record<string, unknown>).pipelineSteps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.name).toBe('whatsapp_send_text');
  });
});

describe('whatsAppSendExecutor — template mode', () => {
  it('forwards components and reports template info in evidence', async () => {
    mockedFetch.mockResolvedValueOnce(rsp(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.tpl' }] })));
    const out = await whatsAppSendExecutor({
      ...BASE,
      mode: 'template',
      templateName: 'pec_ricevuta_consegna',
      languageCode: 'it',
      componentsJson: '[{"type":"body","parameters":[{"type":"text","text":"Mario"}]}]',
    }, null, ctx);
    expect((out.output as Record<string, unknown>).messageId).toBe('wamid.tpl');

    // Check the HTTP body
    const sentBody = JSON.parse(mockedFetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(sentBody.type).toBe('template');
    const tpl = sentBody.template as Record<string, unknown>;
    expect(tpl.name).toBe('pec_ricevuta_consegna');
    expect((tpl.language as { code: string }).code).toBe('it');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error mapping
// ────────────────────────────────────────────────────────────────────────────

describe('whatsAppSendExecutor — error mapping', () => {
  it('maps Meta error to ValidationError carrying metaCode', async () => {
    mockedFetch.mockResolvedValueOnce(rsp(JSON.stringify({
      error: { code: 131047, message: 'Re-engagement window closed' },
    }), 400));
    let caught: unknown = null;
    try {
      await whatsAppSendExecutor({ ...BASE, mode: 'text', body: 'x' }, null, ctx);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toMatch(/131047/);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    expect((caught as ValidationError).context?.metaCode).toBe(131047);
  });

  it('throws HttpError on Meta 500 with no JSON body', async () => {
    mockedFetch.mockResolvedValueOnce(rsp('<html>boom</html>', 500));
    await expect(whatsAppSendExecutor({ ...BASE, mode: 'text', body: 'x' }, null, ctx))
      .rejects.toBeInstanceOf(HttpError);
  });

  it('throws AbortedError when context.abortSignal is pre-aborted', async () => {
    const ctrl = new AbortController(); ctrl.abort();
    await expect(whatsAppSendExecutor(
      { ...BASE, mode: 'text', body: 'x' }, null,
      { ...ctx, abortSignal: ctrl.signal },
    )).rejects.toBeInstanceOf(AbortedError);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
