/**
 * OAuth2 / OIDC routes.
 * Supports Google, Microsoft Entra ID, GitHub, Auth0, Okta and any
 * RFC-compliant OIDC issuer via per-tenant configuration.
 *
 * Flow:
 *   GET  /api/v1/auth/oauth/:provider/start   → redirects to upstream authorize
 *   GET  /api/v1/auth/oauth/:provider/callback ← upstream returns here with code
 *                                                 → exchanges code → upserts user
 *                                                 → issues FlowForge session JWT
 *                                                 → redirects to editor
 */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { getAuthKeys } from '@/lib/auth-keys.js';
import { issueSessionToken } from '@medea/engine-auth-local';
import { getContainerTenantId } from './../lib/tenant.js';
import { requireRole } from '@/middleware/rbac.js';
import { getActorId } from '@/lib/actor.js';
import { AuditLogService } from '@/services/audit.service.js';
import { encryptClientSecret, resolveClientSecret } from '@/lib/oauth-secret.js';
import { validateUrlForFetch, assertUrlSafe } from '@medea/engine-safe-fetch';
import { nanoid } from 'nanoid';

const audit = new AuditLogService();

interface OauthProviderRow {
  id: string;
  tenant_id: string;
  provider: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  // Envelope cifrato (#5): presenti sui record nuovi, NULL sui legacy plaintext.
  client_secret_ciphertext?: string | null;
  client_secret_nonce?: string | null;
  client_secret_auth_tag?: string | null;
  client_secret_dek_ciphertext?: string | null;
  client_secret_dek_nonce?: string | null;
  client_secret_dek_auth_tag?: string | null;
  redirect_uri: string;
  scopes: string;
  created_at: string;
}

// F2 (2026-06-10): schema `oauth_providers`/`oauth_state` (+ `users`)
// consolidato in migrate.schema.ts → SCHEMA_SQL, applicato da runMigrations al
// boot. Niente CREATE TABLE inline a request-time qui.

