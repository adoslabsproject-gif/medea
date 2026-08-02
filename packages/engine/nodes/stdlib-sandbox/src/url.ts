/**
 * URL helpers — buildQuery, parseQuery, buildUrl, parseUrl, joinUrl.
 *
 * Pure JS — NO URL/URLSearchParams (non disponibili in isolated-vm bare).
 * encodeURIComponent + decodeURIComponent SONO disponibili (ECMAScript core).
 *
 * @module sandbox/url
 */

function enc(s: string): string {
  // application/x-www-form-urlencoded usa '+' per spazi (non %20)
  return encodeURIComponent(s).replace(/%20/g, '+');
}

function dec(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, '%20'));
}

/** Build query string da object. Skip undefined/null. */
export function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined && item !== null) parts.push(`${enc(k)}=${enc(String(item))}`);
      }
    } else {
      const vs =
        typeof v === 'string'
          ? v
          : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint'
            ? String(v)
            : (JSON.stringify(v) ?? '');
      parts.push(`${enc(k)}=${enc(vs)}`);
    }
  }
  return parts.join('&');
}

/** Parse query string → object (singolo + multi via array). */
export function parseQuery(qs: string): Record<string, string | string[]> {
  const cleaned = qs.startsWith('?') ? qs.slice(1) : qs;
  if (cleaned.length === 0) return {};
  const out: Record<string, string | string[]> = {};
  for (const pair of cleaned.split('&')) {
    if (pair.length === 0) continue;
    const eqIdx = pair.indexOf('=');
    const k = eqIdx >= 0 ? dec(pair.slice(0, eqIdx)) : dec(pair);
    const v = eqIdx >= 0 ? dec(pair.slice(eqIdx + 1)) : '';
    if (k in out) {
      const existing = out[k]!;
      out[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Build URL: base + query. */
export function buildUrl(base: string, query: Record<string, unknown> = {}): string {
  const qs = buildQuery(query);
  if (!qs) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${qs}`;
}

/** Parse URL — restituisce { protocol, host, port, path, query, hash }. */
export function parseUrl(url: string): {
  protocol: string;
  host: string;
  port: string;
  path: string;
  query: Record<string, string | string[]>;
  hash: string;
} {
  // Regex RFC 3986-ish: scheme://[user:pass@]host[:port]/path?query#hash
  const m =
    /^([a-z][a-z0-9+\-.]*:)\/\/(?:[^@/]*@)?([^:/?#]+)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(
      url,
    );
  if (!m) throw new Error(`Invalid URL: ${url}`);
  const portPart = m[3] ?? '';
  return {
    protocol: m[1] ?? '',
    host: portPart ? `${m[2]}:${portPart}` : (m[2] ?? ''),
    port: portPart,
    path: m[4] ?? '',
    query: parseQuery(m[5] ?? ''),
    hash: m[6] !== undefined ? `#${m[6]}` : '',
  };
}

/** Quick join base + path safely (handles trailing/leading slash). */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}
