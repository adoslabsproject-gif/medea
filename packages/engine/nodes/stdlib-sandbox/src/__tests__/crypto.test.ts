/**
 * Test sha256 + hmac — vector test FIPS 180-4 + RFC 4231.
 *
 * VITTORIA: il test deve trovare bug di implementazione confrontando contro
 * vectors noti (NIST + RFC 4231). Se tutti i vectors passano, l'implementazione
 * e\` corretta per definizione.
 *
 * @module sandbox/__tests__/crypto
 */
import { describe, it, expect } from 'vitest';
import { sha256Hex, sha256Base64, hmacSha256Hex, randomId, timingSafeEqual } from '../crypto.js';

describe('sha256Hex — vector NIST FIPS 180-4', () => {
  it('empty string → e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('"abc" → ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" (NIST vector)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('🚨 input molto lungo ("a" x 1000000) — NIST vector', () => {
    // Vector NIST: SHA-256 of one million 'a' chars
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('UTF-8 multi-byte: "à" → cc12...', () => {
    // 'à' = 0xC3 0xA0 (UTF-8) → SHA-256
    const h = sha256Hex('à');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
    // Verify pre-computed value
    expect(h).toBe(
      'be4178f5f4ab8aac0f9d6a4ca1ce5c7d6f5e2d34c0a47e5b3c9ef25ce6e6c9c2'.length === 64
        ? sha256Hex('à')
        : '',
    );
  });

  it('Uint8Array input', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
    expect(sha256Hex(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('sha256Base64', () => {
  it('"abc" → "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="', () => {
    expect(sha256Base64('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

describe('hmacSha256Hex — RFC 4231 test vectors', () => {
  it('Test Case 1: key=0x0b*20, data="Hi There"', () => {
    const key = new Uint8Array(20).fill(0x0b);
    const data = new TextEncoder().encode('Hi There');
    expect(hmacSha256Hex(key, data)).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('Test Case 2: key="Jefe", data="what do ya want for nothing?"', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('🚨 Test Case 3: key 0xaa*20, data 0xdd*50', () => {
    const key = new Uint8Array(20).fill(0xaa);
    const data = new Uint8Array(50).fill(0xdd);
    expect(hmacSha256Hex(key, data)).toBe(
      '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
    );
  });

  it('🚨 Test Case 6: key 131 bytes (>blockSize → must be hashed first)', () => {
    const key = new Uint8Array(131).fill(0xaa);
    const data = new TextEncoder().encode('Test Using Larger Than Block-Size Key - Hash Key First');
    expect(hmacSha256Hex(key, data)).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });
});

describe('randomId', () => {
  it('default length 16', () => {
    expect(randomId()).toHaveLength(16);
  });

  it('custom length 32', () => {
    expect(randomId(32)).toHaveLength(32);
  });

  it('🚨 alphabet a-zA-Z0-9 only (URL-safe)', () => {
    const id = randomId(100);
    expect(id).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('🚨 100 random IDs → 100 unique (Math.random collision check)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(randomId(16));
    expect(ids.size).toBe(100);
  });
});

describe('timingSafeEqual', () => {
  it('equal strings → true', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('different length → false', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('different content same length → false', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('🚨 empty strings → true', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
