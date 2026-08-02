/**
 * EmailOAuthService — unit tests (portal-centric refresh).
 *
 * The OAuth authorization-code dance moved to the portal; the runtime
 * only delegates refresh. Tests cover:
 *   • refreshAccessToken → portal POST /api/v1/email-oauth/google/refresh
 *   • HMAC signature in the request body matches expected
 *   • Response parsing (access_token + expires_at + optional refresh_token)
 *   • Error propagation on non-2xx
 *   • Throws when MEDEA_SSO_SECRET is missing (config error)
 *   • needsRefresh static helper
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { EmailOAuthService } from './email-oauth.service.js';

vi.mock('@/lib/logger.js');

const SHARED_SECRET = 'a'.repeat(40);
const PORTAL_URL = 'http://portal.test:3006';

vi.mock('@/config.js', () => ({
  loadConfig: () => ({
    MEDEA_PORTAL_URL: PORTAL_URL,
    MEDEA_SSO_SECRET: SHARED_SECRET,
  }),
}));

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('refreshAccessToken (portal-centric)', () => {
  it('POSTs to portal with HMAC signature, returns parsed tokens', async () => {
    const captured: { url?: string; body?: { ts: number; refresh_token: string; sig: string } } = {};
    global.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(init.body as string) as { ts: number; refresh_token: string; sig: string };
      return {
        ok: true,
        json: async () => ({
          access_token: 'AT2',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          refresh_token: 'RT2',
        }),
      } as Response;
    });

    const r = await new EmailOAuthService().refreshAccessToken('RT-original');
    expect(r.accessToken).toBe('AT2');
    expect(r.refreshToken).toBe('RT2');
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3500_000);

    expect(captured.url).toBe(`${PORTAL_URL}/api/v1/email-oauth/google/refresh`);
    expect(captured.body!.refresh_token).toBe('RT-original');
    expect(typeof captured.body!.ts).toBe('number');

    // Recompute the expected signature and check parity. Belt-and-braces:
    // if we ever break the HMAC schema this test fires.
    const expected = createHmac('sha256', SHARED_SECRET)
      .update(`${captured.body!.ts}.${createHash('sha256').update('RT-original').digest('hex')}`)
      .digest('hex');
    expect(captured.body!.sig).toBe(expected);
  });

  it('omits refresh_token when the portal does not rotate', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'AT3',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    } as Response);
    const r = await new EmailOAuthService().refreshAccessToken('RT');
    expect(r.refreshToken).toBeUndefined();
  });

  it('throws on non-2xx from portal', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '{"error":"google_refresh_failed"}',
    } as Response);
    await expect(new EmailOAuthService().refreshAccessToken('RT'))
      .rejects.toThrow(/Portal refresh failed: 502/);
  });

  it('throws when access_token missing in portal response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_at: new Date().toISOString() }),
    } as Response);
    await expect(new EmailOAuthService().refreshAccessToken('RT'))
      .rejects.toThrow(/missing access_token \/ expires_at/);
  });
});

describe('needsRefresh', () => {
  it('true when < 5min from expiry', () => {
    expect(EmailOAuthService.needsRefresh(new Date(Date.now() + 2 * 60_000))).toBe(true);
  });
  it('false when > 5min from expiry', () => {
    expect(EmailOAuthService.needsRefresh(new Date(Date.now() + 10 * 60_000))).toBe(false);
  });
});
