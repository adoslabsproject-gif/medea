/**
 * Origin-based CSRF protection — defense-in-depth oltre SameSite=Lax.
 *
 * Pattern: per ogni mutating request (POST/PUT/PATCH/DELETE) verifica che
 * Origin header sia presente E matchi una origin allowlistata.
 *
 * SameSite=Lax sui cookie blocca CSRF cross-origin form-based ma:
 *  - NON protegge contro malicious subdomain (cookie con Domain=.example.com)
 *  - NON protegge contro fetch da tab interno con stessa eTLD+1
 *
 * Origin check fa fail-closed: senza Origin valido → 403.
 *
 * Skip per:
 *  - GET/HEAD/OPTIONS (read-only, no state change)
 *  - Origin == undefined && Referer == undefined (es. mobile native app via
 *    Bearer token — niente cookie, no CSRF rischio)
 */

import type { Context, Next } from 'hono';

export interface OriginCsrfOpts {
  /** Origini ammesse (es. ["https://flowforge.automazionezeli.com", "https://acme.app..."]). */
  allowedOrigins: string[];
  /** Allow regex (per wildcard `*.app.automazionezeli.com`). */
  allowedOriginPatterns?: RegExp[];
  /** Skip paths (es. /api/v1/internal/*). */
  skipPaths?: RegExp[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function originCsrf(opts: OriginCsrfOpts) {
  const allowed = new Set(opts.allowedOrigins);
  const patterns = opts.allowedOriginPatterns ?? [];
  const skip = opts.skipPaths ?? [];
  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method.toUpperCase();
    if (SAFE_METHODS.has(method)) return next();
    if (skip.some((re) => re.test(c.req.path))) return next();

    const origin = c.req.header('origin');
    const referer = c.req.header('referer');
    // Bearer auth (mobile/CLI) → no cookie sent, no CSRF risk. Skip se non
    // c'e\` ne\` Origin ne\` cookie ff_session/__Host-ff_session.
    // FIX 2026-05-29: dual-name post __Host- migration — pre-fix il check
    // matchava SOLO `ff_session=` quindi i client con il nuovo cookie
    // `__Host-ff_session=` bypassavano il CSRF gate erroneamente (NO-op).
    const cookieHeader = c.req.header('cookie') ?? '';
    const hasCookie = cookieHeader.includes('__Host-ff_session=') || cookieHeader.includes('ff_session=');
    if (!origin && !referer && !hasCookie) return next();

    const candidate = origin ?? (referer ? new URL(referer).origin : '');
    if (!candidate) {
      return c.json({ error: 'CSRF: Origin/Referer required' }, 403);
    }
    if (!allowed.has(candidate) && !patterns.some((re) => re.test(candidate))) {
      return c.json({ error: `CSRF: Origin ${candidate} not allowed` }, 403);
    }
    return next();
  };
}
