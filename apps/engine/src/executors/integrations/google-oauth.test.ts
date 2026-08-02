/**
 * Test 2026-grade — google-oauth executor helpers.
 *
 * Public API copertura REALE:
 *  - buildOAuthClient(): env vars assenti → IntegrationError code OAUTH_NOT_CONFIGURED
 *  - generateAuthorizeUrl(): URL/params/scopes/loginHint corretti
 *  - exchangeCodeForTokens(): success path, refresh_token assente → hard fail,
 *    HTTP error → IntegrationError con status, userEmail fetched
 *  - ensureFreshGoogleAccessToken(): not-expired → returns cached, expired →
 *    refresh + persist, refresh failed → IntegrationError, mutex concurrent
 *    refresh (race condition), refresh_token rotation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
const updateIntegrationCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));
vi.mock('@/services/integrations/store.js', () => ({
  updateIntegrationCredentials: updateIntegrationCredentialsMock,
}));
vi.mock('@/lib/logger.js');

import {
  buildOAuthClient,
  generateAuthorizeUrl,
  exchangeCodeForTokens,
  ensureFreshGoogleAccessToken,
  DEFAULT_GOOGLE_SCOPES,
  type GoogleOAuthClient,
  type GoogleOAuthCredentials,
} from './google-oauth.js';
import { IntegrationError } from './common.js';

/** Mock Response REALISTICO (headers + text): il reader cappato legge testo e poi
 *  parsa, come una Response vera — un mock `.json()`-only non basta più. */
function jsonRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: new Headers(),
    json: async (): Promise<unknown> => body,
    text: async (): Promise<string> => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  safeFetchMock.mockReset();
  updateIntegrationCredentialsMock.mockReset();
  delete process.env.MEDEA_GOOGLE_CLIENT_ID;
  delete process.env.MEDEA_GOOGLE_CLIENT_SECRET;
  delete process.env.MEDEA_GOOGLE_REDIRECT_URI;
});

describe('buildOAuthClient — env var validation', () => {
  it('CLIENT_ID + SECRET presenti → ritorna client config', async () => {
    process.env.MEDEA_GOOGLE_CLIENT_ID = 'cid-123';
    process.env.MEDEA_GOOGLE_CLIENT_SECRET = 'sec-456';
    process.env.MEDEA_GOOGLE_REDIRECT_URI = 'https://app.example.com/callback';
    const client = await buildOAuthClient();
    expect(client).toEqual({
      clientId: 'cid-123',
      clientSecret: 'sec-456',
      defaultRedirectUri: 'https://app.example.com/callback',
    });
  });

  it('CLIENT_ID assente → IntegrationError OAUTH_NOT_CONFIGURED', async () => {
    process.env.MEDEA_GOOGLE_CLIENT_SECRET = 'sec-456';
    await expect(buildOAuthClient()).rejects.toThrow(IntegrationError);
    await expect(buildOAuthClient()).rejects.toMatchObject({
      code: 'OAUTH_NOT_CONFIGURED',
      provider: 'gmail',
    });
  });

  it('CLIENT_SECRET assente → IntegrationError', async () => {
    process.env.MEDEA_GOOGLE_CLIENT_ID = 'cid';
    await expect(buildOAuthClient()).rejects.toMatchObject({
      code: 'OAUTH_NOT_CONFIGURED',
    });
  });

  it('REDIRECT_URI optional → defaultRedirectUri undefined', async () => {
    process.env.MEDEA_GOOGLE_CLIENT_ID = 'a';
    process.env.MEDEA_GOOGLE_CLIENT_SECRET = 'b';
    const client = await buildOAuthClient();
    expect(client.defaultRedirectUri).toBeUndefined();
  });
});

