import { describe, it, expect } from 'vitest';
import { createVaultSalt, deriveKek, encryptSecret, decryptSecret, rotateMaster, verifyMaster } from './index.js';

describe('secrets vault (AES-256-GCM envelope)', () => {
  it('roundtrips a secret', () => {
    const salt = createVaultSalt();
    const kek = deriveKek('correct-horse-battery-staple', salt);
    const master = { kek, salt };

    const enc = encryptSecret(
      { id: 's1', tenantId: 'default', name: 'STRIPE_KEY', provider: 'stripe', plaintext: 'sk_live_abc' },
      master,
    );
    expect(enc.ciphertext).not.toBe('sk_live_abc');
    expect(enc.dekCiphertext.length).toBeGreaterThan(0);

    const plain = decryptSecret(enc, master);
    expect(plain).toBe('sk_live_abc');
  });

  it('rejects passwords under 12 chars', () => {
    const salt = createVaultSalt();
    expect(() => deriveKek('short', salt)).toThrow(/12 characters/);
  });

  it('master rotation rewraps DEK without re-encrypting data', () => {
    const salt1 = createVaultSalt();
    const salt2 = createVaultSalt();
    const m1 = { kek: deriveKek('first-password-strong', salt1), salt: salt1 };
    const m2 = { kek: deriveKek('second-password-strong', salt2), salt: salt2 };

    const enc = encryptSecret(
      { id: 's2', tenantId: 'default', name: 'PEC_PASS', provider: 'pec-aruba', plaintext: 'segretissimo' },
      m1,
    );
    const dataCipherBefore = enc.ciphertext;
    const dekCipherBefore = enc.dekCiphertext;

    const rotated = rotateMaster(enc, m1, m2);
    expect(rotated.ciphertext).toBe(dataCipherBefore);
    expect(rotated.dekCiphertext).not.toBe(dekCipherBefore);

    expect(decryptSecret(rotated, m2)).toBe('segretissimo');
    expect(() => decryptSecret(rotated, m1)).toThrow();
  });

  it('verifyMaster is constant-time', () => {
    const s = createVaultSalt();
    const k1 = deriveKek('correct-horse-battery', s);
    const k2 = deriveKek('correct-horse-battery', s);
    const k3 = deriveKek('different-horse-battery', s);
    expect(verifyMaster(k1, k2)).toBe(true);
    expect(verifyMaster(k1, k3)).toBe(false);
  });

  it('tampered ciphertext detected via AEAD authTag', () => {
    const salt = createVaultSalt();
    const master = { kek: deriveKek('correct-horse-battery', salt), salt };
    const enc = encryptSecret(
      { id: 's3', tenantId: 'default', name: 'OAI_KEY', provider: 'openai', plaintext: 'sk-12345' },
      master,
    );
    const tampered = { ...enc, ciphertext: Buffer.from('XXXXX').toString('base64') };
    expect(() => decryptSecret(tampered, master)).toThrow();
  });
});

describe('N14 audit — scrypt parametri OWASP 2023', () => {
  // Verify via source inspection: KEK_SCRYPT_N = 131_072 (2^17) +
  // maxmem 256 MB. Test funzionale (deriveKek + roundtrip) gia\` coperto
  // sopra; questo regression test impedisce downgrade silente del cost
  // factor in futuro (security regression).
  it('source dichiara KEK_SCRYPT_N = 131_072 (OWASP 2023)', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(join(here, 'index.ts'), 'utf-8');
    expect(src).toMatch(/KEK_SCRYPT_N\s*=\s*131_072/);
    expect(src).toMatch(/KEK_SCRYPT_MAXMEM\s*=\s*256\s*\*\s*1024\s*\*\s*1024/);
    expect(src).toMatch(/N:\s*KEK_SCRYPT_N/);
    expect(src).toMatch(/maxmem:\s*KEK_SCRYPT_MAXMEM/);
    expect(src).toMatch(/r:\s*8,\s*p:\s*1/);
  });
});
