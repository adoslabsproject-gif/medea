/**
 * `sendEmailTrackedExecutor` — wrapper tests.
 *
 * Tests the WRAPPER logic, not the delegated SMTP layer:
 *
 *   - consent gate: throws when requireConsent=true and no
 *     `consentVerified: true` in input
 *   - consent gate: passes when requireConsent=false even with empty input
 *   - missing tracking base URL → throw with actionable message
 *   - missing FLOWFORGE_SSO_SECRET → throw
 *   - body is injected before delegation (pixel + click rewrite present)
 *   - on success → b2b_interactions row of type 'email_sent' inserted
 *   - sendId auto-generated when omitted
 *   - sendId honored when supplied (idempotency)
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const sqliteMem = new Database(':memory:');
sqliteMem.exec(`
  CREATE TABLE IF NOT EXISTS b2b_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    campaign_id TEXT,
    send_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`);

const sendCalls: { config: Record<string, unknown>; input: unknown; ctx: unknown }[] = [];

vi.mock('./nodemailer.js', () => ({
  sendEmailExecutor: vi.fn(async (config: Record<string, unknown>, input: unknown, ctx: unknown) => {
    sendCalls.push({ config, input, ctx });
    return { output: { messageId: '<test@mid>', accepted: ['x@y.it'], rejected: [] }, durationMs: 12 };
  }),
}));
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteMem }),
}));
vi.mock('@/config.js', () => ({
  loadConfig: () => ({
    FLOWFORGE_SSO_SECRET: 'd'.repeat(64),
    FLOWFORGE_PUBLIC_BASE_URL: 'https://fabio-musicco.app.automazionezeli.com',
  }),
}));
vi.mock('@/lib/logger.js');

import { sendEmailTrackedExecutor } from './nodemailer-tracked.js';

const ctx = { tenantId: 'ws-1', workflowId: 'wf', runId: 'r', nodeId: 'n', secrets: {} } as const;

const baseCfg = {
  to: 'mario@enoteca.it',
  subject: 'Redivivo Gin',
  body: '<html><body><p>Ciao</p><a href="https://redivivogin.it/catalog">catalogo</a></body></html>',
  leadId: 'lead-42',
  campaignId: 'redivivo-w23',
  clickWhitelist: ['redivivogin.it'],
};

beforeEach(() => {
  sendCalls.length = 0;
  sqliteMem.prepare('DELETE FROM b2b_interactions').run();
});

describe('consent gate', () => {
  it('throws when requireConsent=true (default) and consentVerified missing', async () => {
    await expect(sendEmailTrackedExecutor(baseCfg, {}, ctx))
      .rejects.toThrow(/consentVerified=true/);
    expect(sendCalls).toHaveLength(0);
  });

  it('throws when consentVerified is "true" (string) — refuses coercion', async () => {
    await expect(sendEmailTrackedExecutor(baseCfg, { consentVerified: 'true' }, ctx))
      .rejects.toThrow(/consentVerified/);
  });

  it('passes when consentVerified === true (literal)', async () => {
    const res = await sendEmailTrackedExecutor(baseCfg, { consentVerified: true }, ctx);
    expect(sendCalls).toHaveLength(1);
    expect(res.output).toBeDefined();
  });

  it('bypasses consent gate when requireConsent=false', async () => {
    const res = await sendEmailTrackedExecutor({ ...baseCfg, requireConsent: false }, {}, ctx);
    expect(sendCalls).toHaveLength(1);
    expect(res.output).toBeDefined();
  });
});

describe('body injection', () => {
  it('injects pixel + rewrites whitelist link before delegating', async () => {
    await sendEmailTrackedExecutor(baseCfg, { consentVerified: true }, ctx);
    expect(sendCalls).toHaveLength(1);
    const delegatedBody = sendCalls[0]!.config.body as string;
    expect(delegatedBody).toMatch(/<img[^>]+\/api\/track\/open\//);
    expect(delegatedBody).toContain('/api/track/click/');
    expect(delegatedBody).toContain(encodeURIComponent('https://redivivogin.it/catalog'));
  });

  it('omits injection for text bodyType (text/plain cannot host <img>)', async () => {
    await sendEmailTrackedExecutor(
      { ...baseCfg, bodyType: 'text', body: 'Hello World' },
      { consentVerified: true },
      ctx,
    );
    expect(sendCalls[0]!.config.body).toBe('Hello World');
  });

  it('returns the openToken + pixelUrl + clickTokens in output', async () => {
    const res = await sendEmailTrackedExecutor(baseCfg, { consentVerified: true }, ctx);
    const out = res.output as Record<string, unknown>;
    expect(typeof out.openToken).toBe('string');
    expect((out.openToken as string).length).toBeGreaterThan(20);
    expect(typeof out.pixelUrl).toBe('string');
    expect((out.pixelUrl as string)).toMatch(/^https:.*\/api\/track\/open\//);
    expect(Array.isArray(out.clickTokens)).toBe(true);
    expect((out.clickTokens as string[]).length).toBe(1);
  });
});

describe('infra failures', () => {
  it('throws when trackingBaseUrl absent (env + config both empty)', async () => {
    vi.doMock('@/config.js', () => ({
      loadConfig: () => ({ FLOWFORGE_SSO_SECRET: 'd'.repeat(64) }),
    }));
    vi.resetModules();
    const { sendEmailTrackedExecutor: freshFn } = await import('./nodemailer-tracked.js');
    await expect(freshFn(baseCfg, { consentVerified: true }, ctx))
      .rejects.toThrow(/trackingBaseUrl|FLOWFORGE_PUBLIC_BASE_URL/);
    vi.doUnmock('@/config.js');
  });

  it('throws when FLOWFORGE_SSO_SECRET absent or too short', async () => {
    vi.resetModules();
    vi.doMock('@/config.js', () => ({
      loadConfig: () => ({ FLOWFORGE_PUBLIC_BASE_URL: 'https://x.app/' }),
    }));
    delete process.env.FLOWFORGE_SSO_SECRET;
    const { sendEmailTrackedExecutor: freshFn } = await import('./nodemailer-tracked.js');
    await expect(freshFn(baseCfg, { consentVerified: true }, ctx))
      .rejects.toThrow(/FLOWFORGE_SSO_SECRET/);
    vi.doUnmock('@/config.js');
  });
});

describe('interaction logging', () => {
  it('inserts an email_sent row with the messageId + sendId', async () => {
    const res = await sendEmailTrackedExecutor(baseCfg, { consentVerified: true }, ctx);
    const sendId = (res.output as Record<string, unknown>).sendId as string;
    expect(typeof sendId).toBe('string');

    const rows = sqliteMem.prepare(
      "SELECT * FROM b2b_interactions WHERE type='email_sent'",
    ).all() as { tenant_id: string; lead_id: string; campaign_id: string; send_id: string; payload_json: string }[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tenant_id).toBe('ws-1');
    expect(row.lead_id).toBe('lead-42');
    expect(row.campaign_id).toBe('redivivo-w23');
    expect(row.send_id).toBe(sendId);
    expect(JSON.parse(row.payload_json).messageId).toBe('<test@mid>');
  });

  it('honors caller-supplied sendId (idempotency)', async () => {
    await sendEmailTrackedExecutor({ ...baseCfg, sendId: 'caller-supplied-123' }, { consentVerified: true }, ctx);
    const rows = sqliteMem.prepare("SELECT send_id FROM b2b_interactions").all() as { send_id: string }[];
    expect(rows[0]!.send_id).toBe('caller-supplied-123');
  });
});
