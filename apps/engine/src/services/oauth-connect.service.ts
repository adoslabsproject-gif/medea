/**
 * OAuthConnectService — workflow-credential OAuth2 flow (Authorization
 * Code + PKCE). Distinct from the LOGIN OAuth (that authenticates app
 * users) — this one stores per-user access/refresh tokens that workflow
 * nodes use to call Google/GitHub/Slack/Notion APIs.
 *
 * Providers supported:
 *   • google   — Drive, Gmail, Calendar, Sheets
 *   • github   — Issues, repos
 *   • slack    — Post messages, channels
 *   • notion   — Pages, databases
 *
 * Configuration (env vars, all optional — provider is hidden if missing):
 *   MEDEA_GOOGLE_OAUTH_CLIENT_ID / _SECRET
 *   MEDEA_GITHUB_OAUTH_CLIENT_ID / _SECRET
 *   MEDEA_SLACK_OAUTH_CLIENT_ID / _SECRET
 *   MEDEA_NOTION_OAUTH_CLIENT_ID / _SECRET
 *
 * Token storage: the access token + (optional) refresh token are saved
 * via CredentialsService as a single credential of provider=`oauth:<name>`.
 * The CredentialsService already encrypts at rest with the master key.
 */

import crypto from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { CredentialsService } from './credentials.service.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

interface ProviderSpec {
  id: 'google' | 'github' | 'slack' | 'notion';
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string;
  usesPkce: boolean;
  /** Some providers return tokens in JSON, others in form-urlencoded. */
  tokenResponseType: 'json' | 'urlencoded';
}

export const OAUTH_PROVIDERS: Record<string, ProviderSpec> = {
  google: {
    id: 'google',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes:
      'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send',
    usesPkce: true,
    tokenResponseType: 'json',
  },
  github: {
    id: 'github',
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: 'repo workflow',
    usesPkce: false,
    tokenResponseType: 'json',
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    defaultScopes: 'chat:write channels:read groups:read users:read',
    usesPkce: false,
    tokenResponseType: 'json',
  },
  notion: {
    id: 'notion',
    label: 'Notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    defaultScopes: '',
    usesPkce: false,
    tokenResponseType: 'json',
  },
};

interface PendingState {
  state: string;
  provider: string;
  tenantId: string;
  userId: string;
  credentialName: string;
  redirectUri: string;
  codeVerifier?: string;
  createdAt: string;
}

function ensureStateTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS oauth_connect_state (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      credential_name TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_verifier TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_connect_state_created ON oauth_connect_state(created_at);
  `);
}

export class OAuthConnectService {
  private readonly credentials = new CredentialsService();

  constructor() {
    ensureStateTable();
  }

  /** Discover which providers are CONFIGURED via env vars. */
  availableProviders(): { id: string; label: string }[] {
    return Object.values(OAUTH_PROVIDERS)
      .filter((p) => this.getClientCreds(p.id) !== null)
      .map((p) => ({ id: p.id, label: p.label }));
  }

  /** Build the authorize URL and remember the state for the callback. */
  start(args: {
    provider: string;
    tenantId: string;
    userId: string;
    credentialName: string;
    redirectUri: string;
  }): { authorizeUrl: string } {
    const spec = OAUTH_PROVIDERS[args.provider];
    if (!spec) throw new Error(`Provider OAuth sconosciuto: ${args.provider}`);
    const creds = this.getClientCreds(spec.id);
    if (!creds)
      throw new Error(
        `Provider ${spec.id} non configurato (mancano MEDEA_${spec.id.toUpperCase()}_OAUTH_CLIENT_ID/_SECRET)`,
      );

    const state = crypto.randomBytes(24).toString('base64url');
    const codeVerifier = spec.usesPkce ? crypto.randomBytes(32).toString('base64url') : undefined;
    const codeChallenge = codeVerifier
      ? crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      : undefined;

    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        `
      INSERT INTO oauth_connect_state (state, provider, tenant_id, user_id, credential_name, redirect_uri, code_verifier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        state,
        spec.id,
        args.tenantId,
        args.userId,
        args.credentialName,
        args.redirectUri,
        codeVerifier ?? null,
        new Date().toISOString(),
      );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.clientId,
      redirect_uri: args.redirectUri,
      scope: spec.defaultScopes,
      state,
      access_type: 'offline', // request refresh token where supported
      prompt: 'consent',
    });
    if (codeChallenge) {
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return { authorizeUrl: `${spec.authorizeUrl}?${params.toString()}` };
  }

  /**
   * Exchange the authorization code for an access token and save it as a
   * credential. Returns { credentialId, providerLabel }.
   */
  async complete(
    code: string,
    state: string,
  ): Promise<{ credentialId: string; providerLabel: string }> {
    const { sqlite } = getDatabase();
    // SQLite snake_case row → mappato manualmente. Bug pre-2026-06-07: lettura
    // `row.codeVerifier` invece di `row.code_verifier` rompeva SEMPRE PKCE +
    // mandava `redirect_uri=undefined` al provider (Google rifiutava token).
    interface StateRow {
      state: string;
      provider: string;
      tenant_id: string;
      user_id: string;
      credential_name: string;
      redirect_uri: string;
      code_verifier: string | null;
      created_at: string;
    }
    const raw = sqlite.prepare(`SELECT * FROM oauth_connect_state WHERE state = ?`).get(state) as
      | StateRow
      | undefined;
    if (!raw) throw new Error('State sconosciuto o scaduto');
    sqlite.prepare(`DELETE FROM oauth_connect_state WHERE state = ?`).run(state);

    const row: PendingState = {
      state: raw.state,
      provider: raw.provider,
      tenantId: raw.tenant_id,
      userId: raw.user_id,
      credentialName: raw.credential_name,
      redirectUri: raw.redirect_uri,
      ...(raw.code_verifier !== null ? { codeVerifier: raw.code_verifier } : {}),
      createdAt: raw.created_at,
    };

    const spec = OAUTH_PROVIDERS[row.provider];
    if (!spec) throw new Error(`Provider ${row.provider} non più supportato`);
    const creds = this.getClientCreds(spec.id);
    if (!creds) throw new Error(`Provider ${spec.id} non configurato`);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: row.redirectUri,
    });
    if (row.codeVerifier) body.set('code_verifier', row.codeVerifier);

    const tokenRes = await safeOutboundFetch(spec.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      spanName: 'oauth.token-exchange',
    });
    if (!tokenRes.ok) {
      const text = (await readTextTruncated(tokenRes, 65_536)).text;
      throw new Error(
        `Token exchange fallito (${tokenRes.status.toString()}): ${text.slice(0, 200)}`,
      );
    }
    const tokenData = await readJsonCapped<{
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
      authed_user?: { access_token?: string }; // Slack v2 oddity
    }>(tokenRes);

    // Slack returns the user token under `authed_user.access_token` when
    // the scope was a user-scope. Tolerate both shapes.
    const accessToken = tokenData.access_token ?? tokenData.authed_user?.access_token;
    if (!accessToken) throw new Error('Provider non ha restituito un access_token utile');

    const plaintext = JSON.stringify({
      access_token: accessToken,
      refresh_token: tokenData.refresh_token ?? '',
      token_type: tokenData.token_type ?? 'Bearer',
      scope: tokenData.scope ?? spec.defaultScopes,
      expires_at: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : null,
    });
    const createdInput: Parameters<CredentialsService['create']>[0] = {
      tenantId: row.tenantId,
      name: row.credentialName,
      provider: `oauth:${spec.id}`,
      plaintext,
      actorId: row.userId,
    };
    const created = await this.credentials.create(createdInput);
    return { credentialId: created.id, providerLabel: spec.label };
  }

  private getClientCreds(providerId: string): { clientId: string; clientSecret: string } | null {
    const idEnv = `MEDEA_${providerId.toUpperCase()}_OAUTH_CLIENT_ID`;
    const secretEnv = `MEDEA_${providerId.toUpperCase()}_OAUTH_CLIENT_SECRET`;
    const clientId = process.env[idEnv];
    const clientSecret = process.env[secretEnv];
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }
}
