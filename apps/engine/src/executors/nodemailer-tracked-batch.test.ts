/**
 * `sendEmailTrackedBatchExecutor` — wrapper tests.
 *
 * Stubs the single-send executor and the scheduler is real. Covers:
 *
 *  - validation: empty recipients list throws
 *  - consent gate: pre-flight check fails fast (no send attempted)
 *  - per-recipient interpolation: {{lead.name}} substitution
 *  - reads recipients from EITHER config OR upstream input.recipients
 *  - retryable vs non-retryable errors classified correctly
 *  - aggregate stats reflect actual outcomes
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendCalls: { config: Record<string, unknown>; input: unknown }[] = [];

vi.mock('./nodemailer-tracked.js', () => ({
  sendEmailTrackedExecutor: vi.fn(async (config: Record<string, unknown>, input: unknown) => {
    sendCalls.push({ config, input });
    if ((config.to as string).startsWith('throttle@')) {
      const err: Error & { code?: string } = new Error('Gmail 429 too many requests');
      throw err;
    }
    if ((config.to as string).startsWith('bad@')) {
      throw new Error('550 bad recipient — permanent');
    }
    return {
      output: { messageId: `m-${config.leadId as string}`, sendId: `s-${config.leadId as string}` },
      durationMs: 1,
    };
  }),
}));
vi.mock('@/lib/logger.js');

import { sendEmailTrackedBatchExecutor } from './nodemailer-tracked-batch.js';

const ctx = { tenantId: 'ws-1', workflowId: 'wf', runId: 'r', nodeId: 'n', secrets: {} } as const;

const baseCfg = {
  subject: 'Ciao {{lead.name}}',
  body: '<p>Hello {{lead.name}}</p>',
  campaignId: 'redivivo-w23',
  trackingBaseUrl: 'https://fabio-musicco.app.automazionezeli.com',
  clickWhitelist: ['redivivogin.it'],
  ratePerHour: 10_000, // ~ every 360ms — keeps tests sub-second
  jitter: 0,
  maxAttempts: 2,
  backoffBaseMs: 500,
  budgetMs: 60_000,
};

beforeEach(() => {
  sendCalls.length = 0;
});

describe('validation', () => {
  it('throws when recipients absent from BOTH config and input', async () => {
    await expect(
      sendEmailTrackedBatchExecutor(baseCfg, { consentVerified: true }, ctx),
    ).rejects.toThrow(/destinatari/i);
  });

  it('throws when recipients is an empty array', async () => {
    await expect(
      sendEmailTrackedBatchExecutor({ ...baseCfg, recipients: [] }, { consentVerified: true }, ctx),
    ).rejects.toThrow(/destinatari/i);
  });
});

describe('consent gate (batch)', () => {
  it('fails BEFORE any send when requireConsent=true and consentVerified absent', async () => {
    const recipients = [{ leadId: 'l1', to: 'x@y.it' }];
    await expect(
      sendEmailTrackedBatchExecutor({ ...baseCfg, recipients }, {}, ctx),
    ).rejects.toThrow(/consentVerified/);
    expect(sendCalls).toHaveLength(0);
  });

  it('proceeds with requireConsent=false', async () => {
    const recipients = [{ leadId: 'l1', to: 'x@y.it' }];
    const res = await sendEmailTrackedBatchExecutor(
      { ...baseCfg, recipients, requireConsent: false },
      {},
      ctx,
    );
    expect((res.output as { stats: { sent: number } }).stats.sent).toBe(1);
  });
});

describe('recipient source', () => {
  it('reads recipients from config when present', async () => {
    const recipients = [
      { leadId: 'l1', to: 'a@b.it' },
      { leadId: 'l2', to: 'c@d.it' },
    ];
    const res = await sendEmailTrackedBatchExecutor(
      { ...baseCfg, recipients },
      { consentVerified: true },
      ctx,
    );
    expect((res.output as { stats: { sent: number } }).stats.sent).toBe(2);
    expect(sendCalls).toHaveLength(2);
  });

  it('falls back to input.recipients when config field is absent', async () => {
    const recipients = [{ leadId: 'l1', to: 'a@b.it' }];
    const res = await sendEmailTrackedBatchExecutor(
      baseCfg,
      { consentVerified: true, recipients },
      ctx,
    );
    expect((res.output as { stats: { sent: number } }).stats.sent).toBe(1);
  });
});

describe('interpolation', () => {
  it('substitutes {{lead.name}} per recipient', async () => {
    const recipients = [
      { leadId: 'l1', to: 'a@b.it', templateVars: { 'lead.name': 'Mario' } },
      { leadId: 'l2', to: 'c@d.it', templateVars: { 'lead.name': 'Anna' } },
    ];
    await sendEmailTrackedBatchExecutor({ ...baseCfg, recipients }, { consentVerified: true }, ctx);
    expect(sendCalls[0]!.config.subject).toBe('Ciao Mario');
    expect(sendCalls[0]!.config.body).toContain('Hello Mario');
    expect(sendCalls[1]!.config.subject).toBe('Ciao Anna');
  });

  it('leaves placeholder empty when var is missing', async () => {
    const recipients = [{ leadId: 'l1', to: 'a@b.it' }]; // no templateVars
    await sendEmailTrackedBatchExecutor({ ...baseCfg, recipients }, { consentVerified: true }, ctx);
    expect(sendCalls[0]!.config.subject).toBe('Ciao ');
  });
});

describe('error classification', () => {
  it('retries on 429 — succeeds within budget', async () => {
    // First-attempt mock rejects for throttle@, then succeeds on 2nd attempt.
    let attempts = 0;
    sendCalls.length = 0;
    vi.resetModules();
    vi.doMock('./nodemailer-tracked.js', () => ({
      sendEmailTrackedExecutor: vi.fn(async (config: Record<string, unknown>, input: unknown) => {
        attempts += 1;
        sendCalls.push({ config, input });
        if (attempts === 1) throw new Error('Gmail 429 throttled');
        return { output: { messageId: 'm', sendId: 's' }, durationMs: 0 };
      }),
    }));
    const { sendEmailTrackedBatchExecutor: fresh } = await import('./nodemailer-tracked-batch.js');
    const recipients = [{ leadId: 'l1', to: 'r@x.it' }];
    const res = await fresh({ ...baseCfg, recipients }, { consentVerified: true }, ctx);
    expect((res.output as { stats: { sent: number; failed: number } }).stats.sent).toBe(1);
    expect(attempts).toBe(2);
    vi.doUnmock('./nodemailer-tracked.js');
  });

  it('does NOT retry 5xx permanent errors', async () => {
    const recipients = [{ leadId: 'l1', to: 'bad@x.it' }];
    const res = await sendEmailTrackedBatchExecutor(
      { ...baseCfg, recipients },
      { consentVerified: true },
      ctx,
    );
    const stats = (res.output as { stats: { sent: number; failed: number } }).stats;
    expect(stats.sent).toBe(0);
    expect(stats.failed).toBe(1);
    // Only ONE call — no retry on 550.
    expect(sendCalls).toHaveLength(1);
  });
});

describe('stats', () => {
  it('reports aggregated counts', async () => {
    const recipients = [
      { leadId: 'l1', to: 'good@x.it' },
      { leadId: 'l2', to: 'bad@x.it' },
      { leadId: 'l3', to: 'good2@x.it' },
    ];
    const res = await sendEmailTrackedBatchExecutor(
      { ...baseCfg, recipients },
      { consentVerified: true },
      ctx,
    );
    const stats = (res.output as { stats: { sent: number; failed: number } }).stats;
    expect(stats.sent).toBe(2);
    expect(stats.failed).toBe(1);
  });
});
