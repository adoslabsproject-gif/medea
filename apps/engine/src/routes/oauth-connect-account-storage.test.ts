/**
 * Bug-bounty FULL-REQUEST-PATH — routes/{oauth-connect,account-storage}.ts
 * (audit coverage 2026-06-12: entrambe a ZERO).
 *
 * oauth-connect: il vero scambio token richiede un provider configurato, ma
 * gate auth, validazione enum provider, errore "non configurato", e gli
 * error-path del callback (browser-facing, autenticato dal solo `state`) sono
 * tutti deterministici e coperti qui. La tabella oauth_connect_state è reale.
 *
 * account-storage: GET singolo che calcola l'uso disco (fail-soft). Si pinna
 * il CONTRATTO della response (plan/total/workflowData/log/binary) + il clamp
 * di usedPercent a [0,100] — la UI Settings ci disegna la barra.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { createOAuthConnectRoutes } from './oauth-connect.js';
import { registerAccountStorageRoute } from './account-storage.js';
import type { AuthContext } from '@/middleware/auth.js';

let authCtx: AuthContext | null = null;
const asUser = (): void => {
  authCtx = { userId: 'u', tenantId: 'test-oauth-a', email: 'o@t.it', role: 'owner' };
};

let app: Hono;

beforeAll(() => {
  runMigrations();
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authCtx);
    await next();
  });
  app.route('/api/v1/oauth-connect', createOAuthConnectRoutes());
  registerAccountStorageRoute(app);
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );

describe('oauth-connect — gate, validazione, error-path', () => {
  it('senza auth → 401 su /providers e /start', async () => {
    authCtx = null;
    expect((await req('GET', '/api/v1/oauth-connect/providers')).status).toBe(401);
    expect(
      (
        await req('POST', '/api/v1/oauth-connect/start', {
          provider: 'google',
          credentialName: 'x',
        })
      ).status,
    ).toBe(401);
  });

  it('GET /providers → lista i 4 provider noti con flag configured booleano', async () => {
    asUser();
    const res = await req('GET', '/api/v1/oauth-connect/providers');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      providers: { id: string; label: string; configured: boolean }[];
    };
    const ids = data.providers.map((p) => p.id).sort();
    expect(ids).toEqual(['github', 'google', 'notion', 'slack']);
    expect(data.providers.every((p) => typeof p.configured === 'boolean')).toBe(true);
  });

  it('POST /start: provider FUORI enum → 400 (zValidator); credentialName vuoto → 400', async () => {
    asUser();
    expect(
      (
        await req('POST', '/api/v1/oauth-connect/start', {
          provider: 'facebook',
          credentialName: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (await req('POST', '/api/v1/oauth-connect/start', { provider: 'google', credentialName: '' }))
        .status,
    ).toBe(400);
  });

  it('POST /start con provider valido ma NON configurato (no client_id env) → 400 con messaggio chiaro', async () => {
    asUser();
    const res = await req('POST', '/api/v1/oauth-connect/start', {
      provider: 'google',
      credentialName: 'la-mia-cred',
    });
    // In test l'env OAuth non è settato → service.start lancia "non configurato".
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/non configurato|sconosciuto/i);
  });

  it('GET /callback?error=access_denied → HTML "annullato" (200, browser-facing)', async () => {
    authCtx = null; // il callback NON richiede auth (lo autentica lo state)
    const res = await req('GET', '/api/v1/oauth-connect/callback?error=access_denied');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/annullato/i);
  });

  it('GET /callback senza code/state → 400; con state INVENTATO → 500 (complete lancia su state ignoto)', async () => {
    authCtx = null;
    expect((await req('GET', '/api/v1/oauth-connect/callback')).status).toBe(400);
    const bad = await req('GET', '/api/v1/oauth-connect/callback?code=abc&state=non-esiste');
    expect(bad.status).toBe(500);
    expect(await bad.text()).toMatch(/fallita/i);
  });
});

describe('account-storage — contratto della dashboard', () => {
  it('GET → shape completa + usedPercent clampato in [0,100]', async () => {
    asUser();
    const res = await req('GET', '/api/v1/account/storage');
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      plan: { code: string; freeTier: boolean };
      total: { bytes: number };
      workflowData: { quotaBytes: number; usedBytes: number; usedPercent: number };
      log: { quotaBytes: number; usedBytes: number; usedPercent: number };
      binary: { usedBytes: number };
    };
    expect(typeof d.plan.code).toBe('string');
    expect(typeof d.plan.freeTier).toBe('boolean');
    expect(d.total.bytes).toBeGreaterThanOrEqual(0);
    for (const section of [d.workflowData, d.log]) {
      expect(section.usedBytes).toBeGreaterThanOrEqual(0);
      expect(section.usedPercent).toBeGreaterThanOrEqual(0);
      expect(section.usedPercent).toBeLessThanOrEqual(100); // clamp anti-barra-sballata
    }
    expect(d.binary.usedBytes).toBeGreaterThanOrEqual(0);
  });
});
