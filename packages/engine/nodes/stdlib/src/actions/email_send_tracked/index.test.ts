/**
 * `action_email_send_tracked` — tests.
 *
 * Coverage:
 *  - Schema: required fields, defaults, body length cap, GDPR flag
 *  - body-injector: pixel placement, link rewriting, whitelist behaviour,
 *    mailto/tel/javascript exclusion, anchor exclusion, idempotent
 *    re-injection rejection (no double-wrap), quote-style preservation
 *  - NodeDef: id, type, all UI fields present with help text
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  emailSendTrackedNode,
  emailSendTrackedNodeDef,
  EmailSendTrackedConfigSchema,
} from './index.js';
import { injectTracking, shouldRewrite } from './body-injector.js';
import { verifyTrackingToken } from '../../lib/email-tracking-token.js';

const SECRET = 'b'.repeat(64);
const BASE = 'https://fabio-musicco.app.automazionezeli.com';

const baseInject = {
  workspaceId: 'ws-1',
  leadId: 'lead-42',
  campaignId: 'redivivo-w23',
  sendId: 'send-uuid-1',
  trackOpens: true,
  trackClicks: true,
  trackingBaseUrl: BASE,
  clickWhitelist: ['redivivogin.it'],
  secret: SECRET,
} as const;

// ════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════
describe('EmailSendTrackedConfigSchema', () => {
  const valid = {
    to: 'mario@enoteca.it',
    subject: 'Redivivo Gin',
    body: '<p>Ciao Mario</p>',
    leadId: 'lead-1',
    campaignId: 'redivivo-w23',
  };

  it('parses minimal valid config', () => {
    const r = EmailSendTrackedConfigSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it('defaults trackOpens=true, trackClicks=true, requireConsent=true', () => {
    const r = EmailSendTrackedConfigSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.trackOpens).toBe(true);
      expect(r.data.trackClicks).toBe(true);
      expect(r.data.requireConsent).toBe(true);
    }
  });

  it('rejects missing leadId (would break tracking)', () => {
    const { leadId: _omit, ...rest } = valid;
    const r = EmailSendTrackedConfigSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects missing campaignId', () => {
    const { campaignId: _omit, ...rest } = valid;
    const r = EmailSendTrackedConfigSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects empty body', () => {
    const r = EmailSendTrackedConfigSchema.safeParse({ ...valid, body: '' });
    expect(r.success).toBe(false);
  });

  it('rejects body > 500k chars', () => {
    const r = EmailSendTrackedConfigSchema.safeParse({ ...valid, body: 'x'.repeat(500_001) });
    expect(r.success).toBe(false);
  });

  it('rejects subject > 998 chars (RFC limit)', () => {
    const r = EmailSendTrackedConfigSchema.safeParse({ ...valid, subject: 'x'.repeat(999) });
    expect(r.success).toBe(false);
  });

  it('accepts sampleRate in [0,1]', () => {
    expect(EmailSendTrackedConfigSchema.safeParse({ ...valid, sampleRate: 0.5 }).success).toBe(
      true,
    );
    expect(EmailSendTrackedConfigSchema.safeParse({ ...valid, sampleRate: 0 }).success).toBe(true);
    expect(EmailSendTrackedConfigSchema.safeParse({ ...valid, sampleRate: 1 }).success).toBe(true);
    expect(EmailSendTrackedConfigSchema.safeParse({ ...valid, sampleRate: 1.5 }).success).toBe(
      false,
    );
    expect(EmailSendTrackedConfigSchema.safeParse({ ...valid, sampleRate: -0.1 }).success).toBe(
      false,
    );
  });

  it('coerces string "true"/"false" for boolean fields', () => {
    const r = EmailSendTrackedConfigSchema.safeParse({
      ...valid,
      trackOpens: 'false',
      requireConsent: 'false',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.trackOpens).toBe(false);
      expect(r.data.requireConsent).toBe(false);
    }
  });

  it('accepts URLs in trackingBaseUrl, rejects non-URLs', () => {
    expect(
      EmailSendTrackedConfigSchema.safeParse({ ...valid, trackingBaseUrl: 'https://x.com' })
        .success,
    ).toBe(true);
    expect(
      EmailSendTrackedConfigSchema.safeParse({ ...valid, trackingBaseUrl: 'not a url' }).success,
    ).toBe(false);
  });

  it('passthrough preserves unknown fields (forward-compat)', () => {
    const r = EmailSendTrackedConfigSchema.safeParse({ ...valid, futureKnob: 42 });
    expect(r.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// BODY INJECTOR — pixel placement
// ════════════════════════════════════════════════════════════════════
describe('injectTracking — pixel placement', () => {
  it('appends pixel just before </body> when present', async () => {
    const out = await injectTracking({
      ...baseInject,
      html: '<html><body><p>Ciao</p></body></html>',
    });
    expect(out.html).toMatch(/<img[^>]*src="https:[^"]*\/api\/track\/open\/[^"]+"[^>]*><\/body>/);
    expect(out.pixelUrl).toMatch(
      /^https:\/\/fabio-musicco\.app\.automazionezeli\.com\/api\/track\/open\//,
    );
  });

  it('appends pixel at end when no </body>', async () => {
    const out = await injectTracking({ ...baseInject, html: '<p>plain fragment</p>' });
    expect(out.html.endsWith('></p>') || out.html.includes('<img')).toBe(true);
    expect(out.html).toMatch(/<img[^>]*src="https:[^"]*\/api\/track\/open\//);
  });

  it('omits pixel when trackOpens=false', async () => {
    const out = await injectTracking({ ...baseInject, trackOpens: false, html: '<p>x</p>' });
    expect(out.html).not.toContain('<img');
    expect(out.pixelUrl).toBeNull();
    expect(out.openToken).toBeNull();
  });

  it('open token round-trips through verify with kind=open', async () => {
    const out = await injectTracking({ ...baseInject, html: '<p>x</p>' });
    const v = await verifyTrackingToken(out.openToken!, SECRET, { expectedKind: 'open' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.l).toBe('lead-42');
      expect(v.payload.c).toBe('redivivo-w23');
      expect(v.payload.s).toBe('send-uuid-1');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// BODY INJECTOR — click rewriting
// ════════════════════════════════════════════════════════════════════
describe('injectTracking — click rewriting', () => {
  it('rewrites an http(s) link whose host matches whitelist', async () => {
    const out = await injectTracking({
      ...baseInject,
      html: '<a href="https://redivivogin.it/catalog">Catalogo</a>',
    });
    expect(out.html).toContain('/api/track/click/');
    expect(out.html).toContain(encodeURIComponent('https://redivivogin.it/catalog'));
    expect(out.clickTokens).toHaveLength(1);
  });

  it('leaves non-whitelisted links alone', async () => {
    const out = await injectTracking({
      ...baseInject,
      html: '<a href="https://attacker.com/phish">Click</a>',
    });
    expect(out.html).toContain('href="https://attacker.com/phish"');
    expect(out.html).not.toContain('/api/track/click/');
    expect(out.clickTokens).toHaveLength(0);
  });

  it('whitelist="*" wraps any http(s) link', async () => {
    const out = await injectTracking({
      ...baseInject,
      clickWhitelist: ['*'],
      html: '<a href="https://example.com/foo">x</a>',
    });
    expect(out.html).toContain('/api/track/click/');
  });

  it('empty whitelist wraps only same-host as trackingBaseUrl', async () => {
    const out = await injectTracking({
      ...baseInject,
      clickWhitelist: [],
      html: '<a href="https://fabio-musicco.app.automazionezeli.com/promo">x</a><a href="https://other.com/y">y</a>',
    });
    expect(out.html.match(/\/api\/track\/click\//g) ?? []).toHaveLength(1);
  });

  it('does NOT wrap mailto / tel / sms / javascript / data / anchor', async () => {
    const out = await injectTracking({
      ...baseInject,
      clickWhitelist: ['*'],
      html:
        '<a href="mailto:x@y.it">m</a>' +
        '<a href="tel:+39123">t</a>' +
        '<a href="sms:+39123">s</a>' +
        '<a href="javascript:alert(1)">js</a>' +
        '<a href="data:text/html,evil">d</a>' +
        '<a href="#section">a</a>',
    });
    expect(out.html).not.toContain('/api/track/click/');
    expect(out.clickTokens).toHaveLength(0);
  });

  it('preserves single-quote href style', async () => {
    const out = await injectTracking({
      ...baseInject,
      clickWhitelist: ['*'],
      html: "<a href='https://redivivogin.it/x'>x</a>",
    });
    expect(out.html).toMatch(/<a\s+href='[^']*\/api\/track\/click\/[^']+'/);
  });

  it('handles multiple links and assigns increasing link index', async () => {
    const out = await injectTracking({
      ...baseInject,
      clickWhitelist: ['*'],
      html: '<a href="https://a.com/1">a</a><a href="https://b.com/2">b</a>',
    });
    expect(out.clickTokens).toHaveLength(2);
    const v0 = await verifyTrackingToken(out.clickTokens[0]!, SECRET, { expectedKind: 'click' });
    const v1 = await verifyTrackingToken(out.clickTokens[1]!, SECRET, { expectedKind: 'click' });
    expect(v0.ok && v0.payload.i).toBe(0);
    expect(v1.ok && v1.payload.i).toBe(1);
  });

  it('does NOT wrap a link already pointing to /api/track/click (no infinite loop)', async () => {
    const out = await injectTracking({
      ...baseInject,
      clickWhitelist: ['*'],
      html: `<a href="${BASE}/api/track/click/abc.def">x</a>`,
    });
    expect(out.html.match(/\/api\/track\/click\//g) ?? []).toHaveLength(1);
    expect(out.clickTokens).toHaveLength(0);
  });

  it('omits all rewriting when trackClicks=false', async () => {
    const out = await injectTracking({
      ...baseInject,
      trackClicks: false,
      clickWhitelist: ['*'],
      html: '<a href="https://x.com/y">link</a>',
    });
    expect(out.html).toContain('href="https://x.com/y"');
    expect(out.html).not.toContain('/api/track/click/');
    expect(out.clickTokens).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// shouldRewrite — edge cases on the predicate itself
// ════════════════════════════════════════════════════════════════════
describe('shouldRewrite', () => {
  it('rejects malformed URL', () => {
    // `http://[unclosed-bracket` cannot be parsed by WHATWG URL even with
    // a base, so the constructor throws and we return false (safe).
    expect(shouldRewrite('http://[unclosed', BASE, ['*'])).toBe(false);
  });
  it('rejects ftp://', () => {
    expect(shouldRewrite('ftp://files.example.com/x', BASE, ['*'])).toBe(false);
  });
  it('subdomain endsWith match works', () => {
    expect(shouldRewrite('https://sub.redivivogin.it/x', BASE, ['redivivogin.it'])).toBe(true);
  });
  it('exact-host match works', () => {
    expect(shouldRewrite('https://redivivogin.it', BASE, ['redivivogin.it'])).toBe(true);
  });
  it('case-insensitive', () => {
    expect(shouldRewrite('https://REDIVIVOGIN.IT/x', BASE, ['redivivogin.it'])).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// NODEDEF — UI contract
// ════════════════════════════════════════════════════════════════════
describe('NodeDef contract', () => {
  it('has the stable id and type', () => {
    expect(emailSendTrackedNodeDef.id).toBe('action_email_send_tracked');
    expect(emailSendTrackedNodeDef.type).toBe('action');
  });

  it('exposes a NodeModule with the def attached', () => {
    expect(emailSendTrackedNode.def).toBe(emailSendTrackedNodeDef);
  });

  it('all configFields carry a help line (a-prova-di-idiota requirement)', () => {
    const fields = emailSendTrackedNodeDef.configFields ?? [];
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) {
      expect(typeof f.help).toBe('string');
      expect(f.help!.length).toBeGreaterThan(20);
    }
  });

  it('declares the critical required fields', () => {
    const required = new Set(
      (emailSendTrackedNodeDef.configFields ?? []).filter((f) => f.required).map((f) => f.key),
    );
    expect(required).toContain('to');
    expect(required).toContain('subject');
    expect(required).toContain('body');
    expect(required).toContain('leadId');
    expect(required).toContain('campaignId');
  });

  it('SMTP-detail fields are showIf-gated on systemAccountId=""', () => {
    const fields = emailSendTrackedNodeDef.configFields ?? [];
    const gated = ['host', 'port', 'security', 'username', 'password'];
    for (const key of gated) {
      const f = fields.find((x) => x.key === key);
      expect(f, `field ${key} missing`).toBeDefined();
      expect(f!.showIf).toBeDefined();
    }
  });
});
