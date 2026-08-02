/**
 * Email-tracking signed tokens — exhaustive tests.
 *
 * Coverage:
 *   - sign() output shape + idempotency on identical input
 *   - verify() happy path + tamper detection on each component
 *   - expired tokens via clock injection
 *   - kind mismatch (open token used on click endpoint)
 *   - malformed inputs (empty, oversized, missing parts, garbage)
 *   - short secret rejection at sign + verify
 *   - canonical JSON: payloads with different key order hash identically
 *   - bot detection: Gmail proxy, Outlook image, Mimecast, generic crawlers
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  signTrackingToken,
  verifyTrackingToken,
  isTrackingBot,
  DEFAULT_TOKEN_TTL_SECONDS,
} from './email-tracking-token.js';

const SECRET = 'a'.repeat(64); // 64-char hex-ish, exceeds 32 min
const PAYLOAD = {
  w: '00000000-0000-0000-0000-000000000123',
  l: 'lead-9999',
  c: 'redivivo-2026-w23',
  s: 'send-abc',
  k: 'open' as const,
};

describe('signTrackingToken', () => {
  it('returns a base64url.base64url string', async () => {
    const out = await signTrackingToken(PAYLOAD, SECRET);
    expect(out.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const parts = out.token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.length).toBeGreaterThan(10);
    expect(parts[1]!.length).toBeGreaterThan(10);
  });

  it('embeds the provided fields verbatim', async () => {
    const out = await signTrackingToken({ ...PAYLOAD, t: 1_700_000_000 }, SECRET);
    expect(out.payload.w).toBe(PAYLOAD.w);
    expect(out.payload.l).toBe(PAYLOAD.l);
    expect(out.payload.c).toBe(PAYLOAD.c);
    expect(out.payload.s).toBe(PAYLOAD.s);
    expect(out.payload.k).toBe('open');
    expect(out.payload.t).toBe(1_700_000_000);
  });

  it('auto-injects current timestamp when t is omitted', async () => {
    const before = Math.floor(Date.now() / 1000);
    const out = await signTrackingToken(PAYLOAD, SECRET);
    const after = Math.floor(Date.now() / 1000);
    expect(out.payload.t).toBeGreaterThanOrEqual(before);
    expect(out.payload.t).toBeLessThanOrEqual(after);
  });

  it('coerces non-string fields to strings (defensive)', async () => {
    const out = await signTrackingToken(
      { w: 'w1', l: 42 as unknown as string, c: 'c1', s: true as unknown as string, k: 'open' },
      SECRET,
    );
    expect(out.payload.l).toBe('42');
    expect(out.payload.s).toBe('true');
  });

  it('includes optional link-index for click kind', async () => {
    const out = await signTrackingToken(
      { w: 'w', l: 'l', c: 'c', s: 's', k: 'click', i: 3 },
      SECRET,
    );
    expect(out.payload.i).toBe(3);
    const verified = await verifyTrackingToken(out.token, SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.payload.i).toBe(3);
  });

  it('rejects a too-short secret', async () => {
    await expect(signTrackingToken(PAYLOAD, 'short')).rejects.toThrow(/secret too short/);
  });

  it('is deterministic for fixed (payload, secret, t)', async () => {
    const a = await signTrackingToken({ ...PAYLOAD, t: 1700000000 }, SECRET);
    const b = await signTrackingToken({ ...PAYLOAD, t: 1700000000 }, SECRET);
    expect(a.token).toBe(b.token);
  });

  it('produces different tokens for different payload fields', async () => {
    const a = await signTrackingToken({ ...PAYLOAD, t: 1700000000, l: 'lead-A' }, SECRET);
    const b = await signTrackingToken({ ...PAYLOAD, t: 1700000000, l: 'lead-B' }, SECRET);
    expect(a.token).not.toBe(b.token);
  });
});

describe('verifyTrackingToken — happy path', () => {
  it('verifies a fresh token round-trip', async () => {
    const { token } = await signTrackingToken(PAYLOAD, SECRET);
    const v = await verifyTrackingToken(token, SECRET);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.w).toBe(PAYLOAD.w);
      expect(v.payload.k).toBe('open');
    }
  });

  it('accepts when expectedKind matches', async () => {
    const { token } = await signTrackingToken(PAYLOAD, SECRET);
    const v = await verifyTrackingToken(token, SECRET, { expectedKind: 'open' });
    expect(v.ok).toBe(true);
  });
});

describe('verifyTrackingToken — security & tamper', () => {
  it('rejects sig-mismatch when payload is altered post-sign', async () => {
    const { token } = await signTrackingToken(PAYLOAD, SECRET);
    const [, sig] = token.split('.');
    // Replace payload body with a forged one but keep original sig.
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...PAYLOAD, l: 'attacker-lead', t: 9_999_999_999 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const forged = `${forgedPayload}.${sig}`;
    const v = await verifyTrackingToken(forged, SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('sig-mismatch');
  });

  it('rejects when signed with a different secret', async () => {
    const { token } = await signTrackingToken(PAYLOAD, SECRET);
    const v = await verifyTrackingToken(token, 'b'.repeat(64));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('sig-mismatch');
  });

  it('rejects when expectedKind does not match', async () => {
    const { token } = await signTrackingToken({ ...PAYLOAD, k: 'open' }, SECRET);
    const v = await verifyTrackingToken(token, SECRET, { expectedKind: 'click' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('kind-mismatch');
  });
});

describe('verifyTrackingToken — expiry', () => {
  it('rejects tokens older than maxAgeSeconds', async () => {
    const { token } = await signTrackingToken({ ...PAYLOAD, t: 1_700_000_000 }, SECRET);
    const v = await verifyTrackingToken(token, SECRET, {
      nowSeconds: 1_700_000_000 + 200,
      maxAgeSeconds: 60,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('expired');
  });

  it('accepts tokens within default 60-day TTL', async () => {
    const { token } = await signTrackingToken({ ...PAYLOAD, t: 1_700_000_000 }, SECRET);
    const v = await verifyTrackingToken(token, SECRET, {
      nowSeconds: 1_700_000_000 + DEFAULT_TOKEN_TTL_SECONDS - 1,
    });
    expect(v.ok).toBe(true);
  });

  it('rejects tokens past default TTL', async () => {
    const { token } = await signTrackingToken({ ...PAYLOAD, t: 1_700_000_000 }, SECRET);
    const v = await verifyTrackingToken(token, SECRET, {
      nowSeconds: 1_700_000_000 + DEFAULT_TOKEN_TTL_SECONDS + 1,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('expired');
  });
});

describe('verifyTrackingToken — malformed inputs', () => {
  it.each([
    ['empty', ''],
    ['single-segment', 'abcde'],
    ['three-segments', 'a.b.c'],
    ['missing-payload', '.sig'],
    ['missing-sig', 'payload.'],
    ['oversized', 'x'.repeat(5000)],
  ])('rejects %s as malformed', async (_label, bad) => {
    const v = await verifyTrackingToken(bad, SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('malformed');
  });

  it('rejects non-string input', async () => {
    const v = await verifyTrackingToken(undefined as unknown as string, SECRET);
    expect(v.ok).toBe(false);
  });

  it('rejects when secret is too short', async () => {
    const { token } = await signTrackingToken(PAYLOAD, SECRET);
    const v = await verifyTrackingToken(token, 'short');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('malformed');
  });

  it('rejects garbage base64 in payload', async () => {
    const v = await verifyTrackingToken('***.***', SECRET);
    expect(v.ok).toBe(false);
    // Either malformed or bad-base64 — both are acceptable rejections.
    if (!v.ok) expect(['malformed', 'bad-base64', 'sig-mismatch']).toContain(v.reason);
  });

  it('rejects valid-base64 garbage JSON', async () => {
    // Build a token whose payload b64 decodes to junk text. The sig will fail
    // first (because we can't compute the right HMAC without knowing the
    // secret), so we expect either bad-json (if you happen to land on a
    // collision) or sig-mismatch — both safe rejections.
    const fakePayload = Buffer.from('not-a-json{')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const fakeSig = Buffer.from('xx')
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const v = await verifyTrackingToken(`${fakePayload}.${fakeSig}`, SECRET);
    expect(v.ok).toBe(false);
  });

  it('rejects valid-HMAC JSON that lacks required fields', async () => {
    // Hand-craft a payload with missing fields, sign it, verify.
    // Even with valid sig, the schema check (isPayload) must reject.
    const { createHmac: hmac } = await import('node:crypto');
    const incompleteJson = JSON.stringify({ w: 'x' }); // missing l, c, s, k, t
    const payloadB64 = Buffer.from(incompleteJson)
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const sig = hmac('sha256', SECRET)
      .update(payloadB64)
      .digest('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const v = await verifyTrackingToken(`${payloadB64}.${sig}`, SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad-json');
  });
});

describe('canonical JSON', () => {
  it('signs identically regardless of key insertion order', async () => {
    // sign() always re-orders keys, so two semantically identical payloads
    // produce the same token. Build them with explicit different orders.
    const orderedA = await signTrackingToken(
      { k: 'open', s: 's1', c: 'c1', l: 'l1', w: 'w1', t: 1700000000 },
      SECRET,
    );
    const orderedB = await signTrackingToken(
      { w: 'w1', l: 'l1', c: 'c1', s: 's1', k: 'open', t: 1700000000 },
      SECRET,
    );
    expect(orderedA.token).toBe(orderedB.token);
  });
});

describe('isTrackingBot', () => {
  it('treats empty UA as bot', () => {
    expect(isTrackingBot(undefined)).toBe(true);
    expect(isTrackingBot('')).toBe(true);
  });

  it('flags Gmail image proxy', () => {
    expect(isTrackingBot('Mozilla/5.0 (compatible; GoogleImageProxy)')).toBe(true);
  });

  it('flags Yahoo image proxy', () => {
    expect(isTrackingBot('YahooMailProxy/1.0')).toBe(true);
  });

  it('flags Outlook image-prefetch UA', () => {
    expect(isTrackingBot('Microsoft Outlook Image Proxy')).toBe(true);
  });

  it('flags Office365 ATP SafeLinks', () => {
    expect(isTrackingBot('SafeLinks-Pre-render-1.0')).toBe(true);
  });

  it('flags Mimecast / Proofpoint / Barracuda scanners', () => {
    expect(isTrackingBot('mimecast-scanner/2.0')).toBe(true);
    expect(isTrackingBot('Proofpoint-URL-Defense')).toBe(true);
    expect(isTrackingBot('Barracuda-Link-Protect')).toBe(true);
  });

  it('flags generic crawlers/spiders/bots', () => {
    expect(isTrackingBot('Googlebot/2.1')).toBe(true);
    expect(isTrackingBot('curl/7.0 bot')).toBe(true);
    expect(isTrackingBot('SiteCheckerSpider/1.0')).toBe(true);
    expect(isTrackingBot('ahrefs-crawler')).toBe(true);
  });

  it('does NOT flag a real Chrome on macOS', () => {
    expect(
      isTrackingBot(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
  });

  it('does NOT flag a real iPhone Safari', () => {
    expect(
      isTrackingBot(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
  });
});
