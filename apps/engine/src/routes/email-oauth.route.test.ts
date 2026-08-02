/**
 * Test 2026-grade — email-oauth.route (Gmail OAuth handoff JWE).
 *
 * Coverage REALE:
 *  - /start: 401 senza auth, 403 viewer/editor/operator, 500 senza slug,
 *    redirect a portal con tutti i query params propagati
 *  - /status: 401 senza auth, forward portal enabled true/false, portal
 *    unreachable → reason='portal_unreachable', portal non-ok → reason='portal HTTP N'
 *  - /import: JWE encrypt/decrypt REAL via jose con HKDF chiave derivata,
 *    handoff valido → upsertOAuthAccount + redirect success qs,
 *    handoff missing → oauthError=missing_handoff,
 *    handoff decrypt fail → oauthError=handoff_invalid,
 *    kind wrong → oauthError=handoff_wrong_kind,
 *    audience mismatch → oauthError=handoff_audience_mismatch,
 *    MEDEA_TENANT_ID assente → oauthError=tenant_id_unset,
 *    fields mancanti → oauthError=handoff_incomplete,
 *    upsert throw → oauthError=import_failed + detail truncato 200char,
 *    🚨 SECURITY: handoff per workspace A NON puo\` essere usato su workspace B
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EncryptJWT } from 'jose';
import { hkdfSync } from 'node:crypto';

const SECRET = 'a'.repeat(64); // > 32 bytes
const EXPECTED_TENANT = 'workspace-A-uuid';

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@/config.js', () => ({
  loadConfig: () => loadConfigMock(),
}));

const upsertAccountMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/system-email-accounts.service.js', () => ({
  SystemEmailAccountsService: class {
    upsertOAuthAccount(args: unknown): unknown {
      return upsertAccountMock(args);
    }
  },
}));

vi.mock('@/lib/logger.js');

import { createEmailOauthRoutes } from './email-oauth.route.js';
import type { AuthContext } from '@/middleware/auth.js';

function deriveKey(secret: string): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from('flowforge-sso-jwe-v1', 'utf8'),
      32,
    ) as ArrayBuffer,
  );
}

async function buildHandoffJwe(
  payload: Record<string, unknown>,
  opts: { audience?: string; issuer?: string; secret?: string } = {},
): Promise<string> {
  const key = deriveKey(opts.secret ?? SECRET);
  return await new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(opts.issuer ?? 'portal.flowforge')
    .setAudience(opts.audience ?? EXPECTED_TENANT)
    .setExpirationTime('5m')
    .setIssuedAt()
    .encrypt(key);
}

/** App con auth pre-iniettata via middleware sintetico. Accetta auth
 *  parziale (di solito basta role+tenantId per il test); espande con i
 *  campi obbligatori AuthContext (userId, email) usando default. */
async function appAuthRequest(
  auth: Partial<AuthContext> | null,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { Hono } = await import('hono');
  const router = new Hono();
  router.use('*', async (c, next) => {
    if (auth) {
      const full: AuthContext = {
        userId: 'u-test',
        email: 'test@x',
        tenantId: 't-default',
        role: 'owner',
        ...auth,
      } as AuthContext;
      c.set('auth', full);
    }
    await next();
  });
  router.route('/', createEmailOauthRoutes());
  return router.request(path, init);
}

beforeEach(() => {
  loadConfigMock.mockReset();
  upsertAccountMock.mockReset();
  loadConfigMock.mockReturnValue({
    MEDEA_SSO_SECRET: SECRET,
    MEDEA_TENANT_ID: EXPECTED_TENANT,
  });
  process.env.MEDEA_SSO_SECRET = SECRET;
  process.env.MEDEA_TENANT_ID = EXPECTED_TENANT;
  process.env.MEDEA_TENANT_SLUG = 'acme';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    }),
  );
});

