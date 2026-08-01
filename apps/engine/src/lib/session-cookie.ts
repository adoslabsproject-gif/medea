/**
 * Session cookie helper runtime tenant — `__Host-` prefix migration.
 *
 * Mirror del portal helper apps/portal/src/lib/session-cookie.ts.
 * Stesso comportamento: WRITE primary, READ dual-name fallback,
 * DELETE entrambi.
 *
 * In prod (HTTPS) → cookie name `__Host-ff_session` (browser enforce
 * Secure + Path=/ + no Domain).
 * In dev (HTTP localhost) → `ff_session` (perche\` `__Host-` richiede Secure).
 */

export const SESSION_COOKIE_LEGACY = 'ff_session';
export const SESSION_COOKIE_HOST = '__Host-ff_session';

/** Nome cookie da usare per WRITE. */
export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? SESSION_COOKIE_HOST
    : SESSION_COOKIE_LEGACY;
}

/**
 * Parse manuale del cookie header per casi off-Hono (WebSocket
 * `request.headers.cookie`, raw HTTP). Fallback dual-name:
 *   1. `__Host-ff_session` (preferred)
 *   2. `ff_session`        (legacy fallback durante migration)
 */
export function parseSessionFromCookieHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  for (const name of [SESSION_COOKIE_HOST, SESSION_COOKIE_LEGACY]) {
    const m = new RegExp(`(?:^|; )${escapeRegex(name)}=([^;]+)`).exec(raw);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