function findProvider(provider: string, tenantId: string): OauthProviderRow | null {
  const { sqlite } = getDatabase();
  return (sqlite
    .prepare('SELECT * FROM oauth_providers WHERE tenant_id = ? AND provider = ?')
    .get(tenantId, provider) as OauthProviderRow | undefined) ?? null;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createOauthRoutes(): Hono {
  const app = new Hono();

  // F1-B (2026-06-10): tenant SEMPRE da getContainerTenantId() = MEDEA_TENANT_ID.
  // Provider + oauth_state nascono sotto il tenant del container; il callback
  // (che usa stateRow.tenant_id) li ritrova per costruzione. Niente override
  // impersonation superadmin (insensato in un container single-tenant). Auth resta
  // richiesta: /providers e /start NON sono in PUBLIC_PATH_PATTERNS (gated da
  // authMiddleware, coperto da auth-public-paths.test.ts). Vedi gemello saml.ts.
  app.get('/oauth/providers', (c) => {
    const tenantId = getContainerTenantId();
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT id, provider, issuer, redirect_uri, scopes, created_at FROM oauth_providers WHERE tenant_id = ?')
      .all(tenantId) as Omit<OauthProviderRow, 'client_id' | 'client_secret' | 'tenant_id'>[];
    return c.json({ providers: rows });
  });

  // OWNER-ONLY (fix 2026-06-12, gap #3): configurare/cancellare un IdP è
  // configurazione d'ACCESSO del workspace — pre-fix bastava authMiddleware:
  // un viewer poteva registrare un IdP che controlla (mint di nuovi account
  // via callback upsert) o cancellare quello legittimo (lockout colleghi).
  app.post('/oauth/providers', requireRole('owner'), async (c) => {
    const tenantId = getContainerTenantId();
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body must be a JSON object' }, 400);
    const body = raw as Record<string, unknown>;
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const issuer = typeof body.issuer === 'string' ? body.issuer : '';
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : '';
    const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : '';
    const scopes = typeof body.scopes === 'string' ? body.scopes : 'openid email profile';
    if (!provider || !issuer || !clientId || !clientSecret || !redirectUri) {
      return c.json({ error: 'provider/issuer/clientId/clientSecret/redirectUri required' }, 400);
    }
    // SSRF: l'issuer è un URL utente e a runtime oidc.discovery ci fa fetch
    // (<issuer>/.well-known/openid-configuration). Senza guard un owner poteva
    // puntarlo a host interni (172.20.0.1 gateway/Redis, 169.254 IMDS, localhost)
    // → SSRF nella rete del server. Rifiutato al salvataggio (host pubblico only).
    if (!validateUrlForFetch(issuer).ok) {
      return c.json({ error: 'issuer deve essere un URL HTTP(S) PUBBLICO — host interni/privati/localhost bloccati (protezione SSRF)' }, 400);
    }
    const id = nanoid();
    // #5: cifra il client_secret (envelope). client_secret legacy plaintext = ''.
    const sec = encryptClientSecret(clientSecret);
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        "INSERT INTO oauth_providers (id, tenant_id, provider, issuer, client_id, client_secret, client_secret_ciphertext, client_secret_nonce, client_secret_auth_tag, client_secret_dek_ciphertext, client_secret_dek_nonce, client_secret_dek_auth_tag, redirect_uri, scopes, created_at) " +
          "VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          'ON CONFLICT (tenant_id, provider) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id, ' +
          "client_secret = '', client_secret_ciphertext = excluded.client_secret_ciphertext, client_secret_nonce = excluded.client_secret_nonce, " +
          'client_secret_auth_tag = excluded.client_secret_auth_tag, client_secret_dek_ciphertext = excluded.client_secret_dek_ciphertext, ' +
          'client_secret_dek_nonce = excluded.client_secret_dek_nonce, client_secret_dek_auth_tag = excluded.client_secret_dek_auth_tag, ' +
          'redirect_uri = excluded.redirect_uri, scopes = excluded.scopes',
      )
      .run(id, tenantId, provider, issuer, clientId, sec.ciphertext, sec.nonce, sec.authTag, sec.dekCiphertext, sec.dekNonce, sec.dekAuthTag, redirectUri, scopes, new Date().toISOString());
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'oauth_provider.upsert',
      resourceType: 'oauth_provider',
      resourceId: provider,
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { issuer, redirectUri },
    });
    return c.json({ id, provider }, 201);
  });

  app.delete('/oauth/providers/:provider', requireRole('owner'), async (c) => {
    const tenantId = getContainerTenantId();
    const provider = c.req.param('provider');
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare('DELETE FROM oauth_providers WHERE tenant_id = ? AND provider = ?')
      .run(tenantId, provider);
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'oauth_provider.remove',
      resourceType: 'oauth_provider',
      resourceId: provider ?? '',
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { removed: info.changes > 0 },
    });
    return c.json({ removed: info.changes > 0 });
  });

  app.get('/oauth/:provider/start', async (c) => {
    const tenantId = getContainerTenantId();
    const provider = c.req.param('provider');
    if (!provider) return c.json({ error: 'Bad request' }, 400);
    const row = findProvider(provider, tenantId);
    if (!row) return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);

    try {
      assertUrlSafe(row.issuer); // difesa-in-profondità SSRF (gate primario all'upsert)
      const config = await oidc.discovery(new URL(row.issuer), row.client_id, resolveClientSecret(row));
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = pkceChallenge(verifier);
      const state = randomBytes(32).toString('base64url');

      const { sqlite } = getDatabase();
      sqlite
        .prepare('INSERT INTO oauth_state (state, tenant_id, provider, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(state, tenantId, provider, verifier, new Date().toISOString(), new Date(Date.now() + 10 * 60_000).toISOString());

      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: row.redirect_uri,
        scope: row.scopes,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });

      return c.redirect(url.toString());
    } catch (err) {
      logger.error({ err, provider }, 'OAuth start failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/oauth/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    if (!provider) return c.json({ error: 'Bad request' }, 400);
    const url = new URL(c.req.url);
    const state = url.searchParams.get('state') ?? '';
    if (!state) return c.json({ error: 'Missing state' }, 400);

    const { sqlite } = getDatabase();
    const stateRow = sqlite
      .prepare('SELECT * FROM oauth_state WHERE state = ?')
      .get(state) as { tenant_id: string; provider: string; code_verifier: string; expires_at: string } | undefined;
    if (!stateRow) return c.json({ error: 'Invalid state' }, 400);
    if (new Date(stateRow.expires_at) < new Date()) {
      sqlite.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
      return c.json({ error: 'State expired' }, 400);
    }

    const row = findProvider(provider, stateRow.tenant_id);
    if (!row) return c.json({ error: 'Provider config missing' }, 404);

    try {
      assertUrlSafe(row.issuer); // difesa-in-profondità SSRF (gate primario all'upsert)
      const config = await oidc.discovery(new URL(row.issuer), row.client_id, resolveClientSecret(row));
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: stateRow.code_verifier,
        expectedState: state,
      });
      const claims = tokens.claims();
      if (!claims) {
        return c.json({ error: 'No claims returned' }, 500);
      }

      sqlite.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);

      const email = typeof claims.email === 'string' ? claims.email : '';
      const displayName = typeof claims.name === 'string' ? claims.name : email;
      if (!email) return c.json({ error: 'Email claim missing from OIDC provider' }, 400);

      // `users` è in SCHEMA_SQL (runMigrations al boot) — niente DDL inline.
      const subject = typeof claims.sub === 'string' ? claims.sub : '';
      const existing = sqlite
        .prepare('SELECT id, role FROM users WHERE tenant_id = ? AND email = ?')
        .get(stateRow.tenant_id, email) as { id: string; role: string } | undefined;

      const now = new Date().toISOString();
      let userId: string;
      let role: 'owner' | 'editor' | 'operator' | 'viewer';
      if (existing) {
        userId = existing.id;
        role = existing.role as typeof role;
        sqlite
          .prepare('UPDATE users SET last_login_at = ?, oauth_provider = ?, oauth_subject = ? WHERE id = ?')
          .run(now, provider, subject, userId);
      } else {
        const ownerCount = (sqlite
          .prepare("SELECT COUNT(*) as c FROM users WHERE tenant_id = ? AND role = 'owner'")
          .get(stateRow.tenant_id) as { c: number }).c;
        userId = nanoid();
        role = ownerCount === 0 ? 'owner' : 'viewer';
        sqlite
          .prepare(
            'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at, last_login_at, oauth_provider, oauth_subject) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
          )
          .run(userId, stateRow.tenant_id, email, displayName, '', role, now, now, now, provider, subject);
      }

      const keys = await getAuthKeys();
      const sessionToken = await issueSessionToken({
        userId,
        tenantId: stateRow.tenant_id,
        email,
        role,
        privateKeyPem: keys.privateKeyPem,
      });

      // Cookie HttpOnly + redirect plain — NIENTE token in URL (precedente
      // pattern leakkava JWT in nginx access log via query string, browser
      // history, Referer header verso CDN/external risorse del editor SPA,
      // e in stacktrace di errori 500. Anche se HttpOnly nel cookie,
      // esporlo in URL annullava il vantaggio).
      //
      // Same-origin con editor (entrambi dietro Traefik su `<slug>.app.…`).
      // In dev cross-origin (editor :5173 ↔ runtime :3100): il path manuale
      // di test passa attraverso POST /sso autosubmit dal portal.
      // HIGH (2026-05-29): __Host- prefix in prod
      const { sessionCookieName } = await import('@/lib/session-cookie.js');
      setCookie(c, sessionCookieName(), sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
        maxAge: 7 * 86_400,
      });
      const editorOrigin = process.env.MEDEA_EDITOR_URL ?? '';
      return c.redirect(editorOrigin === '' ? '/' : editorOrigin, 302);
    } catch (err) {
      logger.error({ err, provider }, 'OAuth callback failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
