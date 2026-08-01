/**
 * Email-tracking signed tokens — sign + verify.
 *
 * Design
 * ──────
 * We need a token that piggybacks on every email pixel + click URL and
 * encodes the (workspace, lead, campaign, sendId, kind) tuple AND is:
 *
 *   - tamper-proof  → HMAC-SHA256 over the canonical payload
 *   - short         → emails are read on devices with small URL boxes;
 *                      base64url keeps it compact (≈ 80 chars total)
 *   - opaque        → no PII in cleartext (no email, no name)
 *   - replay-bounded→ embeds issuedAt; consumers can age out tokens
 *
 * The format is a single base64url string of:
 *
 *   <b64url(payload-json)>.<b64url(hmac-sha256(secret, payload-json))>
 *
 * Both sides recompute the HMAC over the payload and compare with
 * `timingSafeEqual`. The secret is `FLOWFORGE_SSO_SECRET` (shared
 * across portal + runtime, already provisioned in every container —
 * see `apps/flowforge-runtime/src/config.ts`).
 *
 * Why HMAC + JSON, not JWT
 * ────────────────────────
 * JWT would force us to register a `kid` and a JWKS — overkill for a
 * shared-secret signed envelope. Our consumer is always the same
 * runtime that minted it; no cross-org trust to negotiate. Lean is
 * better.
 *
 * @module lib/email-tracking-token
 */

