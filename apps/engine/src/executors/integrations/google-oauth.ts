/**
 * Google OAuth 2.0 helpers — shared by Gmail + Google Drive integrations.
 *
 * Architectural decision: rather than pulling the full `googleapis` SDK (~14MB,
 * adds another transitive crash surface), we wrap Google's documented OAuth +
 * REST endpoints with native `fetch`. Same approach Stripe takes for its
 * webhook receiver — explicit, debuggable, and bundle-safe.
 *
 * Public API
 * ----------
 *   • buildOAuthClient()                          — load env config + factory
 *   • generateAuthorizeUrl()                       — for /connect route
 *   • exchangeCodeForTokens()                      — for /callback route
 *   • ensureFreshGoogleAccessToken()               — used by executors
 *
 * Env vars (server-side, NEVER exposed to the client):
 *   MEDEA_GOOGLE_CLIENT_ID
 *   MEDEA_GOOGLE_CLIENT_SECRET
 *   MEDEA_GOOGLE_REDIRECT_URI (optional — defaults to request origin)
 */

import { IntegrationError } from './common.js';
import { updateIntegrationCredentials } from '@/services/integrations/store.js';
import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Default scope set for FlowForge's "Connect Google" flow. Combines Gmail R/W
 * + Drive R/W + OpenID. Drive integration uses a SUBSET of these (drive.file)
 * but we request both at consent time so a tenant connects ONCE and can use
 * both Gmail + Drive without re-consenting.
 *
 * `drive.file` is the LEAST-PRIVILEGE Drive scope: only files this app
 * created or that the user explicitly picked. The broader `drive` scope is
 * NOT requested by default — admins must opt-in via env.
 */
export const DEFAULT_GOOGLE_SCOPES: string[] = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.file',
];

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  /**
   * Default redirect URI used when the route doesn't override it. May be
   * undefined — in that case the route MUST pass `redirectUri` explicitly
   * (e.g. derived from `c.req.url`).
   */
  defaultRedirectUri: string | undefined;
}

export interface GoogleOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  scope: string;
  tokenType: 'Bearer';
  userEmail: string;
}

export function buildOAuthClient(): Promise<GoogleOAuthClient> {
  const clientId = process.env.MEDEA_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.MEDEA_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return Promise.reject(
      new IntegrationError({
        provider: 'gmail',
        code: 'OAUTH_NOT_CONFIGURED',
        message:
          'Google OAuth is not configured for this FlowForge instance. ' +
          'Set MEDEA_GOOGLE_CLIENT_ID and MEDEA_GOOGLE_CLIENT_SECRET in the runtime env.',
      }),
    );
  }
  return Promise.resolve({
    clientId,
    clientSecret,
    defaultRedirectUri: process.env.MEDEA_GOOGLE_REDIRECT_URI,
  });
}

export function generateAuthorizeUrl(args: {
  client: GoogleOAuthClient;
  redirectUri: string;
  state: string;
  scopes?: string[];
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.client.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: (args.scopes ?? DEFAULT_GOOGLE_SCOPES).join(' '),
    state: args.state,
    // `offline` so we get a refresh_token. `prompt=consent` forces the
    // refresh_token to be re-issued even if the user already approved this
    // app — without it, Google only returns the refresh_token the FIRST time.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (args.loginHint) params.set('login_hint', args.loginHint);
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: 'Bearer';
  id_token?: string;
}

export async function exchangeCodeForTokens(args: {
  client: GoogleOAuthClient;
  code: string;
  redirectUri: string;
}): Promise<{ credentials: GoogleOAuthCredentials; expiresAt: number }> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.client.clientId,
    client_secret: args.client.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await safeOutboundFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = (await readTextTruncated(res, 65_536)).text;
    throw new IntegrationError({
      provider: 'gmail',
      code: 'OAUTH_EXCHANGE_FAILED',
      message: `Google token exchange failed (${res.status.toString()}): ${text.slice(0, 200)}`,
      httpStatus: res.status,
    });
  }
  const tokens = await readJsonCapped<TokenResponse>(res);
  if (!tokens.refresh_token) {
    // Google only returns refresh_token on FIRST consent or with prompt=consent.
    // If we somehow lost it, we won't be able to refresh later → hard fail.
    throw new IntegrationError({
      provider: 'gmail',
      code: 'OAUTH_NO_REFRESH_TOKEN',
      message:
        'Google did not return a refresh_token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and reconnect.',
    });
  }

  // Resolve userinfo for `userEmail` so subsequent send operations can use it
  // as the `From:` header without round-tripping.
  const userInfo = await safeOutboundFetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  let userEmail = '';
  if (userInfo.ok) {
    const ui = await readJsonCapped<{ email?: string }>(userInfo);
    userEmail = ui.email ?? '';
  }

  const expiresAt = Date.now() + tokens.expires_in * 1000;
  const credentials: GoogleOAuthCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
    tokenType: 'Bearer',
    userEmail,
  };
  return { credentials, expiresAt };
}

/**
 * Per-integration mutex preventing two concurrent refresh calls. Without this,
 * two parallel workflow runs against the same integration would each call
 * Google's token endpoint, doubling our rate-limit consumption and risking a
 * race where one save overwrites the other's accessToken.
 */
const refreshLocks = new Map<string, Promise<string>>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5min before expiry

export async function ensureFreshGoogleAccessToken(args: {
  integrationId: string;
  tenantId: string;
  creds: GoogleOAuthCredentials;
  expiresAt: number | null;
  oauth: GoogleOAuthClient;
}): Promise<string> {
  if (args.expiresAt && args.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return args.creds.accessToken;
  }

  const lockKey = `${args.tenantId}::${args.integrationId}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;

  const refreshPromise = (async (): Promise<string> => {
    try {
      const body = new URLSearchParams({
        client_id: args.oauth.clientId,
        client_secret: args.oauth.clientSecret,
        refresh_token: args.creds.refreshToken,
        grant_type: 'refresh_token',
      });
      const res = await safeOutboundFetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) {
        const text = (await readTextTruncated(res, 65_536)).text;
        throw new IntegrationError({
          provider: 'gmail',
          code: 'OAUTH_REFRESH_FAILED',
          message: `Google refresh_token failed (${res.status.toString()}): ${text.slice(0, 200)}. Reconnect Google from Settings.`,
          httpStatus: res.status,
        });
      }
      const tokens = await readJsonCapped<TokenResponse>(res);
      const newCreds: GoogleOAuthCredentials = {
        ...args.creds,
        accessToken: tokens.access_token,
        // Google MAY rotate refresh_tokens — if present in response, store it.
        refreshToken: tokens.refresh_token ?? args.creds.refreshToken,
        scope: tokens.scope || args.creds.scope,
      };
      const newExpiresAt = Date.now() + tokens.expires_in * 1000;

      await updateIntegrationCredentials({
        id: args.integrationId,
        tenantId: args.tenantId,
        credentials: newCreds as unknown as Record<string, unknown>,
        expiresAt: newExpiresAt,
      });
      logger.info(
        { integrationId: args.integrationId, tenantId: args.tenantId },
        'Google access_token refreshed',
      );
      return tokens.access_token;
    } finally {
      refreshLocks.delete(lockKey);
    }
  })();

  refreshLocks.set(lockKey, refreshPromise);
  return refreshPromise;
}
