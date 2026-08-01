/**
 * Gmail OAuth2 helper (portal-centric refresh).
 *
 * Why this file is now thin
 * ─────────────────────────
 * In the SaaS pattern (see {@link ./routes/email-oauth.route.ts}) the
 * OAuth authorization-code dance happens on the PORTAL, not here. A
 * single OAuth client is registered on Google Cloud Console with one
 * central redirect URI; per-tenant context travels through the redirect
 * via a signed handoff. The portal does the code-for-token exchange and
 * delivers the tokens back to the runtime through a JWE.
 *
 * What the RUNTIME still does
 * ───────────────────────────
 *   1. Stores the refresh + access tokens (encrypted at rest).
 *   2. When nodemailer fires off XOAUTH2 and the access token is < 5min
 *      from expiry, asks the portal to refresh it on its behalf.
 *   3. Decides "needs refresh?" with the cheap static helper.
 *
 * Why we delegate the refresh
 * ───────────────────────────
 * Refreshing requires `client_id` + `client_secret`. In a per-tenant
 * runtime we don't carry the secret (the portal does, in env). Sending
 * the refresh_token to the portal over the internal Docker network is
 * acceptable: the same secret is what the portal already used to MINT
 * that token, so we're not widening trust.
 *
 * Auth between runtime and portal: HMAC-SHA256 over
 * `${timestamp}.${refresh_token_sha256}` with the shared
 * `FLOWFORGE_SSO_SECRET`. Timestamp ±60s tolerated, replays bounded by
 * the short window — we explicitly accept the residual replay surface
 * because the only thing replay buys an attacker is "ask for an access
 * token I already proved I had access to."
 *
 * @module services/email-oauth.service
 */

import { createHmac, createHash } from 'node:crypto';
import { logger } from '@/lib/logger.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { loadConfig } from '@/config.js';

export interface OAuthTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: Date;
  scope: string;
  email: string;
}

const REFRESH_LEEWAY_MS = 5 * 60_000;

interface PortalRefreshResponse {
  access_token: string;
  expires_at: string;            // ISO
  refresh_token?: string;        // present iff Google rotated
}

export class EmailOAuthService {
  /**
   * Ask the portal to swap our refresh_token for a fresh access_token.
   *
   * The portal endpoint accepts `{ts, refresh_token, sig}` and returns
   * `{access_token, expires_at, refresh_token?}`. `sig` is the HMAC of
   * `${ts}.${sha256(refresh_token)}` with the shared SSO secret so the
   * portal can validate the call came from a legitimate runtime without
   * needing a per-tenant secret distribution.
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: Date;
    refreshToken?: string;
  }> {
    const cfg = loadConfig();
    const portalUrl = cfg.FLOWFORGE_PORTAL_URL.replace(/\/$/, '');
    const sharedSecret = cfg.FLOWFORGE_SSO_SECRET ?? process.env.FLOWFORGE_SSO_SECRET;
    if (!sharedSecret) {
      throw new Error('FLOWFORGE_SSO_SECRET missing — cannot sign portal refresh call');
    }

    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', sharedSecret)
      .update(`${ts}.${sha256Hex(refreshToken)}`)
      .digest('hex');

    const url = `${portalUrl}/api/v1/email-oauth/google/refresh`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts, refresh_token: refreshToken, sig }),
    });
    if (!res.ok) {
      const text = (await readTextTruncated(res, 65_536)).text;
      logger.error({ status: res.status, body: text.slice(0, 200), url }, 'portal refresh call failed');
      throw new Error(`Portal refresh failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await readJsonCapped<PortalRefreshResponse>(res);
    if (!data.access_token || !data.expires_at) {
      throw new Error('Portal refresh response missing access_token / expires_at');
    }
    const out: { accessToken: string; expiresAt: Date; refreshToken?: string } = {
      accessToken: data.access_token,
      expiresAt: new Date(data.expires_at),
    };
    if (data.refresh_token) out.refreshToken = data.refresh_token;
    return out;
  }

  /**
   * Cheap pure-function check used as a gate before
   * `refreshAccessToken`. Stays static so the hot path
   * (`if (needsRefresh) refresh()`) doesn't pay an allocation.
   */
  static needsRefresh(expiresAt: Date): boolean {
    return expiresAt.getTime() - Date.now() < REFRESH_LEEWAY_MS;
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
