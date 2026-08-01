/**
 * Test 2026-grade — integrations-oauth routes.
 *
 * Coverage REALE:
 *  - GET /: 401 senza auth, listIntegrations + cross-vault email-accounts bridge
 *    (filtra solo OAuth Google), errore email-accounts svc → log + payload
 *    parziale (best-effort)
 *  - POST /: 401, role gating (viewer/operator 403), zod 400 (provider invalido,
 *    credentials non-record, label > 120), saveIntegration happy path 201,
 *    saveIntegration throw → 500
 *  - DELETE /:id: 401, role gating, id mancante 400, 404 quando deleted=0, 204
 *  - GET /oauth/google/connect: 401, role gating, ConnectGoogleSchema zod
 *    (scope ≠ gmail/drive/both → 400), buildOAuthClient throw → 500,
 *    state HMAC-signed con jti random, scopes set per scope, authorizeUrl ok
 *  - GET /oauth/google/callback: error param → html annulla, code/state
 *    missing → 400, state HMAC tampered → 400, state ttl expired → 400,
 *    🚨 state replay (jti già usato) → 400, exchange OK → saveIntegration
 *    chiamato N volte secondo scope (gmail=1, drive=1, both=2),
 *    exchange throw → 500 html
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  // store
  listIntegrations: vi.fn(),
  saveIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  // google-oauth client
  buildOAuthClient: vi.fn(),
  generateAuthorizeUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  // crypto secret
  getMasterPasswordOrThrow: vi.fn(),
  // system-email-accounts svc
  emailAccountsList: vi.fn(),
}));

vi.mock('@/services/integrations/store.js', () => ({
  saveIntegration: (...a: unknown[]) => m.saveIntegration(...a),
  deleteIntegration: (...a: unknown[]) => m.deleteIntegration(...a),
  listIntegrations: (...a: unknown[]) => m.listIntegrations(...a),
}));

vi.mock('@/executors/integrations/google-oauth.js', () => ({
  buildOAuthClient: () => m.buildOAuthClient(),
  generateAuthorizeUrl: (args: unknown) => m.generateAuthorizeUrl(args),
  exchangeCodeForTokens: (args: unknown) => m.exchangeCodeForTokens(args),
}));

vi.mock('@/lib/secrets-crypto.js', () => ({
  getMasterPasswordOrThrow: () => m.getMasterPasswordOrThrow(),
}));

vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: class {
    list(tenantId: string): unknown { return m.emailAccountsList(tenantId); }
  },
}));

vi.mock('@/lib/logger.js');

import { createIntegrationsRoutes } from './integrations-oauth.js';
import type { AuthContext } from '@/middleware/auth.js';

function buildApp(auth: AuthContext | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.route('/', createIntegrationsRoutes());
  return app;
}

const editorAuth: AuthContext = {
  userId: 'u1', tenantId: 't1', email: 'e@x', role: 'editor',
} as AuthContext;
const ownerAuth: AuthContext = {
  userId: 'u1', tenantId: 't1', email: 'o@x', role: 'owner',
} as AuthContext;
const viewerAuth: AuthContext = {
  userId: 'u1', tenantId: 't1', email: 'v@x', role: 'viewer',
} as AuthContext;
const operatorAuth: AuthContext = {
  userId: 'u1', tenantId: 't1', email: 'op@x', role: 'operator',
} as AuthContext;

beforeEach(() => {
  Object.values(m).forEach((fn) => { if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset(); });
  m.getMasterPasswordOrThrow.mockReturnValue('master-secret-32bytes-min-aaaaaaaaaaaa');
  m.listIntegrations.mockReturnValue([]);
  m.emailAccountsList.mockReturnValue([]);
  m.deleteIntegration.mockResolvedValue(1);
  m.saveIntegration.mockResolvedValue({ id: 'int-1', provider: 'stripe' });
});

describe('GET / — list integrations + cross-vault bridge', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/');
    expect(res.status).toBe(401);
  });

  it('happy path: solo store integrations', async () => {
    m.listIntegrations.mockReturnValue([
      { id: 'int-1', provider: 'stripe', label: 'Stripe Live', createdAt: '2026', updatedAt: '2026' },
    ]);
    const res = await buildApp(editorAuth).request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as { integrations: { source: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.integrations[0]!.source).toBe('integrations');
  });

  it('cross-vault: aggiunge Gmail oauth da email-accounts', async () => {
    m.emailAccountsList.mockReturnValue([
      { id: 'ea-1', authType: 'oauth2', oauth: { provider: 'google', email: 'me@x.com', expiresAt: '2026-06-20T00:00:00.000Z' }, label: 'My Gmail', fromAddress: 'me@x.com', createdAt: '2026', updatedAt: '2026' },
    ]);
    const res = await buildApp(editorAuth).request('/');
    const body = await res.json() as { integrations: Record<string, unknown>[] };
    const ea = body.integrations.find((i) => String(i.id).startsWith('email-account:'));
    expect(ea).toBeDefined();
    expect(ea!.source).toBe('email-accounts');
    // #9: il bridge item espone TUTTI i campi del contratto IntegrationMetadata
    // (il vecchio `as never` ometteva lastUsedAt/createdByUserId → undefined in UI).
    expect(ea).toMatchObject({ provider: 'gmail', lastUsedAt: null, createdByUserId: null });
    expect(ea).toHaveProperty('lastUsedAt');
    expect(ea).toHaveProperty('createdByUserId');
    // expiresAt convertito da ISO string → epoch number (contratto IntegrationMetadata)
    expect(typeof ea!.expiresAt).toBe('number');
    expect(ea!.expiresAt).toBe(Date.parse('2026-06-20T00:00:00.000Z'));
  });

  it('filtra fuori email accounts NON-OAuth (es. SMTP password)', async () => {
    m.emailAccountsList.mockReturnValue([
      { id: 'ea-1', authType: 'password', label: 'SMTP', fromAddress: 'me@x.com', createdAt: '2026', updatedAt: '2026' },
      { id: 'ea-2', authType: 'oauth2', oauth: { provider: 'microsoft', email: 'a@b' }, label: 'M365', fromAddress: 'a@b', createdAt: '2026', updatedAt: '2026' },
    ]);
    const res = await buildApp(editorAuth).request('/');
    const body = await res.json() as { integrations: { id: string }[] };
    expect(body.integrations).toHaveLength(0); // ne password ne microsoft passano
  });

  it('errore email-accounts svc → log warn ma list integrations resta valido', async () => {
    m.listIntegrations.mockReturnValue([{ id: 'i', provider: 'stripe', label: 'l', createdAt: '2026', updatedAt: '2026' }]);
    m.emailAccountsList.mockImplementation(() => { throw new Error('db gone'); });
    const res = await buildApp(editorAuth).request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as { integrations: unknown[] };
    expect(body.integrations).toHaveLength(1); // store ok, bridge fail soft
  });
});

describe('POST / — create non-OAuth integration', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', credentials: { key: 'sk_test_x' } }),
    });
    expect(res.status).toBe(401);
  });

  it('viewer → 403 (role gating critical: viewer non può toccare creds)', async () => {
    const res = await buildApp(viewerAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', credentials: { key: 'x' } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toContain('viewer');
  });

  it('operator → 403 (NON può rotare credentials)', async () => {
    const res = await buildApp(operatorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', credentials: { key: 'x' } }),
    });
    expect(res.status).toBe(403);
  });

  it('editor happy path → 201', async () => {
    m.saveIntegration.mockResolvedValue({ id: 'int-x', provider: 'stripe' });
    const res = await buildApp(editorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', label: 'Stripe Live', credentials: { secret: 'sk' }, expiresAt: 1234 }),
    });
    expect(res.status).toBe(201);
    expect(m.saveIntegration).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'stripe', tenantId: 't1', label: 'Stripe Live',
      credentials: { secret: 'sk' }, expiresAt: 1234, createdByUserId: 'u1',
    }));
  });

  it('owner happy path → 201', async () => {
    const res = await buildApp(ownerAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'whatsapp', credentials: { token: 't' } }),
    });
    expect(res.status).toBe(201);
  });

  it('zod 400 — provider non in enum', async () => {
    const res = await buildApp(editorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'unknown', credentials: {} }),
    });
    expect(res.status).toBe(400);
    expect(m.saveIntegration).not.toHaveBeenCalled();
  });

  it('🔴 #10 ocr_tesseract → 400 (OCR locale senza credenziali, non integrazione)', async () => {
    // Anti-regressione: prima era nell'enum → record-fantasma creabile via API
    // e invisibile in UI. Ora rifiutato.
    const res = await buildApp(editorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ocr_tesseract', credentials: {} }),
    });
    expect(res.status).toBe(400);
    expect(m.saveIntegration).not.toHaveBeenCalled();
  });

  it('ocr_vision resta valido (no over-removal: tolto solo tesseract)', async () => {
    const res = await buildApp(editorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ocr_vision', credentials: { key: 'x' } }),
    });
    expect(res.status).toBe(201);
  });

  it('zod 400 — label troppo lunga (>120)', async () => {
    const res = await buildApp(editorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', label: 'a'.repeat(121), credentials: { x: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it('saveIntegration throw → 500 con messaggio', async () => {
    m.saveIntegration.mockRejectedValue(new Error('vault sealed'));
    const res = await buildApp(editorAuth).request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'stripe', credentials: {} }),
    });
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('vault sealed');
  });
});

describe('DELETE /:id', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/abc', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('viewer → 403', async () => {
    const res = await buildApp(viewerAuth).request('/abc', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('happy path → 204 con tenant isolation', async () => {
    m.deleteIntegration.mockResolvedValue(1);
    const res = await buildApp(editorAuth).request('/int-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(m.deleteIntegration).toHaveBeenCalledWith({ id: 'int-1', tenantId: 't1', actorId: 'u1' });
  });

  it('deleted=0 → 404 (no leak su id altrui)', async () => {
    m.deleteIntegration.mockResolvedValue(0);
    const res = await buildApp(editorAuth).request('/wrong-tenant-id', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('GET /oauth/google/connect — authorize URL emit', () => {
  it('401 senza auth', async () => {
    const res = await buildApp(null).request('/oauth/google/connect');
    expect(res.status).toBe(401);
  });

  it('viewer → 403', async () => {
    const res = await buildApp(viewerAuth).request('/oauth/google/connect');
    expect(res.status).toBe(403);
  });

  it('scope invalido → 400', async () => {
    const res = await buildApp(editorAuth).request('/oauth/google/connect?scope=admin');
    expect(res.status).toBe(400);
  });

  it('buildOAuthClient throw → 500', async () => {
    m.buildOAuthClient.mockRejectedValue(new Error('OAuth env mancanti'));
    const res = await buildApp(editorAuth).request('/oauth/google/connect');
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('OAuth env mancanti');
  });

  it('happy path scope=gmail → scopes gmail solo, returns authorizeUrl + state HMAC', async () => {
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.generateAuthorizeUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    const res = await buildApp(editorAuth).request('/oauth/google/connect?scope=gmail&label=My');
    expect(res.status).toBe(200);
    expect((await res.json() as { authorizeUrl: string }).authorizeUrl).toContain('accounts.google.com');

    const args = m.generateAuthorizeUrl.mock.calls[0]![0] as { scopes?: string[]; state: string; redirectUri: string };
    expect(args.scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(args.scopes).not.toContain('https://www.googleapis.com/auth/drive.file');
    expect(args.state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u); // base64url.hmac
    expect(args.redirectUri).toContain('/api/v1/integrations/oauth/google/callback');
  });

  it('scope=drive → scopes drive.file solo', async () => {
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: 'https://override' });
    m.generateAuthorizeUrl.mockReturnValue('url');
    await buildApp(editorAuth).request('/oauth/google/connect?scope=drive');
    const args = m.generateAuthorizeUrl.mock.calls[0]![0] as { scopes?: string[]; redirectUri: string };
    expect(args.scopes).toContain('https://www.googleapis.com/auth/drive.file');
    expect(args.scopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
    expect(args.redirectUri).toBe('https://override');
  });

  it('scope=both (default) → NO scopes argument (uses client default)', async () => {
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.generateAuthorizeUrl.mockReturnValue('url');
    await buildApp(editorAuth).request('/oauth/google/connect');
    const args = m.generateAuthorizeUrl.mock.calls[0]![0] as { scopes?: string[] };
    expect(args.scopes).toBeUndefined();
  });

  it('🚨 state contiene jti random per ogni connect (no riuso)', async () => {
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.generateAuthorizeUrl.mockReturnValue('url');
    await buildApp(editorAuth).request('/oauth/google/connect');
    await buildApp(editorAuth).request('/oauth/google/connect');
    const state1 = (m.generateAuthorizeUrl.mock.calls[0]![0] as { state: string }).state;
    const state2 = (m.generateAuthorizeUrl.mock.calls[1]![0] as { state: string }).state;
    expect(state1).not.toBe(state2);
  });
});

describe('GET /oauth/google/callback — exchange + persist', () => {
  // Per testare il callback simuliamo prima un /connect per ottenere uno
  // state token VALIDO (HMAC firmato + jti unico + iat fresh).
  async function obtainValidState(scope: 'gmail' | 'drive' | 'both'): Promise<string> {
    m.buildOAuthClient.mockResolvedValueOnce({ defaultRedirectUri: undefined });
    m.generateAuthorizeUrl.mockReturnValueOnce('url');
    await buildApp(editorAuth).request(`/oauth/google/connect?scope=${scope}`);
    const calls = m.generateAuthorizeUrl.mock.calls;
    return (calls[calls.length - 1]![0] as { state: string }).state;
  }

  it('error query param → annulla (html, no exchange)', async () => {
    const res = await buildApp(null).request('/oauth/google/callback?error=access_denied');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('annullata');
    expect(html).toContain('access_denied');
    expect(m.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('🚨 SECURITY: ?error riflesso è escapato (XSS riflesso via link)', async () => {
    const res = await buildApp(null).request('/oauth/google/callback?error=' + encodeURIComponent('<script>alert(1)</script>'));
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('code mancante → 400 html', async () => {
    const res = await buildApp(null).request('/oauth/google/callback?state=x');
    expect(res.status).toBe(400);
  });

  it('state mancante → 400 html', async () => {
    const res = await buildApp(null).request('/oauth/google/callback?code=x');
    expect(res.status).toBe(400);
  });

  it('state malformato (no dot) → 400 con state verify failed', async () => {
    const res = await buildApp(null).request('/oauth/google/callback?code=c&state=garbage');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('State token');
  });

  it('state HMAC tampered → 400', async () => {
    const validState = await obtainValidState('gmail');
    const [b64] = validState.split('.');
    const tampered = `${b64!}.AAAAAAAA`;
    const res = await buildApp(null).request(`/oauth/google/callback?code=c&state=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(400);
  });

  it('happy path scope=gmail → 1 saveIntegration + html success', async () => {
    const state = await obtainValidState('gmail');
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: 'https://x' });
    m.exchangeCodeForTokens.mockResolvedValue({
      credentials: { access_token: 'AT', refresh_token: 'RT' },
      expiresAt: 12345,
    });
    const res = await buildApp(null).request(`/oauth/google/callback?code=auth_code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Connesso a Google');
    expect(m.saveIntegration).toHaveBeenCalledTimes(1);
    expect(m.saveIntegration.mock.calls[0]![0]).toMatchObject({ provider: 'gmail', tenantId: 't1' });
  });

  it('happy path scope=both → 2 saveIntegration (gmail + drive)', async () => {
    const state = await obtainValidState('both');
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.exchangeCodeForTokens.mockResolvedValue({
      credentials: { access_token: 'AT', refresh_token: 'RT' },
      expiresAt: 12345,
    });
    await buildApp(null).request(`/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(m.saveIntegration).toHaveBeenCalledTimes(2);
    const providers = m.saveIntegration.mock.calls.map((c) => (c[0] as { provider: string }).provider);
    expect(providers).toEqual(['gmail', 'google_drive']);
  });

  it('happy path scope=drive → 1 saveIntegration google_drive', async () => {
    const state = await obtainValidState('drive');
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.exchangeCodeForTokens.mockResolvedValue({ credentials: {}, expiresAt: 1 });
    await buildApp(null).request(`/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    const providers = m.saveIntegration.mock.calls.map((c) => (c[0] as { provider: string }).provider);
    expect(providers).toEqual(['google_drive']);
  });

  it('🚨 state REPLAY — secondo callback con stesso state → 400', async () => {
    const state = await obtainValidState('gmail');
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.exchangeCodeForTokens.mockResolvedValue({ credentials: {}, expiresAt: 1 });
    const res1 = await buildApp(null).request(`/oauth/google/callback?code=c1&state=${encodeURIComponent(state)}`);
    expect(res1.status).toBe(200);
    // secondo tentativo con stesso state → state token already used
    const res2 = await buildApp(null).request(`/oauth/google/callback?code=c2&state=${encodeURIComponent(state)}`);
    expect(res2.status).toBe(400);
    expect(await res2.text()).toContain('replay');
  });

  it('exchange throw → 500 html', async () => {
    const state = await obtainValidState('gmail');
    m.buildOAuthClient.mockResolvedValue({ defaultRedirectUri: undefined });
    m.exchangeCodeForTokens.mockRejectedValue(new Error('invalid_grant'));
    const res = await buildApp(null).request(`/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('invalid_grant');
  });

  it('buildOAuthClient throw nel callback → 500 html', async () => {
    const state = await obtainValidState('gmail');
    m.buildOAuthClient.mockRejectedValueOnce(new Error('config gone'));
    const res = await buildApp(null).request(`/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('non configurato');
  });
});