describe('generateAuthorizeUrl — URL contruction', () => {
  const client: GoogleOAuthClient = {
    clientId: 'cid-xyz',
    clientSecret: 'sec-xyz',
    defaultRedirectUri: undefined,
  };

  it('URL include tutti i params standard OAuth', () => {
    const url = generateAuthorizeUrl({
      client,
      redirectUri: 'https://app.example.com/cb',
      state: 'state-abc',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('cid-xyz');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('state-abc');
    expect(u.searchParams.get('access_type')).toBe('offline'); // refresh_token
    expect(u.searchParams.get('prompt')).toBe('consent'); // forza refresh_token
    expect(u.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('scope di default = DEFAULT_GOOGLE_SCOPES join space-separated', () => {
    const url = generateAuthorizeUrl({ client, redirectUri: 'cb', state: 's' });
    const scope = new URL(url).searchParams.get('scope');
    expect(scope).toBe(DEFAULT_GOOGLE_SCOPES.join(' '));
    expect(scope).toContain('gmail.send');
    expect(scope).toContain('drive.file');
    expect(scope).not.toContain('drive '); // no broad drive
  });

  it('scopes custom override default', () => {
    const url = generateAuthorizeUrl({
      client, redirectUri: 'cb', state: 's',
      scopes: ['openid', 'email'],
    });
    expect(new URL(url).searchParams.get('scope')).toBe('openid email');
  });

  it('loginHint presente → param login_hint settato', () => {
    const url = generateAuthorizeUrl({
      client, redirectUri: 'cb', state: 's', loginHint: 'user@example.com',
    });
    expect(new URL(url).searchParams.get('login_hint')).toBe('user@example.com');
  });

  it('loginHint assente → param login_hint NON settato', () => {
    const url = generateAuthorizeUrl({ client, redirectUri: 'cb', state: 's' });
    expect(new URL(url).searchParams.has('login_hint')).toBe(false);
  });
});

describe('exchangeCodeForTokens — success path', () => {
  const client: GoogleOAuthClient = {
    clientId: 'cid', clientSecret: 'sec', defaultRedirectUri: undefined,
  };

  it('success: ritorna credentials con userEmail + expiresAt corretto', async () => {
    safeFetchMock
      .mockResolvedValueOnce(jsonRes({
        access_token: 'AT-123',
        refresh_token: 'RT-456',
        expires_in: 3600,
        scope: 'openid email',
        token_type: 'Bearer',
      }))
      .mockResolvedValueOnce(jsonRes({ email: 'alice@example.com' }));

    const before = Date.now();
    const { credentials, expiresAt } = await exchangeCodeForTokens({
      client,
      code: 'auth-code-abc',
      redirectUri: 'https://app.example.com/cb',
    });
    const after = Date.now();

    expect(credentials.accessToken).toBe('AT-123');
    expect(credentials.refreshToken).toBe('RT-456');
    expect(credentials.tokenType).toBe('Bearer');
    expect(credentials.userEmail).toBe('alice@example.com');
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it('token endpoint chiamato con form body corretto', async () => {
    safeFetchMock
      .mockResolvedValueOnce(jsonRes({
        access_token: 'AT', refresh_token: 'RT', expires_in: 60, scope: '', token_type: 'Bearer',
      }))
      .mockResolvedValueOnce(jsonRes({}));

    await exchangeCodeForTokens({ client, code: 'CODE-X', redirectUri: 'http://cb' });
    const firstCall = safeFetchMock.mock.calls[0]!;
    expect(firstCall[0]).toBe('https://oauth2.googleapis.com/token');
    expect((firstCall[1] as { method: string }).method).toBe('POST');
    const body = (firstCall[1] as { body: URLSearchParams }).body;
    expect(body.get('code')).toBe('CODE-X');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('sec');
  });

  it('refresh_token assente nel response → IntegrationError OAUTH_NO_REFRESH_TOKEN', async () => {
    safeFetchMock.mockResolvedValueOnce(jsonRes({
      access_token: 'AT', expires_in: 60, scope: '', token_type: 'Bearer',
      // NO refresh_token
    }));
    await expect(exchangeCodeForTokens({ client, code: 'C', redirectUri: 'cb' }))
      .rejects.toMatchObject({
        code: 'OAUTH_NO_REFRESH_TOKEN',
        provider: 'gmail',
      });
  });

  it('HTTP 400 da token endpoint → IntegrationError con status preservato', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    });
    await expect(exchangeCodeForTokens({ client, code: 'BAD', redirectUri: 'cb' }))
      .rejects.toMatchObject({
        code: 'OAUTH_EXCHANGE_FAILED',
        httpStatus: 400,
      });
  });

  it('userinfo fetch fail → userEmail stringa vuota (graceful)', async () => {
    safeFetchMock
      .mockResolvedValueOnce(jsonRes({
        access_token: 'AT', refresh_token: 'RT', expires_in: 60, scope: '', token_type: 'Bearer',
      }))
      .mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);

    const { credentials } = await exchangeCodeForTokens({ client, code: 'C', redirectUri: 'cb' });
    expect(credentials.userEmail).toBe('');
  });
});

describe('ensureFreshGoogleAccessToken — refresh logic', () => {
  const oauth: GoogleOAuthClient = {
    clientId: 'cid', clientSecret: 'sec', defaultRedirectUri: undefined,
  };
  const baseCreds: GoogleOAuthCredentials = {
    accessToken: 'OLD-AT',
    refreshToken: 'RT-stable',
    scope: 'openid',
    tokenType: 'Bearer',
    userEmail: 'u@example.com',
  };

  it('expiresAt > REFRESH_MARGIN_MS dal now → ritorna accessToken cached, NO fetch', async () => {
    const futureExpiry = Date.now() + 10 * 60 * 1000; // 10min nel futuro
    const token = await ensureFreshGoogleAccessToken({
      integrationId: 'int-1', tenantId: 't-1',
      creds: baseCreds,
      expiresAt: futureExpiry,
      oauth,
    });
    expect(token).toBe('OLD-AT');
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(updateIntegrationCredentialsMock).not.toHaveBeenCalled();
  });

  it('expiresAt scaduto → refresh + persist nuovo access_token', async () => {
    safeFetchMock.mockResolvedValueOnce(jsonRes({
      access_token: 'NEW-AT',
      expires_in: 3600,
      scope: 'openid email',
      token_type: 'Bearer',
    }));
    const expiredAt = Date.now() - 1000;
    const token = await ensureFreshGoogleAccessToken({
      integrationId: 'int-2', tenantId: 't-2',
      creds: baseCreds, expiresAt: expiredAt, oauth,
    });
    expect(token).toBe('NEW-AT');
    expect(updateIntegrationCredentialsMock).toHaveBeenCalledTimes(1);
    const persistArg = updateIntegrationCredentialsMock.mock.calls[0]![0] as { credentials: GoogleOAuthCredentials };
    expect(persistArg.credentials.accessToken).toBe('NEW-AT');
    expect(persistArg.credentials.refreshToken).toBe('RT-stable'); // refresh non rotato
  });

  it('expiresAt nullo → refresh sempre', async () => {
    safeFetchMock.mockResolvedValueOnce(jsonRes({ access_token: 'AT', expires_in: 60, scope: '', token_type: 'Bearer' }));
    await ensureFreshGoogleAccessToken({
      integrationId: 'int-null', tenantId: 't',
      creds: baseCreds, expiresAt: null, oauth,
    });
    expect(safeFetchMock).toHaveBeenCalled();
  });

  it('refresh_token rotato dal server → persist nuovo refresh_token', async () => {
    safeFetchMock.mockResolvedValueOnce(jsonRes({
      access_token: 'NEW-AT',
      refresh_token: 'NEW-RT', // rotated
      expires_in: 3600,
      scope: '',
      token_type: 'Bearer',
    }));
    await ensureFreshGoogleAccessToken({
      integrationId: 'int-rot', tenantId: 't',
      creds: baseCreds, expiresAt: 0, oauth,
    });
    const persistArg = updateIntegrationCredentialsMock.mock.calls[0]![0] as { credentials: GoogleOAuthCredentials };
    expect(persistArg.credentials.refreshToken).toBe('NEW-RT');
  });

  it('refresh HTTP 401 (token revocato) → IntegrationError OAUTH_REFRESH_FAILED', async () => {
    safeFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'invalid_grant',
    });
    await expect(ensureFreshGoogleAccessToken({
      integrationId: 'int-rev', tenantId: 't',
      creds: baseCreds, expiresAt: 0, oauth,
    })).rejects.toMatchObject({
      code: 'OAUTH_REFRESH_FAILED',
      httpStatus: 401,
    });
    expect(updateIntegrationCredentialsMock).not.toHaveBeenCalled();
  });

  it('🚨 concurrent refresh: 2 chiamate parallele → 1 sola fetch (mutex)', async () => {
    let resolveTokenCall: ((res: unknown) => void) | null = null;
    safeFetchMock.mockReturnValueOnce(new Promise((r) => {
      resolveTokenCall = r;
    }));

    // Start 2 refresh parallels — devono condividere lo stesso Promise
    const p1 = ensureFreshGoogleAccessToken({
      integrationId: 'int-mtx', tenantId: 't-mtx',
      creds: baseCreds, expiresAt: 0, oauth,
    });
    const p2 = ensureFreshGoogleAccessToken({
      integrationId: 'int-mtx', tenantId: 't-mtx',
      creds: baseCreds, expiresAt: 0, oauth,
    });

    // Allow microtask flushing — il secondo chiamante deve ricevere il lock esistente
    await new Promise((r) => setImmediate(r));

    expect(safeFetchMock).toHaveBeenCalledTimes(1); // mutex efficacie

    resolveTokenCall!(jsonRes({ access_token: 'AT-shared', expires_in: 60, scope: '', token_type: 'Bearer' }));

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('AT-shared');
    expect(t2).toBe('AT-shared');
    expect(updateIntegrationCredentialsMock).toHaveBeenCalledTimes(1);
  });

  it('refresh per integration DIVERSE (lockKey diverso) → 2 fetch parallele', async () => {
    safeFetchMock.mockResolvedValue(jsonRes({ access_token: 'AT-x', expires_in: 60, scope: '', token_type: 'Bearer' }));
    await Promise.all([
      ensureFreshGoogleAccessToken({ integrationId: 'A', tenantId: 't', creds: baseCreds, expiresAt: 0, oauth }),
      ensureFreshGoogleAccessToken({ integrationId: 'B', tenantId: 't', creds: baseCreds, expiresAt: 0, oauth }),
    ]);
    expect(safeFetchMock).toHaveBeenCalledTimes(2); // lock keys diversi
  });

  it('lock rilasciato dopo successo: refresh successivo → nuovo fetch', async () => {
    safeFetchMock.mockResolvedValue(jsonRes({ access_token: 'AT', expires_in: 60, scope: '', token_type: 'Bearer' }));
    await ensureFreshGoogleAccessToken({ integrationId: 'X', tenantId: 't', creds: baseCreds, expiresAt: 0, oauth });
    await ensureFreshGoogleAccessToken({ integrationId: 'X', tenantId: 't', creds: baseCreds, expiresAt: 0, oauth });
    expect(safeFetchMock).toHaveBeenCalledTimes(2); // primo + secondo dopo lock release
  });

  it('lock rilasciato anche dopo errore (try/finally) → retry possibile', async () => {
    safeFetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async (): Promise<string> => 'err' } as unknown as Response)
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT-retry', expires_in: 60, scope: '', token_type: 'Bearer' }));

    await expect(ensureFreshGoogleAccessToken({
      integrationId: 'Y', tenantId: 't', creds: baseCreds, expiresAt: 0, oauth,
    })).rejects.toThrow();

    // Lock deve essere rilasciato → retry funziona
    const token = await ensureFreshGoogleAccessToken({
      integrationId: 'Y', tenantId: 't', creds: baseCreds, expiresAt: 0, oauth,
    });
    expect(token).toBe('AT-retry');
  });
});
