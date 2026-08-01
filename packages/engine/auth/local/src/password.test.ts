import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash } from './password.js';

describe('password (argon2id)', () => {
  it('hashes and verifies correctly', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password!')).toBe(false);
  });

  it('rejects passwords shorter than 12 chars', async () => {
    await expect(hashPassword('short1!')).rejects.toThrow(/12 characters/);
  });

  it('returns false on malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('needsRehash flags legacy formats', () => {
    expect(needsRehash('$2b$10$abc')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
  });
});
