/**
 * Test secrets-crypto — cache fingerprint regression 2026-05-29.
 *
 * Pre-fix: cacheKey = `${tenantId}::${password.length}` → 2 password
 * diversi di stessa lunghezza collidevano sulla cache → uso della key
 * sbagliata per encrypt/decrypt.
 *
 * Post-fix: cacheKey usa SHA-256(password) prefix → no collisione.
 *
 * Focus invarianti:
 *  - encrypt + decrypt round-trip OK
 *  - password diversi di stessa lunghezza → key derivate diverse → decrypt
 *    di un blob A con password B FALLISCE (GCM auth tag mismatch)
 *  - tenantId diversi → key diverse anche con stessa password
 */
import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from './secrets-crypto';

const PWD_A = '0123456789abcdef0123456789abcdef'; // 32 char
const PWD_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 char (stessa lunghezza, diverso valore)
const TEN_X = 'tenant-x';
const TEN_Y = 'tenant-y';

describe('encrypt / decrypt round-trip', () => {
  it('happy: encrypt + decrypt restituisce plaintext originale', () => {
    const enc = encrypt('hello world', PWD_A, TEN_X);
    expect(decrypt(enc.ciphertext, enc.nonce, PWD_A, TEN_X)).toBe('hello world');
  });

  it('plaintext con caratteri Unicode + emoji', () => {
    const original = 'Sì 中文 🔐 пароль';
    const enc = encrypt(original, PWD_A, TEN_X);
    expect(decrypt(enc.ciphertext, enc.nonce, PWD_A, TEN_X)).toBe(original);
  });

  it('plaintext lungo (>1KB)', () => {
    const original = 'x'.repeat(2048);
    const enc = encrypt(original, PWD_A, TEN_X);
    expect(decrypt(enc.ciphertext, enc.nonce, PWD_A, TEN_X)).toBe(original);
  });
});

describe('cache fingerprint — regression 2026-05-29', () => {
  it('2 password diversi STESSA lunghezza → decrypt cross-fail', () => {
    // Pre-fix questo test FALLIVA: cache collide su `tenant::32` →
    // decrypt usava la stessa key derivata da PWD_A.
    const enc = encrypt('secret', PWD_A, TEN_X);
    expect(() => decrypt(enc.ciphertext, enc.nonce, PWD_B, TEN_X)).toThrow();
  });

  it('tenantId diversi → key diverse anche con stessa password', () => {
    const enc = encrypt('secret', PWD_A, TEN_X);
    expect(() => decrypt(enc.ciphertext, enc.nonce, PWD_A, TEN_Y)).toThrow();
  });

  it('cache HIT (stessa password + tenant): round-trip multiplo coerente', () => {
    const e1 = encrypt('msg1', PWD_A, TEN_X);
    const e2 = encrypt('msg2', PWD_A, TEN_X);
    expect(decrypt(e1.ciphertext, e1.nonce, PWD_A, TEN_X)).toBe('msg1');
    expect(decrypt(e2.ciphertext, e2.nonce, PWD_A, TEN_X)).toBe('msg2');
  });
});

describe('encrypt — input validation', () => {
  it('empty plaintext → throw', () => {
    expect(() => encrypt('', PWD_A, TEN_X)).toThrow();
  });

  it('empty masterPassword → throw', () => {
    expect(() => encrypt('msg', '', TEN_X)).toThrow();
  });
});