// 2026-06-05: NIENTE top-level `import 'node:crypto'` (server-only).
// Trappola coerenza Vite: stdlib e\` ri-esportato dal barrel index.ts che
// l'editor browser potrebbe pescare via tree-shaking imperfetto → Rollup
// "createHmac not exported by __vite-browser-external". Stesso pattern
// di stream_proxy/executor.ts e lib/pec/legal-archive.ts.
type CryptoModule = typeof import('node:crypto');
let _crypto: CryptoModule | null = null;
async function nodeCrypto(): Promise<CryptoModule> {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` intenzionale per fallback su empty string/zero/false (non solo null/undefined)
  if (!_crypto) _crypto = await import('node:crypto');
  return _crypto;
}
import { DEFAULT_TOKEN_TTL_SECONDS } from './email-tracking-token-constants.js';
export { DEFAULT_TOKEN_TTL_SECONDS } from './email-tracking-token-constants.js';

/** Token kind discriminates pixel-open vs link-click endpoints. */
export type EmailTrackingKind = 'open' | 'click';

export interface EmailTrackingPayload {
  /** Tenant workspace UUID. Required so the runtime can route to DB. */
  w: string;
  /** Lead row id (string/number, we keep stringified). */
  l: string;
  /** Campaign id (free-form short string identifying the email batch). */
  c: string;
  /** Send id — one per email actually delivered (dedup key). */
  s: string;
  /** Kind: 'open' (pixel GET) or 'click' (redirect GET). */
  k: EmailTrackingKind;
  /**
   * For click tokens: per-link ordinal index (0…N) within the email body.
   * Lets analytics show "users clicked the 3rd link the most".
   * Omitted for open tokens.
   */
  i?: number;
  /** Issued-at, unix seconds. Consumers may age out tokens beyond TTL. */
  t: number;
}

export interface SignedToken {
  /** The opaque string to embed in URLs (`<b64payload>.<b64sig>`). */
  token: string;
  /** Same payload back, useful for tests / debug. */
  payload: EmailTrackingPayload;
}

// `DEFAULT_TOKEN_TTL_SECONDS` lives in `./email-tracking-token-constants.ts`
// (browser-safe) and is re-exported from the top of this file.

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

/**
 * Sign a tracking payload with the shared HMAC secret.
 *
 * Returns `Promise<SignedToken>` (async) per il lazy-import di node:crypto —
 * vedi commento in cima al modulo.
 *
 * @throws never — we coerce all inputs to strings beforehand.
 */
export async function signTrackingToken(
  payload: Omit<EmailTrackingPayload, 't'> & Partial<Pick<EmailTrackingPayload, 't'>>,
  secret: string,
): Promise<SignedToken> {
  if (!secret || secret.length < 32) {
    throw new Error('email-tracking secret too short (need >=32 chars; pass FLOWFORGE_SSO_SECRET)');
  }
  const full: EmailTrackingPayload = {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
    w: String(payload.w),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
    l: String(payload.l),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
    c: String(payload.c),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
    s: String(payload.s),
    k: payload.k,
    t: payload.t ?? Math.floor(Date.now() / 1000),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
    ...(payload.i !== undefined ? { i: Number(payload.i) } : {}),
  };
  // JSON.stringify with sorted keys to keep canonical encoding stable.
  const json = canonicalJson(full);
  const payloadB64 = b64urlEncode(Buffer.from(json, 'utf8'));
  const { createHmac } = await nodeCrypto();
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = b64urlEncode(sig);
  return { token: `${payloadB64}.${sigB64}`, payload: full };
}

export interface VerifyOptions {
  /** Reject if `now - payload.t > maxAgeSeconds`. Default: 60 days. */
  maxAgeSeconds?: number;
  /** Inject the current time for tests. Default: Date.now()/1000. */
  nowSeconds?: number;
  /** When set, require payload.k === this kind. */
  expectedKind?: EmailTrackingKind;
}

export type VerifyResult =
  | { ok: true; payload: EmailTrackingPayload }
  | { ok: false; reason: VerifyFailReason };

export type VerifyFailReason =
  | 'malformed'
  | 'bad-base64'
  | 'bad-json'
  | 'sig-mismatch'
  | 'expired'
  | 'kind-mismatch';

/**
 * Verify an email-tracking token. Always returns a discriminated union
 * (no throws on bad input — the endpoint handlers must surface the right
 * HTTP status for each failure mode, so we keep failure cases explicit).
 *
 * Async per lazy `node:crypto` (vedi commento in cima al modulo).
 */
export async function verifyTrackingToken(
  token: string,
  secret: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (!secret || secret.length < 32) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = parts[0];
  const sigB64 = parts[1];
  let payloadJson: string;
  let givenSig: Buffer;
  try {
    payloadJson = b64urlDecode(payloadB64).toString('utf8');
    givenSig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'bad-base64' };
  }

  const { createHmac, timingSafeEqual } = await nodeCrypto();
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest();
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'sig-mismatch' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  if (!isPayload(parsed)) {
    return { ok: false, reason: 'bad-json' };
  }
  const payload = parsed;

  if (opts.expectedKind && payload.k !== opts.expectedKind) {
    return { ok: false, reason: 'kind-mismatch' };
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  if (now - payload.t > maxAge) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

function isPayload(v: unknown): v is EmailTrackingPayload {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.w !== 'string' || !o.w) return false;
  if (typeof o.l !== 'string' || !o.l) return false;
  if (typeof o.c !== 'string' || !o.c) return false;
  if (typeof o.s !== 'string' || !o.s) return false;
  if (o.k !== 'open' && o.k !== 'click') return false;
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return false;
  if (o.i !== undefined && (typeof o.i !== 'number' || !Number.isFinite(o.i))) return false;
  return true;
}

/**
 * Canonical JSON with keys sorted ASC. We choose this over JSON.stringify
 * because two payloads with the same content but different key order
 * would otherwise hash differently — surprises in production when a
 * field is added/removed.
 */
function canonicalJson(o: EmailTrackingPayload): string {
  const ordered: Record<string, unknown> = {};
  const src = o as unknown as Record<string, unknown>;
  for (const k of Object.keys(src).sort()) {
    ordered[k] = src[k];
  }
  return JSON.stringify(ordered);
}

/**
 * Bot detection helper — exposed here so both the pixel and click
 * endpoints (and tests) use the same source of truth.
 *
 * The list targets two failure modes:
 *
 *  1. **Mailbox provider pre-fetchers** — Gmail, Outlook, Yahoo pre-load
 *     image content into their cache the moment the email arrives, so a
 *     pixel hit from "GoogleImageProxy" is NOT a human reading the mail.
 *     Counting those as "opens" inflates the open-rate by 80% and
 *     ruins lead scoring.
 *  2. **Security scanners** — Office365 Safe Links, Mimecast, Proofpoint
 *     visit click URLs at delivery to score them; we want to ignore.
 *
 * Returns `true` when the User-Agent should be ignored. We err on the
 * side of *exclusion* — false negatives (real user not counted) are far
 * less damaging to scoring than false positives (bot counted as human).
 */
export function isTrackingBot(userAgent: string | undefined): boolean {
  if (!userAgent) return true;     // empty UA: treat as bot
  const ua = userAgent.toLowerCase();
  // Mailbox image pre-fetchers (open false-positive)
  if (ua.includes('googleimageproxy')) return true;
  if (ua.includes('yahoomailproxy')) return true;
  if (ua.includes('outlook') && ua.includes('image')) return true;
  // Security scanners (click false-positive)
  if (ua.includes('mimecast')) return true;
  if (ua.includes('proofpoint')) return true;
  if (ua.includes('barracuda')) return true;
  if (ua.includes('forcepoint')) return true;
  if (ua.includes('symantec')) return true;
  if (ua.includes('safelinks')) return true;  // Office365 ATP
  // Generic crawlers we never want to count
  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) return true;
  return false;
}
