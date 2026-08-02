/**
 * SAML 2.0 routes — enterprise SSO (Okta SAML, OneLogin, Azure AD, ADFS).
 *
 * Per-tenant config stored as a JSON blob with:
 *   - entryPoint, issuer, cert (IdP signing cert), callbackUrl
 *
 * Endpoints:
 *   GET  /api/v1/auth/saml/:provider/metadata  XML metadata for IdP setup
 *   GET  /api/v1/auth/saml/:provider/login     redirects to IdP SSO URL
 *   POST /api/v1/auth/saml/:provider/callback  receives signed assertion, mints FlowForge JWT
 */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { SAML, type SamlConfig } from '@node-saml/node-saml';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { getAuthKeys } from '@/lib/auth-keys.js';
import { issueSessionToken } from '@medea/engine-auth-local';
import { nanoid } from 'nanoid';
import { getContainerTenantId } from '@/lib/tenant.js';
import { requireRole } from '@/middleware/rbac.js';
import { getActorId } from '@/lib/actor.js';
import { AuditLogService } from '@/services/audit.service.js';

const audit = new AuditLogService();

interface SamlProviderRow {
  id: string;
  tenant_id: string;
  provider: string;
  entry_point: string;
  issuer: string;
  cert: string;
  callback_url: string;
  created_at: string;
}

// F2 (2026-06-10): schema `saml_providers` (+ `users`) consolidato in
// migrate.schema.ts → SCHEMA_SQL, applicato da runMigrations al boot. Niente
// più CREATE TABLE inline a request-time qui.

function findProvider(provider: string, tenantId: string): SamlProviderRow | null {
  const { sqlite } = getDatabase();
  return (
    (sqlite
      .prepare('SELECT * FROM saml_providers WHERE tenant_id = ? AND provider = ?')
      .get(tenantId, provider) as SamlProviderRow | undefined) ?? null
  );
}

function buildSamlConfig(row: SamlProviderRow): SamlConfig {
  return {
    callbackUrl: row.callback_url,
    entryPoint: row.entry_point,
    issuer: row.issuer,
    idpCert: row.cert,
    wantAssertionsSigned: true,
    // HIGH (2026-05-29): wantAuthnResponseSigned aggiunto. Pre-fix solo
    // l'assertion era richiesta firmata; con response unsigned, un MITM
    // tra IdP e SP poteva forgiare un wrapper Response e iniettare
    // un'assertion legittima rubata da un'altra session.
    wantAuthnResponseSigned: true,
    signatureAlgorithm: 'sha256',
  };
}

