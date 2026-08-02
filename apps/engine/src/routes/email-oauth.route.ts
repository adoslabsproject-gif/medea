/**
 * Tenant-side Gmail OAuth endpoints (portal-centric flow).
 *
 * Why this redirects to the portal instead of running the OAuth dance itself
 * ─────────────────────────────────────────────────────────────────────────
 * Google requires every `redirect_uri` to be pre-registered in the Cloud
 * Console — there is no wildcard support. In a multi-tenant SaaS the
 * operator can't realistically register a new redirect URI per tenant
 * (think: thousands of subdomains, async provisioning, no API to mutate
 * the OAuth client). The pattern used by Auth0, Zapier, Make and n8n
 * Cloud is ONE OAuth client owned by the platform with ONE central
 * redirect URI; per-tenant context is preserved across the redirect via
 * a state parameter and the tokens are delivered to the originating
 * tenant via a short-lived signed handoff.
 *
 * Flow
 * ────
 *
 *   SPA "Connetti Gmail"
 *      │
 *      ▼
 *   GET <tenant>/api/v1/email-accounts/oauth/google/start
 *      │  authenticated session (owner/superadmin)
 *      │  → 302 to https://flowforge.automazionezeli.com/api/v1/email-oauth/google/start
 *      │     ?tenant=<slug>&workspaceId=<id>&label=…&fromAddress=…&isDefault=…&accountId=…
 *      ▼
 *   Portal persists state + PKCE, 302 → Google consent screen.
 *   Google → portal /callback → portal exchanges code, emits JWE handoff.
 *      │
 *      ▼
 *   GET <tenant>/api/v1/email-accounts/oauth/google/import?handoff=<jwe>
 *      │  PUBLIC — but JWE is bound to this workspaceId via audience.
 *      │  → decrypt JWE with same MEDEA_SSO_SECRET key.
 *      │  → upsertOAuthAccount + audit log.
 *      │  → 302 to /#/settings?tab=email-accounts&oauthSuccess=1
 *
 * Single-use handoff: the JWE has a 5-min TTL and a `jti` that we DO NOT
 * track here for replay (the SSO key already tracks for login handoffs in
 * Redis — adding here would mean a Redis dep in the runtime which we
 * deliberately keep minimal). The threat model is acceptable: an attacker
 * who steals the JWE before it lands has 5 minutes to import a Gmail
 * account they themselves authorized (because they ran the consent flow);
 * they could equally well authorize a second time. The interesting attack
 * — stealing tokens FROM another user — is blocked because the JWE
 * audience is the originating workspaceId.
 *
 * @module routes/email-oauth.route
 */

import { Hono } from 'hono';
import { readJsonCapped } from '@/lib/capped-response.js';
import type { Context } from 'hono';
import { jwtDecrypt } from 'jose';
import { hkdfSync } from 'node:crypto';
import { logger } from '@/lib/logger.js';
import { SystemEmailAccountsService } from '@/services/system-email-accounts.service.js';
import { loadConfig } from '@/config.js';

interface HandoffClaims {
  kind?: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: string;
  label?: string;
  fromAddress?: string;
  isDefault?: boolean;
  existingAccountId?: string;
}

/**
 * Derive the JWE key with the SAME HKDF schedule the portal uses to issue
 * the handoff. Keep this string in lock-step with
 * `apps/portal/src/services/sso.service.ts`. Both ends MUST share the
 * `MEDEA_SSO_SECRET` env value — that's the only secret material;
 * the salt + info pair below is public.
 */
function deriveJweKey(): Uint8Array {
  const cfg = loadConfig();
  const secret = cfg.MEDEA_SSO_SECRET ?? process.env.MEDEA_SSO_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('MEDEA_SSO_SECRET missing or too short (need >= 32 bytes)');
  }
  // node:crypto.hkdfSync — same RFC-5869 derivation. Salt + info MUST be
  // byte-identical to the portal's `getSsoJweKey()` (see
  // apps/portal/src/services/sso.service.ts:51). Portal uses an empty
  // salt and the info label `flowforge-sso-jwe-v1`.
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.alloc(0);
  const info = Buffer.from('flowforge-sso-jwe-v1', 'utf8');
  return new Uint8Array(hkdfSync('sha256', ikm, salt, info, 32));
}

