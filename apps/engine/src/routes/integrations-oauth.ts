/**
 * /api/v1/integrations — tenant integrations CRUD + OAuth handshake.
 *
 * Routes
 * ------
 *   GET    /                                          — list integrations (metadata, no creds)
 *   POST   /                                          — create/rotate an integration with plaintext credentials
 *                                                       (used for non-OAuth providers: stripe, whatsapp, raw API key)
 *   DELETE /:id                                        — delete an integration
 *   GET    /oauth/google/connect                       — issue Google OAuth consent redirect
 *   GET    /oauth/google/callback                      — Google OAuth callback (BROWSER hits this)
 *
 * Role gating
 * -----------
 * All routes require role ∈ {editor, owner, superadmin}. Viewers and operators
 * MUST NOT be able to add/rotate/delete credentials — that would let any
 * workflow operator silently exfiltrate the tenant's Stripe key by attaching
 * a fake "test" credential and dumping it via a malicious workflow.
 *
 * State token
 * -----------
 * The OAuth `state` parameter is an HMAC-signed JSON blob (`tenantId`,
 * `userId`, `csrf`, `label`, `provider`, `iat`). Lifetime 10min, single-use
 * (we keep an in-memory replay set for the 10min TTL). HMAC key is derived
 * from `FLOWFORGE_MASTER_PASSWORD` so admins don't need a separate env var.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getTenantId } from '@/lib/tenant.js';
import { logger } from '@/lib/logger.js';
import { escapeHtml } from '@/lib/html-escape.js';
import {
  saveIntegration,
  deleteIntegration,
  listIntegrations,
  type IntegrationProvider,
  type IntegrationMetadata,
} from '@/services/integrations/store.js';

/** Item della lista integrazioni: metadati nativi + marcatore di provenienza
 *  (store nativo vs bridge read-only da Email Accounts). Tipizzato così il
 *  push del bridge è type-checked (niente `as never` che mascherava campi mancanti). */
type IntegrationListItem = IntegrationMetadata & { source: 'integrations' | 'email-accounts' };
import {
  buildOAuthClient,
  exchangeCodeForTokens,
  generateAuthorizeUrl,
} from '@/executors/integrations/google-oauth.js';
import { getMasterPasswordOrThrow } from '@/lib/secrets-crypto.js';

// ocr_tesseract NON è incluso: è OCR locale (nessuna credenziale OAuth/key) →
// non è un'integrazione "connettibile" e la UI non lo espone. Lasciarlo qui
// permetteva di creare record-fantasma via API, invisibili in UI. Il tipo store
// e il CHECK DB lo conservano per eventuali record storici.
const PROVIDER_ENUM = z.enum([
  'gmail', 'whatsapp', 'stripe', 'google_drive', 'ocr_vision',
]);

const CreateIntegrationSchema = z.object({
  provider: PROVIDER_ENUM,
  label: z.string().min(1).max(120).optional(),
  // Free-form JSON blob — each provider knows its own shape.
  credentials: z.record(z.string(), z.unknown()),
  expiresAt: z.number().int().nullable().optional(),
});

const ConnectGoogleSchema = z.object({
  /** What this integration record will be labeled as in the UI. */
  label: z.string().min(1).max(120).optional(),
  /** Whether the OAuth tokens land under `gmail`, `google_drive`, or BOTH. */
  scope: z.enum(['gmail', 'drive', 'both']).default('both'),
});

const STATE_TTL_MS = 10 * 60 * 1000;
const usedStateJtis = new Map<string, number>(); // jti → expiresAt

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [jti, exp] of usedStateJtis) {
    if (exp < now) usedStateJtis.delete(jti);
  }
}

interface StatePayload {
  tenantId: string;
  userId: string;
  label: string | null;
  scope: 'gmail' | 'drive' | 'both';
  jti: string;
  iat: number;
}

function signState(payload: StatePayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const hmac = createHmac('sha256', getMasterPasswordOrThrow())
    .update(`oauth-state-v1|${b64}`)
    .digest('base64url');
  return `${b64}.${hmac}`;
}

