import { describe, it, expect } from 'vitest';
import { generateLicenseKeyPair, issueLicense, validateLicense } from './index.js';

const SAMPLE_PAYLOAD = {
  licenseId: 'lic-001',
  tier: 'business' as const,
  seats: 25,
  customer: { name: 'Acme S.r.l.', email: 'admin@acme.it', vatId: 'IT12345678901' },
  features: ['multi-tenant', 'sso-oidc', 'marketplace'],
  issuedAt: new Date().toISOString(),
};

describe('license signing (Ed25519 / EdDSA)', () => {
  it('round-trips a valid license', async () => {
    const { privateKeyPem, publicKeyPem } = await generateLicenseKeyPair();
    const token = await issueLicense(SAMPLE_PAYLOAD, privateKeyPem);
    const result = await validateLicense(token, publicKeyPem);
    expect(result.valid).toBe(true);
    expect(result.payload?.tier).toBe('business');
    expect(result.payload?.seats).toBe(25);
  });

  it('detects expired license', async () => {
    const { privateKeyPem, publicKeyPem } = await generateLicenseKeyPair();
    const expired = await issueLicense(
      { ...SAMPLE_PAYLOAD, expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
      privateKeyPem,
    );
    const result = await validateLicense(expired, publicKeyPem);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('rejects forged signature (wrong key)', async () => {
    const k1 = await generateLicenseKeyPair();
    const k2 = await generateLicenseKeyPair();
    const token = await issueLicense(SAMPLE_PAYLOAD, k1.privateKeyPem);
    const result = await validateLicense(token, k2.publicKeyPem);
    expect(result.valid).toBe(false);
  });
});

describe('N15 audit — jwtVerify algorithms pin esplicito', () => {
  it('source dichiara algorithms: [LICENSE_ALG] (EdDSA pin)', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(join(here, 'index.ts'), 'utf-8');
    expect(src).toMatch(/algorithms:\s*\[LICENSE_ALG\]/);
  });
});