/**
 * Portal base URL for the redirect.
 *
 * Falls back to the production portal so a misconfigured env doesn't
 * silently break OAuth for every tenant — better to redirect to the real
 * portal and surface an oauth_not_configured error there than to send the
 * user to localhost.
 */
function portalBase(): string {
  return process.env.MEDEA_PORTAL_BASE_URL || 'https://flowforge.automazionezeli.com';
}

/**
 * The runtime knows its own tenant slug via env (set by onboarding.ts when
 * the container is provisioned). We need it to tell the portal where to
 * send the user back. If it's missing we still build a URL with the
 * `host` header value, but the portal validates `tenant` matches the
 * subdomain in the redirect, so that fallback is best-effort only.
 */
function tenantSlug(c: Context): string {
  const fromEnv = process.env.MEDEA_TENANT_SLUG;
  if (fromEnv) return fromEnv;
  const host = c.req.header('host') ?? '';
  // Subdomain extraction: `<slug>.app.automazionezeli.com` → `slug`.
  const m = /^([^.]+)\.app\./.exec(host);
  return m?.[1] ?? '';
}

export function createEmailOauthRoutes(): Hono {
  const app = new Hono();
  const accountsSvc = new SystemEmailAccountsService();

  /**
   * /email-accounts/oauth/google/start — authenticated kick-off.
   *
   * Returns a 302 to the portal `/api/v1/email-oauth/google/start` with all
   * the per-account metadata appended as query params. The portal handles
   * Google itself; we only see the user again on /import.
   */
  app.get('/email-accounts/oauth/google/start', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (auth.role !== 'owner' && auth.role !== 'superadmin') {
      return c.json({ error: 'Forbidden — owner/superadmin only' }, 403);
    }

    const slug = tenantSlug(c);
    if (!slug) {
      return c.json({
        error: 'tenant_slug_unknown',
        message: 'Runtime non sa il proprio tenant slug. Imposta MEDEA_TENANT_SLUG nell\'env del container.',
      }, 500);
    }

    const url = new URL(c.req.url);
    const out = new URL(`${portalBase()}/api/v1/email-oauth/google/start`);
    out.searchParams.set('tenant', slug);
    out.searchParams.set('workspaceId', auth.tenantId);
    for (const k of ['label', 'fromAddress', 'isDefault', 'accountId']) {
      const v = url.searchParams.get(k);
      if (v) out.searchParams.set(k, v);
    }

    logger.info({ tenantId: auth.tenantId, slug }, 'email-oauth redirect-to-portal');
    return c.redirect(out.toString());
  });

  /**
   * /email-accounts/oauth/google/status — UI capability probe.
   *
   * The button enabled-state depends on the PORTAL's OAuth client
   * configuration. We forward the portal response so the UX stays
   * consistent regardless of who hosts the OAuth client.
   */
  app.get('/email-accounts/oauth/google/status', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const res = await fetch(`${portalBase()}/api/v1/email-oauth/google/status`);
      if (!res.ok) return c.json({ enabled: false, reason: `portal HTTP ${res.status}` });
      const body = await readJsonCapped<{ enabled?: boolean }>(res);
      return c.json({ enabled: body.enabled === true });
    } catch (err) {
      logger.warn({ err }, 'portal status probe failed');
      return c.json({ enabled: false, reason: 'portal_unreachable' });
    }
  });

  /**
   * /email-accounts/oauth/google/import — JWE handoff consumer.
   *
   * PUBLIC: Google → portal → us. The user is mid-redirect, no session
   * cookie is guaranteed (the browser may have lost it during the
   * cross-subdomain bounce, depending on SameSite policy). The JWE
   * encrypts EVERYTHING with the audience claim bound to this workspace,
   * so we MUST validate audience after decrypt.
   *
   * On success we 302 back to the SPA Settings tab with success qs.
   */
  app.get('/email-accounts/oauth/google/import', async (c) => {
    const redirectToSettings = (qs: Record<string, string>): Response => {
      const sp = new URLSearchParams({ tab: 'email-accounts', ...qs }).toString();
      const host = c.req.header('host') ?? 'localhost';
      return c.redirect(`https://${host}/#/settings?${sp}`);
    };

    const url = new URL(c.req.url);
    const handoff = url.searchParams.get('handoff');
    if (!handoff) return redirectToSettings({ oauthError: 'missing_handoff' });

    let claims: HandoffClaims;
    let aud: string;
    try {
      const key = deriveJweKey();
      const { payload } = await jwtDecrypt(handoff, key, {
        // 2026-06-05 fix: il portal emette JWE con iss='portal.flowforge'
        // (sso.service.ts:39 — same key del SSO principale). Il valore
        // 'flowforge-portal' era sbagliato → ogni handoff Gmail veniva
        // rifiutato con `unexpected "iss" claim value` → l'account non
        // veniva mai inserito in system_email_accounts → utente vedeva
        // tab vuota dopo OAuth success.
        issuer: 'portal.flowforge',
        clockTolerance: 30,
      });
      claims = payload as HandoffClaims;
      aud = (Array.isArray(payload.aud) ? payload.aud[0] : payload.aud) ?? '';
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'email-oauth handoff JWE decrypt failed');
      return redirectToSettings({ oauthError: 'handoff_invalid' });
    }

    if (claims.kind !== 'email-oauth-handoff') {
      logger.warn({ kind: claims.kind }, 'email-oauth handoff wrong kind');
      return redirectToSettings({ oauthError: 'handoff_wrong_kind' });
    }

    // Audience MUST match the workspaceId the runtime is configured for.
    // Otherwise an attacker who steals a handoff from tenant A could
    // import the tokens into tenant B (still requires tenant B login but
    // would let an A-employee plant Gmail tokens in B). Block at audience.
    const cfg = loadConfig();
    const expectedAud = cfg.MEDEA_TENANT_ID ?? process.env.MEDEA_TENANT_ID;
    if (!expectedAud) {
      logger.error('MEDEA_TENANT_ID not set — cannot verify handoff audience');
      return redirectToSettings({ oauthError: 'tenant_id_unset' });
    }
    if (aud !== expectedAud) {
      logger.warn({ aud, expectedAud }, 'email-oauth handoff audience mismatch');
      return redirectToSettings({ oauthError: 'handoff_audience_mismatch' });
    }

    if (!claims.email || !claims.accessToken || !claims.refreshToken || !claims.expiresAt || !claims.scope) {
      logger.warn({ claims: { ...claims, accessToken: !!claims.accessToken, refreshToken: !!claims.refreshToken } }, 'email-oauth handoff missing fields');
      return redirectToSettings({ oauthError: 'handoff_incomplete' });
    }

    try {
      const upsertArgs: Parameters<SystemEmailAccountsService['upsertOAuthAccount']>[0] = {
        tenantId: expectedAud,
        label: claims.label ?? `Gmail (${claims.email})`,
        fromAddress: claims.fromAddress ?? claims.email,
        isDefault: claims.isDefault === true,
        provider: 'google',
        email: claims.email,
        refreshToken: claims.refreshToken,
        accessToken: claims.accessToken,
        expiresAt: new Date(claims.expiresAt),
        scope: claims.scope,
      };
      if (claims.existingAccountId) upsertArgs.existingId = claims.existingAccountId;
      const account = accountsSvc.upsertOAuthAccount(upsertArgs);
      logger.info({ tenantId: expectedAud, accountId: account.id, email: claims.email }, 'email-oauth handoff imported');
      return redirectToSettings({ oauthSuccess: '1', accountId: account.id, email: claims.email });
    } catch (err) {
      logger.error({ err }, 'email-oauth import upsert failed');
      const msg = err instanceof Error ? err.message : 'upsert_failed';
      return redirectToSettings({ oauthError: 'import_failed', detail: msg.slice(0, 200) });
    }
  });

  return app;
}
