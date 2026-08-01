/**
 * Estrazione del session JWT da una richiesta di upgrade WebSocket.
 *
 * Perché esiste (audit 2026-06-15): i WS del runtime (LSP custom-node, y-collab)
 * autenticavano SOLO via `?token=` query. Ma dopo #203 P0-4 il bootstrap
 * dell'editor NON espone più il token a JS (cookie HttpOnly `ff_session`) →
 * il client non aveva alcun token da passare → il WS veniva chiuso `1008` e la
 * feature (es. LSP TypeScript) restava MORTA. Inoltre il token in URL è un leak
 * noto (finisce in nginx access log / history / Referer).
 *
 * Fix: prima il COOKIE HttpOnly (same-origin, mai in URL/log), poi `?token=`
 * come fallback (dev / client non-browser). Stesso vocabolario cookie del
 * middleware HTTP (`middleware/auth.ts`): `__Host-ff_session` (prod) → `ff_session`.
 *
 * @module lib/ws-auth
 */
import type { IncomingMessage } from 'node:http';

/** Nomi cookie sessione, in ordine di priorità (prod → legacy/dev). */
const SESSION_COOKIE_NAMES = ['__Host-ff_session', 'ff_session'] as const;

/** Legge un cookie per nome dall'header `Cookie` grezzo. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const seg of cookieHeader.split(';')) {
    const trimmed = seg.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const raw = trimmed.slice(name.length + 1);
      if (!raw) return null;
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return null;
}

/**
 * Risolve il session token per un upgrade WS.
 * Priorità: cookie HttpOnly (`__Host-ff_session` → `ff_session`) poi `?token=`.
 * Ritorna null se nessuna fonte è presente.
 */
export function extractWsSessionToken(request: Pick<IncomingMessage, 'headers' | 'url'>): string | null {
  const cookieHeader = request.headers.cookie;
  for (const name of SESSION_COOKIE_NAMES) {
    const fromCookie = readCookie(cookieHeader, name);
    if (fromCookie) return fromCookie;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch { /* URL malformata → nessun token query */ }
  return null;
}
