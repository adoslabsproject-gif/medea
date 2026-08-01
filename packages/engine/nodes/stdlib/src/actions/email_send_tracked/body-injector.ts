/**
 * Body injector — pure functions for tracking pixel + link rewriting.
 *
 * Why pure
 * ────────
 * The executor in `apps/flowforge-runtime` wires nodemailer + OAuth +
 * DB. The body transformation, however, must be testable in isolation:
 *
 *  - it touches HTML (regex / string ops error-prone),
 *  - it embeds HMAC tokens (security-critical),
 *  - it must NEVER break a working email layout.
 *
 * Keeping the transform pure means every edge case (no <html>, no
 * links, malformed href, mailto: links, anchor #links, javascript:
 * links) is covered by a unit test, not by a workflow run.
 *
 * @module actions/email_send_tracked/body-injector
 */

// 2026-06-05: NIENTE top-level `import 'node:crypto'` (server-only).
// Stessa convenzione di legal-archive.ts e email-tracking-token.ts:
// stdlib viene importato dall'editor browser via barrel index.ts —
// un import top-level lo trascina nel bundle Vite e Rollup fallisce con
// "node:crypto not externalized". Lazy-import + funzioni async.
type CryptoModule = typeof import('node:crypto');
let _crypto: CryptoModule | null = null;
async function nodeCrypto(): Promise<CryptoModule> {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` intenzionale per fallback su empty string/zero/false (non solo null/undefined)
  if (!_crypto) _crypto = await import('node:crypto');
  return _crypto;
}
import { signTrackingToken } from '../../lib/email-tracking-token.js';

export interface InjectArgs {
  /** HTML body provided by the workflow author. May or may not include <html>/<body>. */
  html: string;
  workspaceId: string;
  leadId: string;
  campaignId: string;
  /** Caller-supplied or auto-generated sendId (we pass through). */
  sendId: string;
  trackOpens: boolean;
  trackClicks: boolean;
  /** Public base of the runtime (no trailing slash, including https://). */
  trackingBaseUrl: string;
  /**
   * Whitelist of host suffixes for click rewriting. `['*']` or `[]`
   * have explicit meanings — see `shouldRewrite()`.
   */
  clickWhitelist: string[];
  /** Shared HMAC secret. */
  secret: string;
}

export interface InjectResult {
  html: string;
  pixelUrl: string | null;
  /** Open token (one per email — the pixel is single). */
  openToken: string | null;
  /**
   * Click tokens, indexed by ordinal position in body (0…N-1).
   * Used by the run inspector to show "which links were tracked".
   */
  clickTokens: string[];
}

/**
 * Inject the open pixel + rewrite <a href> for click tracking.
 *
 * Determinism: we do NOT call Date.now() here — the caller provides the
 * sendId, and `signTrackingToken` is sandboxed to a single timestamp.
 * That keeps the test outputs stable.
 */
export async function injectTracking(args: InjectArgs): Promise<InjectResult> {
  let { html } = args;
  let pixelUrl: string | null = null;
  let openToken: string | null = null;
  const clickTokens: string[] = [];

  // ── Click rewriting (first, so we don't accidentally rewrite the pixel src) ──
  // String.replace SINCRONO non puo\` await dentro callback. Pattern: pre-scan
  // tutti i match per generare i token in parallelo (Promise.all), POI replace
  // sostituendo dalla mappa. Mantiene ordine + zero re-parse del DOM.
  if (args.trackClicks) {
    const linkPattern = /<a\b([^>]*?)\shref\s*=\s*("([^"]*)"|'([^']*)')/gi;
    interface Match { full: string; beforeHref: string; href: string; dq: string | undefined; }
    const matches: Match[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkPattern.exec(html)) !== null) {
      const dq = m[3];
      const sq = m[4];
      const href = dq ?? sq ?? '';
      matches.push({ full: m[0], beforeHref: m[1] ?? '', href, dq });
    }
    // Genera token in parallelo SOLO per i link da riscrivere. Mantiene
    // indice ordinale per analytics (`i: 0` = primo link cliccabile, ecc).
    const eligible: { match: Match; idx: number }[] = [];
    for (const match of matches) {
      if (!shouldRewrite(match.href, args.trackingBaseUrl, args.clickWhitelist)) continue;
      eligible.push({ match, idx: eligible.length });
    }
    const signed = await Promise.all(
      eligible.map(({ match, idx }) =>
        signTrackingToken({
          w: args.workspaceId,
          l: args.leadId,
          c: args.campaignId,
          s: args.sendId,
          k: 'click',
          i: idx,
        }, args.secret).then((s) => ({ match, idx, token: s.token })),
      ),
    );
    // Build replacement map per full-string-match (univoco grazie a href + ordine).
    const replacements = new Map<string, string>();
    for (const { match, token } of signed) {
      clickTokens.push(token);
      const tracked = `${args.trackingBaseUrl.replace(/\/$/, '')}/api/track/click/${token}?u=${encodeURIComponent(match.href)}`;
      const quote = match.dq !== undefined ? '"' : "'";
      replacements.set(match.full, `<a${match.beforeHref} href=${quote}${tracked}${quote}`);
    }
    // Replace solo i match che abbiamo sostituito (gli altri restano invariati).
    if (replacements.size > 0) {
      html = html.replace(linkPattern, (full) => replacements.get(full) ?? full);
    }
  }

  // ── Open pixel ──
  if (args.trackOpens) {
    const signedOpen = await signTrackingToken({
      w: args.workspaceId,
      l: args.leadId,
      c: args.campaignId,
      s: args.sendId,
      k: 'open',
    }, args.secret);
    openToken = signedOpen.token;
    pixelUrl = `${args.trackingBaseUrl.replace(/\/$/, '')}/api/track/open/${signedOpen.token}`;
    const pixelTag = `<img src="${pixelUrl}" alt="" width="1" height="1" border="0" style="height:1px;width:1px;border:0;display:block;outline:none;text-decoration:none">`;
    // Append just before </body> when present, otherwise at the end.
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${pixelTag}</body>`);
    } else {
      html = html + pixelTag;
    }
  }

  return { html, pixelUrl, openToken, clickTokens };
}