describe('GET /email-accounts/oauth/google/start — auth gates', () => {
  it('no auth → 401', async () => {
    const res = await appAuthRequest(null, '/email-accounts/oauth/google/start');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('role viewer → 403', async () => {
    const res = await appAuthRequest(
      { role: 'viewer', tenantId: 't1' },
      '/email-accounts/oauth/google/start',
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('owner/superadmin');
  });

  it('role editor → 403', async () => {
    const res = await appAuthRequest(
      { role: 'editor', tenantId: 't1' },
      '/email-accounts/oauth/google/start',
    );
    expect(res.status).toBe(403);
  });

  it('role operator → 403', async () => {
    const res = await appAuthRequest(
      { role: 'operator', tenantId: 't1' },
      '/email-accounts/oauth/google/start',
    );
    expect(res.status).toBe(403);
  });

  it('MEDEA_TENANT_SLUG assente E host non match → 500 tenant_slug_unknown', async () => {
    delete process.env.MEDEA_TENANT_SLUG;
    const router = await import('hono').then(({ Hono }) => {
      const a = new Hono();
      a.use('*', async (c, next) => {
        c.set('auth', { userId: 'u', email: 'e@x', role: 'owner', tenantId: 't' } as AuthContext);
        await next();
      });
      a.route('/', createEmailOauthRoutes());
      return a;
    });
    const res = await router.request('/email-accounts/oauth/google/start', {
      headers: { host: 'random-host.example.org' },
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('tenant_slug_unknown');
  });

  it('MEDEA_TENANT_SLUG da env → 302 portal con tenant=<slug>', async () => {
    process.env.MEDEA_TENANT_SLUG = 'acme-corp';
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 'workspace-X' },
      '/email-accounts/oauth/google/start',
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/api/v1/email-oauth/google/start');
    expect(loc).toContain('tenant=acme-corp');
    expect(loc).toContain('workspaceId=workspace-X');
  });

  it('slug derivato da host header se env assente', async () => {
    delete process.env.MEDEA_TENANT_SLUG;
    const router = await import('hono').then(({ Hono }) => {
      const a = new Hono();
      a.use('*', async (c, next) => {
        c.set('auth', { userId: 'u', email: 'e@x', role: 'owner', tenantId: 'w1' } as AuthContext);
        await next();
      });
      a.route('/', createEmailOauthRoutes());
      return a;
    });
    const res = await router.request('/email-accounts/oauth/google/start', {
      headers: { host: 'beta.app.automazionezeli.com' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('tenant=beta');
  });

  it('superadmin role → pass (oltre owner)', async () => {
    const res = await appAuthRequest(
      { role: 'superadmin', tenantId: 't1' },
      '/email-accounts/oauth/google/start',
    );
    expect(res.status).toBe(302);
  });

  it('query params (label/fromAddress/isDefault/accountId) propagati al portal', async () => {
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 'w' },
      '/email-accounts/oauth/google/start?label=Marketing&fromAddress=mark@x.com&isDefault=true&accountId=acc-1',
    );
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('label=Marketing');
    expect(loc).toContain('fromAddress=mark');
    expect(loc).toContain('isDefault=true');
    expect(loc).toContain('accountId=acc-1');
  });

  it('MEDEA_PORTAL_BASE_URL override default', async () => {
    process.env.MEDEA_PORTAL_BASE_URL = 'https://portal-staging.example.com';
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 'w' },
      '/email-accounts/oauth/google/start',
    );
    expect(res.headers.get('location') ?? '').toContain('portal-staging.example.com');
    delete process.env.MEDEA_PORTAL_BASE_URL;
  });
});

describe('GET /email-accounts/oauth/google/status', () => {
  it('no auth → 401', async () => {
    const res = await appAuthRequest(null, '/email-accounts/oauth/google/status');
    expect(res.status).toBe(401);
  });

  it('portal ok + enabled=true → 200 { enabled: true }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: true }),
      }),
    );
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 't' },
      '/email-accounts/oauth/google/status',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it('portal ok + enabled=false → 200 { enabled: false }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ enabled: false }),
      }),
    );
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 't' },
      '/email-accounts/oauth/google/status',
    );
    expect(await res.json()).toEqual({ enabled: false });
  });

  it('portal HTTP 500 → enabled=false reason="portal HTTP 500"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 't' },
      '/email-accounts/oauth/google/status',
    );
    const body = (await res.json()) as { enabled: boolean; reason?: string };
    expect(body.enabled).toBe(false);
    expect(body.reason).toContain('portal HTTP 500');
  });

  it('portal unreachable (fetch throw) → enabled=false reason="portal_unreachable"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await appAuthRequest(
      { role: 'owner', tenantId: 't' },
      '/email-accounts/oauth/google/status',
    );
    expect(await res.json()).toEqual({ enabled: false, reason: 'portal_unreachable' });
  });
});

