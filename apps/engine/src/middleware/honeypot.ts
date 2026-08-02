/**
 * Honeypot middleware — runtime tenant container (#194 audit fix).
 *
 * Stesso pattern del portal middleware (apps/portal/src/middleware/honeypot.ts)
 * ma installato nel container TENANT (`*.app.automazionezeli.com`) — gap
 * critico scoperto dall'audit #194: il React SPA catch-all ritornava `index.html`
 * con HTTP 200 per scanner path (`/@fs/etc/passwd`, `/wp-admin`, `/.env`),
 * confondendo:
 *   - Sentinel WAF (vedeva 200 OK → non bannava IP)
 *   - Analytics dashboard (path malevoli contati come "page view")
 *   - Pentest scanner (falso positivo: "vulnerabile, ritorna 200 sul probe")
 *
 * Risoluzione: 404 esplicito + fire-and-forget POST a Sentinel `/honeypot/hit`
 * (auto-ban dopo HONEYPOT_BAN_THRESHOLD hit per IP in 24h).
 *
 * Wire-up: apps/engine/src/server.ts SUBITO dopo `requestId` /
 * `honoLogger`, PRIMA di qualsiasi mount route — così intercetta anche path
 * che altrimenti finirebbero nello SPA fallback (`attachStaticUi` last).
 */

import type { MiddlewareHandler, Context } from 'hono';
import { readJsonCapped } from '@/lib/capped-response.js';
import { classifyHoneypotPath } from '@medea/engine-shared';
import { loggerFor } from '@/lib/logger.js';

// PSR-3 channel: honeypot hits sono security events — finiscono nel canale
// `security` invece del canale `app` default (regola loggerFor → detectChannel).
const logger = loggerFor('honeypot');

const SENTINEL_URL = process.env.SENTINEL_URL ?? 'http://sentinel:8080';
const SENTINEL_SECRET = process.env.SENTINEL_INTERNAL_SECRET ?? '';
const SENTINEL_ENABLED = SENTINEL_SECRET !== '' && process.env.SENTINEL_ENABLED !== 'false';
const SENTINEL_TIMEOUT_MS = 1500;

interface SentinelHoneypotPayload {
  ip: string;
  endpoint: string;
  user_agent?: string;
}

function clientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

function notifySentinelAsync(payload: SentinelHoneypotPayload): void {
  if (!SENTINEL_ENABLED) return;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), SENTINEL_TIMEOUT_MS);

  fetch(`${SENTINEL_URL}/honeypot/hit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sentinel-secret': SENTINEL_SECRET,
    },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        logger.warn(
          { status: res.status, ip: payload.ip, endpoint: payload.endpoint },
          'sentinel honeypot/hit non-ok',
        );
        return;
      }
      try {
        // Se over-cap o non-JSON, readJsonCapped lancia → il catch esterno (parse
        // error non-fatal) lo gestisce.
        const data = await readJsonCapped<{ hit_count?: number; banned?: boolean }>(res);
        if (data.banned) {
          logger.warn(
            { ip: payload.ip, hits: data.hit_count, endpoint: payload.endpoint },
            'honeypot auto-ban triggered by sentinel',
          );
        }
      } catch {
        /* parse error non-fatal */
      }
    })
    .catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          ip: payload.ip,
          endpoint: payload.endpoint,
        },
        'sentinel honeypot/hit failed (degraded — request still 404)',
      );
    })
    .finally(() => clearTimeout(tid));
}

export function honeypotMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const match = classifyHoneypotPath(c.req.path);
    if (!match) return next();

    const ip = clientIp(c);
    const ua = c.req.header('user-agent') ?? '-';

    logger.warn(
      {
        type: 'honeypot_hit',
        category: match.category,
        description: match.description,
        ip,
        path: c.req.path,
        method: c.req.method,
        ua: ua.slice(0, 200),
      },
      '[HONEYPOT] scanner probe blocked (runtime tenant)',
    );

    notifySentinelAsync({ ip, endpoint: c.req.path, user_agent: ua.slice(0, 256) });

    return c.text('Not Found', 404);
  };
}
