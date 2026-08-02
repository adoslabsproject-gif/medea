/**
 * Test 2026-grade — OAuthConnectService (PKCE + state CSRF + 4 providers).
 *
 * SECURITY: state random 24 byte (CSRF protection) + PKCE S256 (Google).
 * SECURITY: state one-shot consumption (DELETE post-validation, replay prevented).
 * SECURITY: client_secret env-only (no DB leak).
 * INTEGRATION: Slack v2 authed_user.access_token tolleranza.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { at } from '@/__testkit__/assert.js';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));

const credentialsCreateMock = vi.fn();
class CredentialsServiceMock {
  create = credentialsCreateMock;
}
vi.mock('./credentials.service.js', () => ({
  CredentialsService: CredentialsServiceMock,
}));

const safeFetchMock = vi.fn();
vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));

const { OAuthConnectService, OAUTH_PROVIDERS } = await import('./oauth-connect.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  sqliteInst = new Database(':memory:');
  // Pre-create state table so seedState() in `complete` tests can insert
  // before the service instantiates (which would call ensureStateTable).
  sqliteInst.exec(`
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
  `);
  delete process.env.MEDEA_GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.MEDEA_GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.MEDEA_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.MEDEA_GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.MEDEA_SLACK_OAUTH_CLIENT_ID;
  delete process.env.MEDEA_SLACK_OAUTH_CLIENT_SECRET;
  delete process.env.MEDEA_NOTION_OAUTH_CLIENT_ID;
  delete process.env.MEDEA_NOTION_OAUTH_CLIENT_SECRET;
  credentialsCreateMock.mockResolvedValue({ id: 'cred-123' });
});

describe('🚨 availableProviders — env discovery', () => {
  it('🚨 nessuna env → []', () => {
    expect(new OAuthConnectService().availableProviders()).toEqual([]);
  });

  it('🚨 GOOGLE env set → google in lista', () => {
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_ID = 'g-id';
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_SECRET = 'g-secret';
    const p = new OAuthConnectService().availableProviders();
    expect(p).toEqual([{ id: 'google', label: 'Google' }]);
  });

  it('🚨 client_id senza secret → escluso (entrambi richiesti)', () => {
    process.env.MEDEA_GITHUB_OAUTH_CLIENT_ID = 'gh-id';
    // missing secret
    expect(new OAuthConnectService().availableProviders()).toEqual([]);
  });

  it('🚨 tutti 4 provider env → 4 in lista', () => {
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_ID = 'x';
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_SECRET = 'y';
    process.env.MEDEA_GITHUB_OAUTH_CLIENT_ID = 'x';
    process.env.MEDEA_GITHUB_OAUTH_CLIENT_SECRET = 'y';
    process.env.MEDEA_SLACK_OAUTH_CLIENT_ID = 'x';
    process.env.MEDEA_SLACK_OAUTH_CLIENT_SECRET = 'y';
    process.env.MEDEA_NOTION_OAUTH_CLIENT_ID = 'x';
    process.env.MEDEA_NOTION_OAUTH_CLIENT_SECRET = 'y';
    expect(new OAuthConnectService().availableProviders()).toHaveLength(4);
  });
});

describe('🚨 start — authorize URL + state insert', () => {
  beforeEach(() => {
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_ID = 'g-client-id';
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_SECRET = 'g-client-secret';
  });

  it('🚨 happy: URL contiene tutti i params required + PKCE', () => {
    const r = new OAuthConnectService().start({
      provider: 'google',
      tenantId: 't-1',
      userId: 'u-1',
      credentialName: 'gmail-account',
      redirectUri: 'https://app.example.com/cb',
    });
    expect(r.authorizeUrl).toContain('accounts.google.com');
    expect(r.authorizeUrl).toContain('client_id=g-client-id');
    expect(r.authorizeUrl).toContain('response_type=code');
    expect(r.authorizeUrl).toContain('redirect_uri=https');
    expect(r.authorizeUrl).toContain('access_type=offline');
    expect(r.authorizeUrl).toContain('prompt=consent');
    expect(r.authorizeUrl).toContain('state=');
    // PKCE
    expect(r.authorizeUrl).toContain('code_challenge=');
    expect(r.authorizeUrl).toContain('code_challenge_method=S256');
  });

  it('🚨 state inserito in DB con code_verifier per Google', () => {
    new OAuthConnectService().start({
      provider: 'google', tenantId: 't', userId: 'u', credentialName: 'n', redirectUri: 'r',
    });
    const row = sqliteInst.prepare('SELECT * FROM oauth_connect_state').get() as any;
    expect(row.state).toBeTruthy();
    expect(row.tenant_id).toBe('t');
    expect(row.user_id).toBe('u');
    expect(row.provider).toBe('google');
    expect(row.code_verifier).toBeTruthy(); // PKCE Google
  });

  it('🚨 GitHub: NO PKCE → code_verifier null', () => {
    process.env.MEDEA_GITHUB_OAUTH_CLIENT_ID = 'x';
    process.env.MEDEA_GITHUB_OAUTH_CLIENT_SECRET = 'y';
    new OAuthConnectService().start({
      provider: 'github', tenantId: 't', userId: 'u', credentialName: 'n', redirectUri: 'r',
    });
    const row = sqliteInst.prepare('SELECT * FROM oauth_connect_state').get() as any;
    expect(row.code_verifier).toBeNull();
    // URL non contiene code_challenge
  });

  it('🚨 provider sconosciuto → throw', () => {
    expect(() => new OAuthConnectService().start({
      provider: 'unknown', tenantId: 't', userId: 'u', credentialName: 'n', redirectUri: 'r',
    })).toThrow(/sconosciuto/u);
  });

  it('🚨 provider non configurato (no env) → throw esplicito', () => {
    delete process.env.MEDEA_GOOGLE_OAUTH_CLIENT_ID;
    expect(() => new OAuthConnectService().start({
      provider: 'google', tenantId: 't', userId: 'u', credentialName: 'n', redirectUri: 'r',
    })).toThrow(/non configurato/u);
  });

  it('🚨 state random ad ogni chiamata (no collision)', () => {
    const r1 = new OAuthConnectService().start({
      provider: 'google', tenantId: 't', userId: 'u', credentialName: 'n', redirectUri: 'r',
    });
    const r2 = new OAuthConnectService().start({
      provider: 'google', tenantId: 't', userId: 'u', credentialName: 'n', redirectUri: 'r',
    });
    const s1 = new URL(r1.authorizeUrl).searchParams.get('state');
    const s2 = new URL(r2.authorizeUrl).searchParams.get('state');
    expect(s1).not.toBe(s2);
  });
});

describe('🚨 complete — token exchange + credential persist', () => {
  beforeEach(() => {
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_ID = 'g-cid';
    process.env.MEDEA_GOOGLE_OAUTH_CLIENT_SECRET = 'g-secret';
  });

  function seedState(extra: Partial<any> = {}): string {
    const state = 'test-state-xyz';
    sqliteInst.prepare(`INSERT INTO oauth_connect_state VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      state,
      extra.provider ?? 'google',
      't-1', 'u-1', 'gmail-cred', 'https://app.example.com/cb',
      extra.code_verifier ?? 'verifier-xxx',
      '2026-06-07',
    );
    return state;
  }

  it('🚨 state sconosciuto → throw (CSRF protection)', async () => {
    await expect(new OAuthConnectService().complete('code', 'bogus-state'))
      .rejects.toThrow(/sconosciuto o scaduto/u);
  });

  it('🚨 state usato 2x → 2a chiamata fallisce (replay prevented)', async () => {
    const state = seedState();
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok' }),
    });
    await new OAuthConnectService().complete('code1', state);
    await expect(new OAuthConnectService().complete('code1', state))
      .rejects.toThrow(/sconosciuto o scaduto/u);
  });

  it('🚨 happy: token exchange + credential.create called', async () => {
    const state = seedState();
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'gho_acc',
        refresh_token: 'gho_ref',
        token_type: 'Bearer',
        scope: 'drive gmail',
        expires_in: 3600,
      }),
    });
    const r = await new OAuthConnectService().complete('auth-code-xxx', state);
    expect(r).toEqual({ credentialId: 'cred-123', providerLabel: 'Google' });
    expect(credentialsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't-1',
      name: 'gmail-cred',
      provider: 'oauth:google',
      actorId: 'u-1',
    }));
    const plaintext = JSON.parse(at(credentialsCreateMock.mock.calls, 0, 'create-calls')[0].plaintext);
    expect(plaintext.access_token).toBe('gho_acc');
    expect(plaintext.refresh_token).toBe('gho_ref');
    expect(plaintext.expires_at).toBeTruthy();
  });

  it('🚨 PKCE: code_verifier propagato nel body', async () => {
    const state = seedState({ code_verifier: 'pkce-secret-xyz' });
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok' }),
    });
    await new OAuthConnectService().complete('code', state);
    const body = at(safeFetchMock.mock.calls, 0, 'fetch-calls')[1].body as string;
    expect(body).toContain('code_verifier=pkce-secret-xyz');
  });

  it('🚨 token endpoint 401 → throw con preview body', async () => {
    const state = seedState();
    safeFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid_client'),
    });
    await expect(new OAuthConnectService().complete('code', state))
      .rejects.toThrow(/Token exchange fallito \(401\).*invalid_client/u);
  });

  it('🚨 access_token mancante in response → throw', async () => {
    const state = seedState();
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: 'temp' }),
    });
    await expect(new OAuthConnectService().complete('code', state))
      .rejects.toThrow(/access_token utile/u);
  });

  it('🚨 Slack v2 authed_user.access_token (oddity) → estratto', async () => {
    process.env.MEDEA_SLACK_OAUTH_CLIENT_ID = 's';
    process.env.MEDEA_SLACK_OAUTH_CLIENT_SECRET = 's';
    const state = seedState({ provider: 'slack', code_verifier: null });
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        authed_user: { access_token: 'xoxp-user-scoped-token' },
      }),
    });
    await new OAuthConnectService().complete('code', state);
    const plaintext = JSON.parse(at(credentialsCreateMock.mock.calls, 0, 'create-calls')[0].plaintext);
    expect(plaintext.access_token).toBe('xoxp-user-scoped-token');
  });

  it('🚨 no expires_in → expires_at null', async () => {
    const state = seedState();
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok' }),
    });
    await new OAuthConnectService().complete('code', state);
    const plaintext = JSON.parse(at(credentialsCreateMock.mock.calls, 0, 'create-calls')[0].plaintext);
    expect(plaintext.expires_at).toBeNull();
  });

  it('🚨 default scope fallback se non in response', async () => {
    const state = seedState();
    safeFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok' }),
    });
    await new OAuthConnectService().complete('code', state);
    const plaintext = JSON.parse(at(credentialsCreateMock.mock.calls, 0, 'create-calls')[0].plaintext);
    expect(plaintext.scope).toBe(OAUTH_PROVIDERS.google!.defaultScopes);
  });
});

describe('🚨 OAUTH_PROVIDERS spec coherence', () => {
  it('🚨 4 provider definiti', () => {
    expect(Object.keys(OAUTH_PROVIDERS).sort()).toEqual(['github', 'google', 'notion', 'slack']);
  });

  it('🚨 google ha PKCE (Apple-grade security)', () => {
    expect(OAUTH_PROVIDERS.google!.usesPkce).toBe(true);
  });

  it.each(['github', 'slack', 'notion'])('🚨 %s no PKCE (provider non lo richiede)', (id) => {
    expect(OAUTH_PROVIDERS[id]!.usesPkce).toBe(false);
  });

  it('🚨 ogni provider ha authorizeUrl + tokenUrl HTTPS', () => {
    for (const p of Object.values(OAUTH_PROVIDERS)) {
      expect(p.authorizeUrl).toMatch(/^https:\/\//u);
      expect(p.tokenUrl).toMatch(/^https:\/\//u);
    }
  });
});
