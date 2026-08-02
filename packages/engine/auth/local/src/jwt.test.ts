import { describe, it, expect } from 'vitest';
import { generateSessionKeyPair, issueSessionToken, verifySessionToken } from './jwt.js';

describe('JWT RS256 session tokens', () => {
  it('round-trip: issue → verify', async () => {
    const { privateKeyPem, publicKeyPem } = await generateSessionKeyPair();
    const token = await issueSessionToken({
      userId: 'u-1',
      tenantId: 't-1',
      email: 'alice@example.com',
      role: 'owner',
      privateKeyPem,
    });
    const payload = await verifySessionToken(token, publicKeyPem);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('u-1');
    expect(payload?.tenantId).toBe('t-1');
    expect(payload?.role).toBe('owner');
  });

  it('emette un jti univoco (UUID v4) — fondamento della blocklist di revoca', async () => {
    const { privateKeyPem, publicKeyPem } = await generateSessionKeyPair();
    const issue = (): Promise<string> =>
      issueSessionToken({
        userId: 'u-1',
        tenantId: 't-1',
        email: 'a@b.com',
        role: 'owner',
        privateKeyPem,
      });
    const p1 = await verifySessionToken(await issue(), publicKeyPem);
    const p2 = await verifySessionToken(await issue(), publicKeyPem);
    expect(p1?.jti).toBeDefined();
    expect(p1?.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(p1?.jti).not.toBe(p2?.jti); // univoco per ogni token emesso
  });

  it('returns null on tampered token', async () => {
    const { privateKeyPem, publicKeyPem } = await generateSessionKeyPair();
    const token = await issueSessionToken({
      userId: 'u-1',
      tenantId: 't-1',
      email: 'a@b.com',
      role: 'viewer',
      privateKeyPem,
    });
    const tampered = token.slice(0, -4) + 'XXXX';
    expect(await verifySessionToken(tampered, publicKeyPem)).toBeNull();
  });

  it('returns null when verified with wrong key', async () => {
    const k1 = await generateSessionKeyPair();
    const k2 = await generateSessionKeyPair();
    const token = await issueSessionToken({
      userId: 'u',
      tenantId: 't',
      email: 'x@y.z',
      role: 'editor',
      privateKeyPem: k1.privateKeyPem,
    });
    expect(await verifySessionToken(token, k2.publicKeyPem)).toBeNull();
  });
});

describe('N15 audit — jwtVerify algorithms pin esplicito', () => {
  it('source dichiara algorithms: [ALG] (RS256 pin)', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(join(here, 'jwt.ts'), 'utf-8');
    expect(src).toMatch(/algorithms:\s*\[ALG\]/);
  });
});
