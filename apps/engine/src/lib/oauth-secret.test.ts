/**
 * Test — lib/oauth-secret (envelope client_secret OAuth).
 *
 * Bug-bounty: round-trip, tamper (authTag), legacy plaintext passthrough,
 * e la garanzia che il plaintext NON compaia mai nei campi cifrati.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// Master di test stabile (kek random fisso per-file) → round-trip deterministico
// senza dipendere dal file master.key / env del runtime reale.
const testMaster = { kek: randomBytes(32), salt: randomBytes(16) };
vi.mock('@/services/credentials.service.js', () => ({ loadMaster: () => testMaster }));

import { encryptClientSecret, decryptClientSecret, resolveClientSecret } from './oauth-secret.js';

describe('oauth-secret — envelope AES-256-GCM del client_secret', () => {
  it('🟢 round-trip: decrypt(encrypt(x)) === x', () => {
    const cipher = encryptClientSecret('gho_TopSecret_42');
    expect(cipher.ciphertext).toBeTruthy();
    expect(cipher.dekCiphertext).toBeTruthy();
    expect(decryptClientSecret(cipher)).toBe('gho_TopSecret_42');
  });

  it('🔴 il plaintext NON compare nei campi cifrati', () => {
    const cipher = encryptClientSecret('UNIQUE_MARKER_9988');
    expect(JSON.stringify(cipher)).not.toContain('UNIQUE_MARKER_9988');
  });

  it('🔴 tamper del ciphertext → throw (authTag GCM)', () => {
    const cipher = encryptClientSecret('x');
    const tampered = { ...cipher, ciphertext: Buffer.from('evil-bytes').toString('base64') };
    expect(() => decryptClientSecret(tampered)).toThrow();
  });

  it('resolveClientSecret: record CIFRATO → decifra', () => {
    const c = encryptClientSecret('sekret-value');
    expect(resolveClientSecret({
      client_secret: '',
      client_secret_ciphertext: c.ciphertext,
      client_secret_nonce: c.nonce,
      client_secret_auth_tag: c.authTag,
      client_secret_dek_ciphertext: c.dekCiphertext,
      client_secret_dek_nonce: c.dekNonce,
      client_secret_dek_auth_tag: c.dekAuthTag,
    })).toBe('sekret-value');
  });

  it('resolveClientSecret: record LEGACY (solo plaintext) → as-is (backward-compat)', () => {
    expect(resolveClientSecret({ client_secret: 'legacy-plain' })).toBe('legacy-plain');
  });

  it('resolveClientSecret: cipher PARZIALE (manca un campo) → legacy fallback, non decifra a metà', () => {
    const c = encryptClientSecret('y');
    // manca dek_auth_tag → non sono presenti tutti i 6 → fallback al plaintext.
    expect(resolveClientSecret({
      client_secret: 'fallback',
      client_secret_ciphertext: c.ciphertext,
      client_secret_nonce: c.nonce,
      client_secret_auth_tag: c.authTag,
      client_secret_dek_ciphertext: c.dekCiphertext,
      client_secret_dek_nonce: c.dekNonce,
      client_secret_dek_auth_tag: null,
    })).toBe('fallback');
  });
});