describe('GET /email-accounts/oauth/google/import — JWE handoff', () => {
  const validPayload = {
    kind: 'email-oauth-handoff',
    email: 'user@example.com',
    accessToken: 'AT-123',
    refreshToken: 'RT-456',
    scope: 'gmail.send openid',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    label: 'My Gmail',
    fromAddress: 'send@example.com',
    isDefault: true,
  };

  it('handoff query param assente → redirect oauthError=missing_handoff', async () => {
    const res = await appAuthRequest(null, '/email-accounts/oauth/google/import');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('oauthError=missing_handoff');
    expect(loc).toContain('tab=email-accounts');
  });

  it('handoff garbage → redirect oauthError=handoff_invalid', async () => {
    const res = await appAuthRequest(null, '/email-accounts/oauth/google/import?handoff=not-a-jwe');
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_invalid');
  });

  it('JWE valido happy path → upsertOAuthAccount + redirect oauthSuccess=1', async () => {
    const accountReturn = { id: 'acc-uuid-1', email: 'user@example.com' };
    upsertAccountMock.mockReturnValue(accountReturn);
    const jwe = await buildHandoffJwe(validPayload);
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('oauthSuccess=1');
    expect(loc).toContain('accountId=acc-uuid-1');
    expect(loc).toContain('email=user');
    expect(upsertAccountMock).toHaveBeenCalledTimes(1);
    const args = upsertAccountMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.tenantId).toBe(EXPECTED_TENANT);
    expect(args.email).toBe('user@example.com');
    expect(args.refreshToken).toBe('RT-456');
    expect(args.accessToken).toBe('AT-123');
    expect(args.label).toBe('My Gmail');
    expect(args.isDefault).toBe(true);
    expect(args.provider).toBe('google');
  });

  it('kind != "email-oauth-handoff" → redirect oauthError=handoff_wrong_kind', async () => {
    const jwe = await buildHandoffJwe({ ...validPayload, kind: 'sso-login' });
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_wrong_kind');
  });

  it('🚨 audience mismatch (workspaceB stealing workspaceA) → oauthError=handoff_audience_mismatch', async () => {
    const jwe = await buildHandoffJwe(validPayload, { audience: 'workspace-B-DIFFERENT' });
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_audience_mismatch');
    expect(upsertAccountMock).not.toHaveBeenCalled();
  });

  it('MEDEA_TENANT_ID assente → oauthError=tenant_id_unset (cannot verify audience)', async () => {
    delete process.env.MEDEA_TENANT_ID;
    loadConfigMock.mockReturnValue({ MEDEA_SSO_SECRET: SECRET });
    const jwe = await buildHandoffJwe(validPayload);
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=tenant_id_unset');
  });

  it('issuer sbagliato → decrypt fail → oauthError=handoff_invalid', async () => {
    const jwe = await buildHandoffJwe(validPayload, { issuer: 'evil-portal' });
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_invalid');
  });

  it('payload incompleto (missing accessToken) → oauthError=handoff_incomplete', async () => {
    const jwe = await buildHandoffJwe({ ...validPayload, accessToken: undefined });
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_incomplete');
  });

  it('payload missing email → oauthError=handoff_incomplete', async () => {
    const jwe = await buildHandoffJwe({ ...validPayload, email: undefined });
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_incomplete');
  });

  it('upsert throw → oauthError=import_failed + detail truncato 200 char', async () => {
    upsertAccountMock.mockImplementation(() => {
      throw new Error('X'.repeat(500));
    });
    const jwe = await buildHandoffJwe(validPayload);
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('oauthError=import_failed');
    expect(loc).toContain('detail=');
    // Detail truncato: deve esserci `X` ma non 500x perche\` cap 200
    const detailMatch = /detail=([^&]+)/u.exec(loc);
    expect(detailMatch).not.toBeNull();
    const decoded = decodeURIComponent(detailMatch![1]!);
    expect(decoded.length).toBeLessThanOrEqual(200);
  });

  it('SSO secret diverso tra portal/runtime → decrypt fail → handoff_invalid', async () => {
    const jwe = await buildHandoffJwe(validPayload, { secret: 'b'.repeat(64) });
    const res = await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    expect(res.headers.get('location') ?? '').toContain('oauthError=handoff_invalid');
  });

  it('existingAccountId presente → propagato a upsert come existingId', async () => {
    upsertAccountMock.mockReturnValue({ id: 'existing-id-1', email: 'user@example.com' });
    const jwe = await buildHandoffJwe({ ...validPayload, existingAccountId: 'existing-id-1' });
    await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    const args = upsertAccountMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.existingId).toBe('existing-id-1');
  });

  it('label assente → label default "Gmail (<email>)"', async () => {
    upsertAccountMock.mockReturnValue({ id: 'a', email: 'user@example.com' });
    const jwe = await buildHandoffJwe({ ...validPayload, label: undefined });
    await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    const args = upsertAccountMock.mock.calls[0]![0] as { label: string };
    expect(args.label).toBe('Gmail (user@example.com)');
  });

  it('fromAddress assente → default = email', async () => {
    upsertAccountMock.mockReturnValue({ id: 'a', email: 'user@example.com' });
    const jwe = await buildHandoffJwe({ ...validPayload, fromAddress: undefined });
    await appAuthRequest(null, `/email-accounts/oauth/google/import?handoff=${jwe}`);
    const args = upsertAccountMock.mock.calls[0]![0] as { fromAddress: string };
    expect(args.fromAddress).toBe('user@example.com');
  });
});
