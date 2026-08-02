/**
 * Test 2026-grade — Email tracking sink (open pixel + click redirect).
 *
 * 🚨 SECURITY: open-redirect blocked (rifiuta javascript: / data: / file:).
 * 🚨 GDPR: IP hashato SHA-256 (no raw storage).
 * 🚨 RESILIENCE: bot filtering (Gmail/Yahoo proxy non conta come open umano).
 * 🚨 DEFENSIVE: insert fail NON throw (tracking endpoint MUST always respond).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import Database from 'better-sqlite3';

const verifyTrackingTokenMock = vi.fn();
const isTrackingBotMock = vi.fn();
vi.mock('@medea/engine-nodes-stdlib/server', () => ({
  verifyTrackingToken: verifyTrackingTokenMock,
  isTrackingBot: isTrackingBotMock,
}));

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { recordOpen, recordClick, TRANSPARENT_GIF_BYTES } = await import('./email-tracking.service.js');

const validPayload = { w: 'ws-1', l: 'lead-42', c: 'campaign-X', s: 'send-7', i: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
  sqliteInst.exec(`
    CREATE TABLE b2b_interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      send_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  isTrackingBotMock.mockReturnValue(false);
});

describe('🚨 recordOpen', () => {
  it('🚨 happy: token valido + UA umana → insert + ok recorded', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: true, payload: validPayload });
    const r = await recordOpen({
      token: 'valid-token', userAgent: 'Mozilla/5.0', ip: '1.2.3.4', secret: 's',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toBe(true);
    expect(r.bot).toBe(false);

    const row = sqliteInst.prepare('SELECT * FROM b2b_interactions').get() as any;
    expect(row.type).toBe('email_open');
    expect(row.tenant_id).toBe('ws-1');
    expect(row.lead_id).toBe('lead-42');
    const payload = JSON.parse(row.payload_json);
    expect(payload.ua).toBe('Mozilla/5.0');
    // 🚨 GDPR: IP NON raw, ma hashato
    expect(payload.ip_hash).not.toBe('1.2.3.4');
    expect(payload.ip_hash).toMatch(/^[a-f0-9]{16}$/u);
  });

  it('🚨 verify fail (bad-signature) → ok=false + reason propagato', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: false, reason: 'bad-signature' });
    const r = await recordOpen({ token: 'tampered', userAgent: 'M', ip: '1.1.1.1', secret: 's' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad-signature');
    expect(sqliteInst.prepare('SELECT COUNT(*) as n FROM b2b_interactions').get()).toEqual({ n: 0 });
  });

  it('🚨 bot UA → recorded=false MA ok=true (per response GIF)', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: true, payload: validPayload });
    isTrackingBotMock.mockReturnValueOnce(true);
    const r = await recordOpen({ token: 't', userAgent: 'GmailImageProxy', ip: '1.1.1.1', secret: 's' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toBe(false);
    expect(r.bot).toBe(true);
    // No row inserted
    expect(sqliteInst.prepare('SELECT COUNT(*) as n FROM b2b_interactions').get()).toEqual({ n: 0 });
    expect(loggerMock.info).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'open', reason: 'bot-skipped',
    }));
  });

  it('🚨 IP undefined → ip_hash null (no fake hash)', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: true, payload: validPayload });
    await recordOpen({ token: 't', userAgent: 'M', ip: undefined, secret: 's' });
    const row = sqliteInst.prepare('SELECT payload_json FROM b2b_interactions').get() as any;
    expect(JSON.parse(row.payload_json).ip_hash).toBeNull();
  });

  it('🚨 IP hash deterministico (stesso IP → stesso hash)', async () => {
    verifyTrackingTokenMock.mockResolvedValue({ ok: true, payload: validPayload });
    await recordOpen({ token: 't1', userAgent: 'M', ip: '5.5.5.5', secret: 's' });
    await recordOpen({ token: 't2', userAgent: 'M', ip: '5.5.5.5', secret: 's' });
    const rows = sqliteInst.prepare('SELECT payload_json FROM b2b_interactions').all() as any[];
    expect(JSON.parse(rows[0].payload_json).ip_hash).toBe(JSON.parse(rows[1].payload_json).ip_hash);
  });

  it('🚨 insert error → NON throw, log error', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: true, payload: validPayload });
    sqliteInst.exec('DROP TABLE b2b_interactions');
    const r = await recordOpen({ token: 't', userAgent: 'M', ip: '1.1.1.1', secret: 's' });
    // Endpoint MUST never throw — still return ok response shape
    expect(r.ok).toBe(true);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.any(Object), 'INSERT b2b_interactions failed',
    );
  });
});

describe('🚨 recordClick — destination URL validation', () => {
  beforeEach(() => {
    verifyTrackingTokenMock.mockResolvedValue({ ok: true, payload: validPayload });
  });

  it('🚨 happy: http URL → insert + ok', async () => {
    const r = await recordClick({
      token: 't', destinationUrl: 'http://example.com/page', userAgent: 'M', ip: '1.1.1.1', secret: 's',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recorded).toBe(true);
    const row = sqliteInst.prepare('SELECT * FROM b2b_interactions').get() as any;
    expect(JSON.parse(row.payload_json).url).toBe('http://example.com/page');
  });

  it('🚨 happy: https URL → ok', async () => {
    const r = await recordClick({
      token: 't', destinationUrl: 'https://example.com', userAgent: 'M', ip: '1.1.1.1', secret: 's',
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://server.com',
    'gopher://x',
  ])('🚨 SECURITY: blocca schema "%s" (open-redirect to script exec)', async (url) => {
    const r = await recordClick({
      token: 't', destinationUrl: url, userAgent: 'M', ip: '1.1.1.1', secret: 's',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad-destination');
    expect(sqliteInst.prepare('SELECT COUNT(*) as n FROM b2b_interactions').get()).toEqual({ n: 0 });
  });

  it('🚨 URL malformato → bad-destination', async () => {
    const r = await recordClick({
      token: 't', destinationUrl: 'not a url at all', userAgent: 'M', ip: '1.1.1.1', secret: 's',
    });
    expect(r.ok).toBe(false);
  });

  it('🚨 verify fail → reason propagato (no destination check)', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    const r = await recordClick({
      token: 't', destinationUrl: 'https://ok.com', userAgent: 'M', ip: '1.1.1.1', secret: 's',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('expired');
  });

  it('🚨 bot UA → recorded=false MA ok=true (per 302 redirect ancora valido)', async () => {
    isTrackingBotMock.mockReturnValueOnce(true);
    const r = await recordClick({
      token: 't', destinationUrl: 'https://ok.com', userAgent: 'OfficeOutlook-SafeLinks', ip: '1.1', secret: 's',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bot).toBe(true);
    expect(r.recorded).toBe(false);
  });

  it('🚨 payload include i (link index) per multi-link emails', async () => {
    verifyTrackingTokenMock.mockResolvedValueOnce({ ok: true, payload: { ...validPayload, i: 3 } });
    await recordClick({
      token: 't', destinationUrl: 'https://ok.com', userAgent: 'M', ip: '1.1', secret: 's',
    });
    const row = sqliteInst.prepare('SELECT payload_json FROM b2b_interactions').get() as any;
    expect(JSON.parse(row.payload_json).i).toBe(3);
  });
});

describe('🚨 TRANSPARENT_GIF_BYTES — formato RFC-classic 1×1', () => {
  it('🚨 magic "GIF89a"', () => {
    expect(TRANSPARENT_GIF_BYTES.slice(0, 6).toString('ascii')).toBe('GIF89a');
  });

  it('🚨 trailer 0x3b', () => {
    expect(TRANSPARENT_GIF_BYTES[TRANSPARENT_GIF_BYTES.length - 1]).toBe(0x3b);
  });

  it('🚨 ~43 bytes (formato classico)', () => {
    expect(TRANSPARENT_GIF_BYTES.length).toBeGreaterThanOrEqual(40);
    expect(TRANSPARENT_GIF_BYTES.length).toBeLessThanOrEqual(50);
  });
});