export function createSamlRoutes(): Hono {
  const app = new Hono();

  // F1-B (2026-06-10): TUTTE le route (admin CRUD + flusso pubblico) risolvono
  // il tenant da getContainerTenantId() = MEDEA_TENANT_ID. In un container
  // single-tenant il tenant è SEMPRE quello dell'env: così "tenant di creazione
  // del provider == tenant del callback" è garanzia STRUTTURALE, non un invariante
  // che dipende dall'enforcement H5 in sso.ts, e l'override impersonation
  // superadmin (getTenantId) — privo di senso qui — non può creare un provider
  // sotto un tenant che il callback non troverebbe mai. L'auth resta richiesta:
  // /providers NON è in PUBLIC_PATH_PATTERNS (gated da authMiddleware, coperto da
  // auth-public-paths.test.ts).
  app.get('/saml/providers', (c) => {
    const tenantId = getContainerTenantId();
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT id, provider, entry_point, issuer, callback_url, created_at FROM saml_providers WHERE tenant_id = ?',
      )
      .all(tenantId) as Omit<SamlProviderRow, 'cert' | 'tenant_id'>[];
    return c.json({ providers: rows });
  });

  // OWNER-ONLY (fix 2026-06-12, gap #3 — gemello di oauth.ts): configurare o
  // cancellare un IdP SAML è configurazione d'accesso del workspace. Pre-fix
  // qualunque utente autenticato (anche viewer) poteva farlo.
  app.delete('/saml/providers/:provider', requireRole('owner'), async (c) => {
    const tenantId = getContainerTenantId();
    const provider = c.req.param('provider');
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare('DELETE FROM saml_providers WHERE tenant_id = ? AND provider = ?')
      .run(tenantId, provider);
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'saml_provider.remove',
      resourceType: 'saml_provider',
      resourceId: provider ?? '',
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { removed: info.changes > 0 },
    });
    return c.json({ removed: info.changes > 0 });
  });

  app.post('/saml/providers', requireRole('owner'), async (c) => {
    const tenantId = getContainerTenantId();
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const body = raw as Record<string, unknown>;
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const entryPoint = typeof body.entryPoint === 'string' ? body.entryPoint : '';
    const issuer = typeof body.issuer === 'string' ? body.issuer : '';
    const cert = typeof body.cert === 'string' ? body.cert : '';
    const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : '';
    if (!provider || !entryPoint || !issuer || !cert || !callbackUrl) {
      return c.json({ error: 'provider/entryPoint/issuer/cert/callbackUrl required' }, 400);
    }
    const id = nanoid();
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'INSERT INTO saml_providers (id, tenant_id, provider, entry_point, issuer, cert, callback_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, provider) DO UPDATE SET entry_point = excluded.entry_point, issuer = excluded.issuer, cert = excluded.cert, callback_url = excluded.callback_url',
      )
      .run(id, tenantId, provider, entryPoint, issuer, cert, callbackUrl, new Date().toISOString());
    const actorId = getActorId(c) ?? undefined;
    await audit.append({
      tenantId,
      action: 'saml_provider.upsert',
      resourceType: 'saml_provider',
      resourceId: provider,
      ...(actorId !== undefined ? { actorId } : {}),
      metadata: { issuer, entryPoint },
    });
    return c.json({ id, provider }, 201);
  });

  app.get('/saml/:provider/metadata', (c) => {
    // PUBLIC route (IdP setup): tenant from container env, never the header.
    const tenantId = getContainerTenantId();
    const provider = c.req.param('provider');
    if (!provider) return c.json({ error: 'Bad request' }, 400);
    const row = findProvider(provider, tenantId);
    if (!row) return c.json({ error: 'Provider not configured' }, 404);
    const saml = new SAML(buildSamlConfig(row));
    return new Response(saml.generateServiceProviderMetadata(null, null), {
      headers: { 'Content-Type': 'application/xml' },
    });
  });

  app.get('/saml/:provider/login', async (c) => {
    // PUBLIC route (browser → IdP redirect): tenant from container env.
    const tenantId = getContainerTenantId();
    const provider = c.req.param('provider');
    if (!provider) return c.json({ error: 'Bad request' }, 400);
    const row = findProvider(provider, tenantId);
    if (!row) return c.json({ error: 'Provider not configured' }, 404);
    const saml = new SAML(buildSamlConfig(row));
    try {
      const url = await saml.getAuthorizeUrlAsync('', undefined, {});
      return c.redirect(url);
    } catch (err) {
      logger.error({ err }, 'SAML login redirect failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/saml/:provider/callback', async (c) => {
    // PUBLIC route (IdP POST, no JWT/header): tenant from container env. This
    // is the value baked into the minted session token below — MUST NOT come
    // from a caller-controlled header (spoofing) and MUST match the tenant the
    // provider was registered under (else findProvider 404s → SSO broken).
    const tenantId = getContainerTenantId();
    const provider = c.req.param('provider');
    if (!provider) return c.json({ error: 'Bad request' }, 400);
    const row = findProvider(provider, tenantId);
    if (!row) return c.json({ error: 'Provider not configured' }, 404);

    const formData = await c.req.formData();
    const samlResponse = formData.get('SAMLResponse');
    if (typeof samlResponse !== 'string') return c.json({ error: 'Missing SAMLResponse' }, 400);

    const saml = new SAML(buildSamlConfig(row));
    try {
      const profile = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
      const p = profile.profile as Record<string, unknown> | null;
      if (!p) return c.json({ error: 'Empty SAML profile' }, 400);
      const email =
        typeof p.email === 'string'
          ? p.email
          : typeof p['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ===
              'string'
            ? p['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']
            : '';
      if (!email) return c.json({ error: 'No email claim in SAML profile' }, 400);
      const displayName = typeof p.displayName === 'string' ? p.displayName : email;

      const { sqlite } = getDatabase();
      // `users` è in SCHEMA_SQL (runMigrations al boot) — niente DDL inline.
      const existing = sqlite
        .prepare('SELECT id, role FROM users WHERE tenant_id = ? AND email = ?')
        .get(tenantId, email) as { id: string; role: string } | undefined;
      const now = new Date().toISOString();
      let userId: string;
      let role: 'owner' | 'editor' | 'operator' | 'viewer';
      if (existing) {
        userId = existing.id;
        role = existing.role as typeof role;
        sqlite
          .prepare('UPDATE users SET last_login_at = ?, oauth_provider = ? WHERE id = ?')
          .run(now, `saml:${provider}`, userId);
      } else {
        const ownerCount = (
          sqlite
            .prepare("SELECT COUNT(*) as c FROM users WHERE tenant_id = ? AND role = 'owner'")
            .get(tenantId) as { c: number }
        ).c;
        userId = nanoid();
        role = ownerCount === 0 ? 'owner' : 'viewer';
        sqlite
          .prepare(
            'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at, last_login_at, oauth_provider) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
          )
          .run(userId, tenantId, email, displayName, '', role, now, now, now, `saml:${provider}`);
      }

      const keys = await getAuthKeys();
      const sessionToken = await issueSessionToken({
        userId,
        tenantId,
        email,
        role,
        privateKeyPem: keys.privateKeyPem,
      });
      // Cookie HttpOnly + redirect plain — NIENTE token in URL. Stesso
      // motivo di oauth.ts: token in URL leakka in nginx access log, browser
      // history, Referer, error stacktrace. Same-origin via Traefik in prod.
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
      logger.error({ err }, 'SAML callback failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
