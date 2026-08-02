/**
 * Email tracking endpoints — pixel open + click redirect.
 *
 *   GET /api/track/open/:token      → 1×1 GIF (always 200; tracking is best-effort)
 *   GET /api/track/click/:token     → 302 to ?u=<url> (or 400 if bad)
 *
 * Public by design — these URLs live inside customer emails, browsers
 * fetch them with no auth. The HMAC token IS the authorization.
 *
 * @module routes/email-tracking.route
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  recordOpen,
  recordClick,
  TRANSPARENT_GIF_BYTES,
} from '@/services/email-tracking.service.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';

const PIXEL_CACHE_HEADERS: Record<string, string> = {
  'Content-Type': 'image/gif',
  'Content-Length': String(TRANSPARENT_GIF_BYTES.length),
  // No cache: every render should reach us so we count opens, not the CDN.
  // Mail clients ignore this header in practice but we set it for correctness.
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

function trackingSecret(): string {
  const cfg = loadConfig();
  const secret = cfg.MEDEA_SSO_SECRET ?? process.env.MEDEA_SSO_SECRET ?? '';
  return secret;
}

function clientIp(c: Context): string | undefined {
  // Behind nginx + Traefik: real IP arrives in X-Forwarded-For (left-most).
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') ?? undefined;
}

export function createEmailTrackingRoutes(): Hono {
  const app = new Hono();

  /**
   * Pixel open. ALWAYS returns the GIF + 200, even when the token is
   * invalid — refusing the GIF would tip off a scanner that we're
   * filtering them. We just don't persist anything in those cases.
   */
  app.get('/api/track/open/:token', async (c) => {
    const token = c.req.param('token');
    const secret = trackingSecret();
    if (!secret) {
      logger.error('email-tracking: MEDEA_SSO_SECRET unset — cannot verify tokens');
    } else {
      const res = await recordOpen({
        token,
        userAgent: c.req.header('user-agent'),
        ip: clientIp(c),
        secret,
      });
      if (!res.ok) {
        logger.warn(
          { reason: res.reason, component: 'email-tracking-open' },
          'open: token rejected',
        );
      }
    }
    for (const [k, v] of Object.entries(PIXEL_CACHE_HEADERS)) c.header(k, v);
    return c.body(TRANSPARENT_GIF_BYTES);
  });

  /**
   * Click redirect. Honest failures:
   *  - missing/invalid token → 400 with plain HTML "link non valido"
   *  - missing/invalid `u`   → 400 same
   *  - bad destination scheme → 400 same
   *  - otherwise → 302 to the destination
   *
   * We surface the failure (instead of always 302-ing) so a tampered
   * link doesn't silently forward the user — the user knows something
   * is off and can ask the sender.
   */
  app.get('/api/track/click/:token', async (c) => {
    const token = c.req.param('token');
    const destUrl = c.req.query('u') ?? '';
    if (!destUrl) {
      return c.html(invalidLinkPage('Link senza destinazione.'), 400);
    }
    const secret = trackingSecret();
    if (!secret) {
      // No secret = we can't verify. Refuse the redirect — better than
      // becoming an unsigned open-redirect.
      return c.html(invalidLinkPage('Servizio di tracking non configurato.'), 503);
    }
    const res = await recordClick({
      token,
      destinationUrl: destUrl,
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c),
      secret,
    });
    if (!res.ok) {
      logger.warn(
        { reason: res.reason, component: 'email-tracking-click' },
        'click: token rejected',
      );
      return c.html(invalidLinkPage('Link scaduto o invalido.'), 400);
    }
    return c.redirect(destUrl, 302);
  });

  return app;
}

function invalidLinkPage(reason: string): string {
  const safe = reason.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Link non valido</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#0f172a}
h1{font-size:20px;margin:0 0 12px}p{color:#475569;line-height:1.5}.box{border:1px solid #e2e8f0;border-radius:8px;padding:20px;background:#f8fafc}</style>
</head><body><div class="box"><h1>Link non valido</h1><p>${safe}</p><p style="margin-top:16px;font-size:13px;color:#94a3b8">Se hai cliccato da una nostra email, scrivici e te ne inviamo una nuova.</p></div></body></html>`;
}
