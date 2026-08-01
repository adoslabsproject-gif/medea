/**
 * /api/v1/oauth-connect — workflow-credential OAuth2 flow.
 *
 *   GET  /providers                             → which providers are configured
 *   POST /start                                 → returns { authorizeUrl }
 *   GET  /callback?code=…&state=…               → exchanges code, saves credential, redirects to UI
 *
 * The redirect_uri pattern is:
 *   https://<host>/api/v1/oauth-connect/callback
 * Each provider's app must whitelist that exact URI in its developer console.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { OAuthConnectService, OAUTH_PROVIDERS } from '@/services/oauth-connect.service.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { escapeHtml, scriptStringLiteral } from '@/lib/html-escape.js';

const StartSchema = z.object({
  provider: z.enum(['google', 'github', 'slack', 'notion']),
  credentialName: z.string().min(1).max(120),
});

export function createOAuthConnectRoutes(): Hono {
  const app = new Hono();
  const service = new OAuthConnectService();

  app.get('/providers', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const available = service.availableProviders();
    const all = Object.values(OAUTH_PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      configured: available.some((a) => a.id === p.id),
    }));
    return c.json({ providers: all });
  });

  app.post('/start', zValidator('json', StartSchema), (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const body = c.req.valid('json');
    // Build redirect_uri from request — supports both prod & local dev
    const url = new URL(c.req.url);
    const redirectUri = `${url.origin}/api/v1/oauth-connect/callback`;
    try {
      const { authorizeUrl } = service.start({
        provider: body.provider,
        tenantId: getTenantId(c),
        userId: auth.userId,
        credentialName: body.credentialName,
        redirectUri,
      });
      return c.json({ authorizeUrl });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'OAuth start failed' }, 400);
    }
  });

  // Callback is hit by the BROWSER (provider redirects user there). No auth
  // header — the `state` value is the only authenticator.
  app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    if (error) {
      // `error` arriva dalla query string del browser: escape obbligatorio
      // (XSS riflesso). Vedi html-escape.ts.
      return c.html(`<h1>OAuth annullato</h1><p>${escapeHtml(error)}</p><script>setTimeout(()=>window.close(),3000);</script>`);
    }
    if (!code || !state) {
      return c.html('<h1>Parametri mancanti</h1>', 400);
    }
    try {
      const { providerLabel } = await service.complete(code, state);
      // providerLabel deriva dallo state (server-side) ma resta dato non-fidato
      // per costruzione: escape HTML nel markup, literal JS sicuro nello script.
      const labelHtml = escapeHtml(providerLabel);
      const labelJs = scriptStringLiteral(providerLabel);
      // Tiny standalone HTML page: shows success + closes the popup automatically.
      return c.html(`<!doctype html><meta charset="utf-8"><title>Connesso ${labelHtml}</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e5e5;text-align:center;padding:60px}
.icon{font-size:48px;margin-bottom:16px}.btn{display:inline-block;margin-top:24px;padding:8px 16px;background:#2563eb;color:white;border-radius:6px;text-decoration:none}</style>
<div class="icon">✓</div><h1>Connesso a ${labelHtml}</h1>
<p>La credenziale è stata salvata. Puoi chiudere questa finestra.</p>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ source: 'flowforge-oauth', status: 'success', provider: ${labelJs} }, '*'); } catch (_e) { /* opener closed → best-effort signaling, no-op */ }
    setTimeout(() => window.close(), 1500);
  }
</script>`);
    } catch (err) {
      logger.error({ err }, 'OAuth connect callback failed');
      // err.message può contenere input non-fidato (es. valori dal provider):
      // escape obbligatorio.
      return c.html(`<h1>Connessione fallita</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`, 500);
    }
  });

  return app;
}
