/**
 * Test HttpConfigSchema — hardening (review nodi #1):
 *  - secret tipizzati (string, non più z.unknown);
 *  - cross-field authMode↔credenziale (mode selezionato senza credenziale = errore);
 *  - default retryOnStatus allineato all'UI.
 * Bug-bounty: input rotti (mode senza cred, secret non-stringa), edge (none = nessun
 * vincolo, basic con solo password).
 */
import { describe, it, expect } from 'vitest';
import { HttpConfigSchema } from './schema.js';

const base = { url: 'https://api.example.com' };

describe('HttpConfigSchema — cross-field authMode↔credenziale', () => {
  it('🚨 authMode=bearer senza token → REJECT (path bearerToken)', () => {
    const r = HttpConfigSchema.safeParse({ ...base, authMode: 'bearer' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('bearerToken'))).toBe(true);
  });

  it('authMode=bearer con token → OK', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'bearer', bearerToken: '{{secrets.tok}}' }).success).toBe(true);
  });

  it('🚨 authMode=bearer con token SOLO spazi → REJECT (trim)', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'bearer', bearerToken: '   ' }).success).toBe(false);
  });

  it('🚨 authMode=apikey-header senza apiKeyValue → REJECT', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'apikey-header', apiKeyHeaderName: 'X-API-Key' }).success).toBe(false);
  });

  it('🚨 authMode=custom senza customAuthHeaderValue → REJECT', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'custom', customAuthHeaderName: 'X-Foo' }).success).toBe(false);
  });

  it('authMode=basic con solo password → OK (user opzionale)', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'basic', basicPass: 'pw' }).success).toBe(true);
  });

  // ── OAuth2 client_credentials (richiede tokenUrl + clientId + clientSecret)
  const oauthOk = { authMode: 'oauth2', oauth2TokenUrl: 'https://id.example.com/token', oauth2ClientId: 'cid', oauth2ClientSecret: 'sec' };

  it('authMode=oauth2 completo → OK', () => {
    expect(HttpConfigSchema.safeParse({ ...base, ...oauthOk }).success).toBe(true);
  });

  it('🚨 authMode=oauth2 senza tokenUrl → REJECT (path oauth2TokenUrl)', () => {
    const r = HttpConfigSchema.safeParse({ ...base, ...oauthOk, oauth2TokenUrl: '' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('oauth2TokenUrl'))).toBe(true);
  });

  it('🚨 authMode=oauth2 senza clientId → REJECT', () => {
    const r = HttpConfigSchema.safeParse({ ...base, ...oauthOk, oauth2ClientId: '   ' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('oauth2ClientId'))).toBe(true);
  });

  it('🚨 authMode=oauth2 senza clientSecret → REJECT', () => {
    const r = HttpConfigSchema.safeParse({ ...base, ...oauthOk, oauth2ClientSecret: undefined });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('oauth2ClientSecret'))).toBe(true);
  });

  it('oauth2AuthStyle default = header; accetta body', () => {
    const r = HttpConfigSchema.safeParse({ ...base, ...oauthOk });
    expect(r.success && r.data.oauth2AuthStyle).toBe('header');
    expect(HttpConfigSchema.safeParse({ ...base, ...oauthOk, oauth2AuthStyle: 'body' }).success).toBe(true);
    expect(HttpConfigSchema.safeParse({ ...base, ...oauthOk, oauth2AuthStyle: 'bogus' }).success).toBe(false);
  });

  it('🚨 authMode=basic senza user NÉ password → REJECT', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'basic' }).success).toBe(false);
  });

  it('authMode=none senza credenziali → OK (nessun vincolo: auth via Headers ammessa)', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'none' }).success).toBe(true);
    expect(HttpConfigSchema.safeParse(base).success).toBe(true); // default none
  });
});

describe('HttpConfigSchema — tipi + default', () => {
  it('🚨 secret non-stringa (bearerToken numerico) → REJECT (era z.unknown, ora string)', () => {
    expect(HttpConfigSchema.safeParse({ ...base, authMode: 'bearer', bearerToken: 12345 }).success).toBe(false);
  });

  it('retryOnStatus default ALLINEATO all\'UI (429,500,502,503,504)', () => {
    const r = HttpConfigSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.retryOnStatus).toBe('429,500,502,503,504');
  });

  it('headersJson accetta sia stringa JSON sia record (difensivo), non throwa', () => {
    expect(HttpConfigSchema.safeParse({ ...base, headersJson: '{"X-Foo":"bar"}' }).success).toBe(true);
    expect(HttpConfigSchema.safeParse({ ...base, headersJson: { 'X-Foo': 'bar' } }).success).toBe(true);
  });

  it('body accetta stringa, oggetto o array', () => {
    expect(HttpConfigSchema.safeParse({ ...base, body: '{"a":1}' }).success).toBe(true);
    expect(HttpConfigSchema.safeParse({ ...base, body: { a: 1 } }).success).toBe(true);
    expect(HttpConfigSchema.safeParse({ ...base, body: [1, 2, 3] }).success).toBe(true);
  });
});