function verifyState(token: string): StatePayload {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) {
    throw new Error('Malformed state token');
  }
  const expected = createHmac('sha256', getMasterPasswordOrThrow())
    .update(`oauth-state-v1|${b64}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Timing-safe compare requires equal-length buffers.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('State signature mismatch');
  }
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as StatePayload;
  if (Date.now() - payload.iat > STATE_TTL_MS) {
    throw new Error('State token expired');
  }
  pruneExpiredStates();
  if (usedStateJtis.has(payload.jti)) {
    throw new Error('State token already used (replay attempt)');
  }
  usedStateJtis.set(payload.jti, payload.iat + STATE_TTL_MS);
  return payload;
}

function requireWriteRole(role: string | undefined): { ok: boolean; reason?: string } {
  // editor | owner | superadmin can write credentials. Operators / viewers cannot.
  const allowed = new Set(['editor', 'owner', 'superadmin']);
  if (!role || !allowed.has(role)) {
    return { ok: false, reason: `Role "${role ?? 'none'}" cannot manage integrations` };
  }
  return { ok: true };
}

export function createIntegrationsRoutes(): Hono {
  const app = new Hono();

  // ─── List ─────────────────────────────────────────────────────────
  // Cross-vault bridge: include sia gli integration record diretti (questo
  // store) sia gli OAuth account creati via Email Accounts (SystemEmailAccounts).
  // L'UI Integrazioni mostra "Connesso via Email Accounts" su Gmail
  // quando l'utente ha già completato OAuth dalla tab dedicata, evitando
  // il falso "non implementato" dovuto a storage separati.
  app.get('/', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const integrations: IntegrationListItem[] = listIntegrations(tenantId).map((i) => ({
      ...i,
      source: 'integrations' as const,
    }));

    // Read-only bridge da system_email_accounts → provider=gmail.
    // Mostriamo SOLO row con OAuth Google completato (authType='oauth2' +
    // oauth.provider='google'), in modo che la UI Integrazioni segnali
    // "✅ Connesso via Email Accounts" senza esporre password legacy SMTP.
    try {
      const mod = await import('@/services/system-email-accounts.service.js');
      const emailAccounts = new mod.SystemEmailAccountsService().list(tenantId);
      const gmailOAuth = emailAccounts.filter(
        (a) => a.authType === 'oauth2' && a.oauth?.provider === 'google',
      );
      for (const acc of gmailOAuth) {
        // oauth.expiresAt è una STRINGA ISO; IntegrationMetadata.expiresAt è
        // number(epoch ms)|null → converti (il vecchio `as never` infilava una
        // stringa in un campo number, bug latente lato UI).
        const oauthExpMs = acc.oauth?.expiresAt ? Date.parse(acc.oauth.expiresAt) : NaN;
        integrations.push({
          id: `email-account:${acc.id}`,
          provider: 'gmail',
          label: acc.label ?? acc.oauth?.email ?? acc.fromAddress,
          createdAt: acc.createdAt,
          updatedAt: acc.updatedAt,
          expiresAt: Number.isFinite(oauthExpMs) ? oauthExpMs : null,
          // system_email_accounts non traccia questi due nel vault integrations
          // → null espliciti (no `as never`).
          lastUsedAt: null,
          createdByUserId: null,
          source: 'email-accounts',
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cross-vault bridge to email-accounts failed (best-effort)',
      );
    }

    return c.json({ integrations, total: integrations.length });
  });

  // ─── Create (non-OAuth) ───────────────────────────────────────────
  app.post('/', zValidator('json', CreateIntegrationSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const role = requireWriteRole(auth.role);
    if (!role.ok) return c.json({ error: role.reason ?? 'Forbidden' }, 403);

    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    try {
      const saved = await saveIntegration({
        provider: body.provider,
        tenantId,
        ...(body.label !== undefined ? { label: body.label } : {}),
        credentials: body.credentials,
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        createdByUserId: auth.userId,
      });
      return c.json({ integration: saved }, 201);
    } catch (err) {
      logger.error({ err, provider: body.provider, tenantId }, 'saveIntegration failed');
      return c.json({ error: err instanceof Error ? err.message : 'Failed to save integration' }, 500);
    }
  });

  // ─── Delete ───────────────────────────────────────────────────────
  app.delete('/:id', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const role = requireWriteRole(auth.role);
    if (!role.ok) return c.json({ error: role.reason ?? 'Forbidden' }, 403);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const tenantId = getTenantId(c);
    const deleted = await deleteIntegration({ id, tenantId, actorId: auth.userId });
    if (deleted === 0) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  // ─── Google OAuth: /connect ───────────────────────────────────────
  app.get('/oauth/google/connect', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const role = requireWriteRole(auth.role);
    if (!role.ok) return c.json({ error: role.reason ?? 'Forbidden' }, 403);

    const tenantId = getTenantId(c);
    // Parse query — Hono's zValidator does query too, but it's overkill here.
    const labelParam = c.req.query('label');
    const scopeParam = c.req.query('scope') as 'gmail' | 'drive' | 'both' | undefined;
    const parsed = ConnectGoogleSchema.safeParse({
      ...(labelParam !== undefined ? { label: labelParam } : {}),
      scope: scopeParam ?? 'both',
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }

    let client;
    try {
      client = await buildOAuthClient();
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'OAuth not configured' }, 500);
    }
    const url = new URL(c.req.url);
    const redirectUri = client.defaultRedirectUri
      ?? `${url.origin}/api/v1/integrations/oauth/google/callback`;

    const statePayload: StatePayload = {
      tenantId,
      userId: auth.userId,
      label: parsed.data.label ?? null,
      scope: parsed.data.scope,
      jti: randomBytes(16).toString('hex'),
      iat: Date.now(),
    };
    const state = signState(statePayload);

    // Scope set depends on `scope` selection — minimum-privilege by default.
    const scopes = parsed.data.scope === 'gmail'
      ? ['openid', 'email', 'profile',
         'https://www.googleapis.com/auth/gmail.readonly',
         'https://www.googleapis.com/auth/gmail.send']
      : parsed.data.scope === 'drive'
      ? ['openid', 'email', 'profile',
         'https://www.googleapis.com/auth/drive.file']
      : undefined; // 'both' → default
    const authorizeUrl = scopes !== undefined
      ? generateAuthorizeUrl({ client, redirectUri, state, scopes })
      : generateAuthorizeUrl({ client, redirectUri, state });

    return c.json({ authorizeUrl });
  });

  // ─── Google OAuth: /callback ──────────────────────────────────────
  // NO auth header — browser hits this. State token IS the authenticator.
  app.get('/oauth/google/callback', async (c) => {
    const code = c.req.query('code');
    const stateToken = c.req.query('state');
    const error = c.req.query('error');
    if (error) {
      // `error` arriva dalla query string del browser: escape anti-XSS.
      return c.html(`<h1>Connessione annullata</h1><p>${escapeHtml(error)}</p><script>setTimeout(()=>window.close(),3000);</script>`);
    }
    if (!code || !stateToken) {
      return c.html('<h1>Parametri mancanti (code/state)</h1>', 400);
    }
    let state: StatePayload;
    try {
      state = verifyState(stateToken);
    } catch (err) {
      logger.warn({ err }, 'OAuth callback: state verify failed');
      return c.html(`<h1>State token non valido</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`, 400);
    }

    let client;
    try {
      client = await buildOAuthClient();
    } catch (err) {
      logger.error({ err }, 'OAuth callback: client not configured');
      return c.html('<h1>OAuth non configurato</h1>', 500);
    }
    const url = new URL(c.req.url);
    const redirectUri = client.defaultRedirectUri
      ?? `${url.origin}/api/v1/integrations/oauth/google/callback`;

    try {
      const { credentials, expiresAt } = await exchangeCodeForTokens({ client, code, redirectUri });

      // Persist under the requested scope(s). For "both" we save under gmail
      // AND google_drive — same accessToken+refreshToken used by both, but
      // an admin can revoke one provider without revoking the other.
      const providers: IntegrationProvider[] = state.scope === 'gmail' ? ['gmail']
        : state.scope === 'drive' ? ['google_drive']
        : ['gmail', 'google_drive'];

      for (const provider of providers) {
        await saveIntegration({
          provider,
          tenantId: state.tenantId,
          ...(state.label !== null ? { label: state.label } : {}),
          credentials: credentials as unknown as Record<string, unknown>,
          expiresAt,
          createdByUserId: state.userId,
        });
      }

      return c.html(`<!doctype html><meta charset="utf-8"><title>Connesso a Google</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e5e5;text-align:center;padding:60px}
.icon{font-size:48px;margin-bottom:16px}</style>
<div class="icon">&#x2713;</div><h1>Connesso a Google</h1>
<p>Le credenziali sono salvate. Puoi chiudere questa finestra.</p>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ source: 'flowforge-integrations', status: 'success', providers: ${JSON.stringify(providers)} }, '*'); } catch (_e) { /* opener closed → best-effort signaling, no-op */ }
    setTimeout(() => window.close(), 1500);
  }
</script>`);
    } catch (err) {
      logger.error({ err, tenantId: state.tenantId }, 'OAuth callback failed');
      return c.html(`<h1>Connessione fallita</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`, 500);
    }
  });

  return app;
}