/**
 * Decide whether a given href should be wrapped by the click tracker.
 *
 * Rules
 * ─────
 *  1. NEVER wrap mailto:, tel:, sms:, javascript:, anchor (#), data:
 *     — they don't make sense as redirects, and javascript:/data: in a
 *     redirect chain would be a CRITICAL open-redirect to script
 *     execution.
 *  2. NEVER wrap our OWN tracking base URL — would cause infinite
 *     redirect loop.
 *  3. If whitelist contains '*' → wrap any http(s) URL.
 *  4. If whitelist is empty → wrap only links whose host matches the
 *     trackingBaseUrl host (least-privilege default).
 *  5. Otherwise wrap iff the URL host endsWith one of the whitelist
 *     entries.
 */
export function shouldRewrite(
  href: string,
  trackingBaseUrl: string,
  whitelist: string[],
): boolean {
  if (!href) return false;
  const lower = href.toLowerCase().trim();
  if (lower.startsWith('mailto:')) return false;
  if (lower.startsWith('tel:')) return false;
  if (lower.startsWith('sms:')) return false;
  if (lower.startsWith('javascript:')) return false;
  if (lower.startsWith('data:')) return false;
  if (lower.startsWith('#')) return false;

  // Resolve relative URLs against the tracking base (gives them a host).
  let target: URL;
  try {
    target = new URL(href, trackingBaseUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;

  // Don't double-wrap an already-tracking URL.
  let base: URL;
  try {
    base = new URL(trackingBaseUrl);
  } catch {
    return false;
  }
  if (target.host === base.host && target.pathname.startsWith('/api/track/')) return false;

  if (whitelist.includes('*')) return true;
  if (whitelist.length === 0) {
    return target.host === base.host;
  }
  const host = target.host.toLowerCase();
  return whitelist.some((entry) => {
    const e = entry.toLowerCase().trim();
    if (!e) return false;
    return host === e || host.endsWith('.' + e);
  });
}

/**
 * Stable UUID-v4 helper used when the workflow author omits sendId.
 * Async per lazy `node:crypto` (vedi commento in cima al modulo).
 */
export async function newSendId(): Promise<string> {
  const { randomUUID } = await nodeCrypto();
  return randomUUID();
}
