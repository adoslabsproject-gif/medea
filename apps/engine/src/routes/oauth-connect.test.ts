/**
 * oauth-connect route — copertura + caratterizzazione del fix XSS riflesso.
 *
 * Il /callback è raggiunto dal BROWSER senza header auth (lo `state` è
 * l'unico autenticatore). Prima del fix rifletteva `error`, `providerLabel`
 * e `err.message` nell'HTML senza escape → XSS. Questi test bloccano la
 * regressione: i payload non devono comparire grezzi nella response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const svcMock = vi.hoisted(() => ({
  availableProviders: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@/services/oauth-connect.service.js', () => ({
  OAuthConnectService: vi.fn(() => svcMock),
  OAUTH_PROVIDERS: {
    google: { id: 'google', label: 'Google' },
    github: { id: 'github', label: 'GitHub' },
    slack: { id: 'slack', label: 'Slack' },
    notion: { id: 'notion', label: 'Notion' },
  },
}));
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'tenant-1' }));
vi.mock('@/lib/logger.js');

import { createOAuthConnectRoutes } from './oauth-connect.js';
import type { AuthContext } from '@/middleware/auth.js';

const AUTH: AuthContext = { userId: 'u1', tenantId: 'tenant-1', email: 'u1@test.dev', role: 'owner' };

function app(auth: AuthContext | null = null): Hono {
  const a = new Hono();
  if (auth) {
    a.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
  }
  a.route('/', createOAuthConnectRoutes());
  return a;
}

beforeEach(() => {
  svcMock.availableProviders.mockReset();
  svcMock.start.mockReset();
  svcMock.complete.mockReset();
});

describe('GET /providers', () => {
  it('401 senza auth', async () => {
    const res = await app(null).request('/providers');
    expect(res.status).toBe(401);
  });

  it('elenca i provider con flag configured derivato da availableProviders()', async () => {
    svcMock.availableProviders.mockReturnValue([{ id: 'google' }]);
    const res = await app(AUTH).request('/providers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; configured: boolean }[] };
    const google = body.providers.find((p) => p.id === 'google');
    const github = body.providers.find((p) => p.id === 'github');
    expect(google?.configured).toBe(true);
    expect(github?.configured).toBe(false);
  });
});

describe('POST /start', () => {
  it('400 su body invalido (provider fuori enum) — gate zod prima dell\'auth', async () => {
    const res = await app(AUTH).request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'facebook', credentialName: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('401 senza auth pur con body valido', async () => {
    const res = await app(null).request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', credentialName: 'my-cred' }),
    });
    expect(res.status).toBe(401);
  });

  it('ritorna authorizeUrl e costruisce redirect_uri dall\'origin della request', async () => {
    svcMock.start.mockReturnValue({ authorizeUrl: 'https://accounts.google.com/o/oauth2/auth?x=1' });
    const res = await app(AUTH).request('http://host.test/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', credentialName: 'my-cred' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string };
    expect(body.authorizeUrl).toContain('accounts.google.com');
    expect(svcMock.start).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: 'http://host.test/api/v1/oauth-connect/callback' }),
    );
  });
});

describe('GET /callback — anti-XSS riflesso', () => {
  it('400 se mancano code/state', async () => {
    const res = await app().request('/callback');
    expect(res.status).toBe(400);
  });

  it('SECURITY: il parametro `error` riflesso è escapato (no script grezzo)', async () => {
    const res = await app().request('/callback?error=' + encodeURIComponent('<script>alert(1)</script>'));
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('SECURITY: providerLabel malevolo non rompe né markup né <script>', async () => {
    svcMock.complete.mockResolvedValue({ providerLabel: '</script><img src=x onerror=alert(1)>' });
    const res = await app().request('/callback?code=c1&state=s1');
    const html = await res.text();
    // Nessuna chiusura di tag iniettata né tag <img> grezzo.
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('<img src=x');
    // Nel markup è escapato; nel blocco script è un literal JS neutralizzato.
    expect(html).toContain('&lt;/script&gt;&lt;img');
    expect(html).toContain('\\u003c');
  });

  it('SECURITY: err.message riflesso (catch) è escapato', async () => {
    svcMock.complete.mockRejectedValue(new Error('<img src=x onerror=alert(2)>'));
    const res = await app().request('/callback?code=c1&state=s1');
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('mostra la pagina di annullamento quando arriva ?error standard', async () => {
    const res = await app().request('/callback?error=access_denied');
    const html = await res.text();
    expect(html).toContain('OAuth annullato');
    expect(html).toContain('access_denied');
  });
});
