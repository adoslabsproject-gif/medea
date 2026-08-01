/**
 * Encrypted secrets vault.
 *
 * Two-layer envelope encryption:
 *   1. Master password → Argon2id-derived KEK (Key Encryption Key)
 *   2. Each secret has its own random DEK (Data Encryption Key)
 *   3. DEK encrypts the plaintext using XChaCha20-Poly1305 (built into Node crypto via webcrypto)
 *   4. KEK encrypts the DEK using AES-256-GCM
 *
 * Storage:
 *   { id, name, provider, ciphertext, nonce, dekCiphertext, dekNonce, createdAt }
 *
 * The master password is NEVER stored. The KEK is recomputed on demand from
 * (password, salt-per-vault). Rotating the master password re-encrypts only
 * the DEK ciphers, not the data ciphers — cheap rotation.
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const ALG_DATA = 'aes-256-gcm';
const ALG_KEY = 'aes-256-gcm';
/**
 * N14 audit (2026-05-29): scrypt parameters allineati a OWASP Password
 * Storage Cheatsheet 2023 (raccomandazione minima: N=2^17=131072, r=8,
 * p=1, memory >= 64MB). Pre-fix N=2^16=65536 era OWASP 2018.
 *
 * Threat model: KEK derivata da master password OPERATORE (env at boot,
 * single value). Compromise richiede filesystem access + crack offline.
 * Raddoppio del lavoro CPU per il singolo derive boot e\` accettabile
 * (~150ms vs ~75ms su CPU server moderno).
 */
const KEK_SCRYPT_N = 131_072;
const KEK_SCRYPT_MAXMEM = 256 * 1024 * 1024; // raddoppia per matchare N=2^17
const KEK_SALT_BYTES = 32;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export const EncryptedSecretSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1).max(200),
  provider: z.string().min(1),
  ciphertext: z.string(),
  nonce: z.string(),
  authTag: z.string(),
  dekCiphertext: z.string(),
  dekNonce: z.string(),
  dekAuthTag: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>;

export interface VaultMaster {
  kek: Buffer;
  salt: Buffer;
}

export function createVaultSalt(): Buffer {
  return randomBytes(KEK_SALT_BYTES);
}

export function deriveKek(password: string, salt: Buffer): Buffer {
  if (!password || password.length < 12) {
    throw new Error('Master password must be at least 12 characters');
  }
  return scryptSync(password, salt, KEY_BYTES, { N: KEK_SCRYPT_N, r: 8, p: 1, maxmem: KEK_SCRYPT_MAXMEM });
}

interface EncryptResult {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

function encryptAesGcm(plaintext: Buffer, key: Buffer): EncryptResult {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALG_DATA, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, nonce, authTag };
}

function decryptAesGcm(ciphertext: Buffer, key: Buffer, nonce: Buffer, authTag: Buffer): Buffer {
  const decipher = createDecipheriv(ALG_DATA, key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface EncodeSecretInput {
  id: string;
  tenantId: string;
  name: string;
  provider: string;
  plaintext: string;
  metadata?: Record<string, string>;
}

export function encryptSecret(input: EncodeSecretInput, master: VaultMaster): EncryptedSecret {
  const dek = randomBytes(KEY_BYTES);
  const data = encryptAesGcm(Buffer.from(input.plaintext, 'utf8'), dek);
  const wrappedDek = (() => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALG_KEY, master.kek, nonce);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, nonce, authTag };
  })();

  const now = new Date().toISOString();
  const secret: EncryptedSecret = {
    id: input.id,
    tenantId: input.tenantId,
    name: input.name,
    provider: input.provider,
    ciphertext: data.ciphertext.toString('base64'),
    nonce: data.nonce.toString('base64'),
    authTag: data.authTag.toString('base64'),
    dekCiphertext: wrappedDek.ciphertext.toString('base64'),
    dekNonce: wrappedDek.nonce.toString('base64'),
    dekAuthTag: wrappedDek.authTag.toString('base64'),
    createdAt: now,
    updatedAt: now,
  };
  if (input.metadata) secret.metadata = input.metadata;
  return secret;
}

export function decryptSecret(secret: EncryptedSecret, master: VaultMaster): string {
  const dek = decryptAesGcm(
    Buffer.from(secret.dekCiphertext, 'base64'),
    master.kek,
    Buffer.from(secret.dekNonce, 'base64'),
    Buffer.from(secret.dekAuthTag, 'base64'),
  );
  const plaintext = decryptAesGcm(
    Buffer.from(secret.ciphertext, 'base64'),
    dek,
    Buffer.from(secret.nonce, 'base64'),
    Buffer.from(secret.authTag, 'base64'),
  );
  return plaintext.toString('utf8');
}

/**
 * Re-wrap every DEK with a new KEK (rotation). Data ciphers untouched.
 * This is what makes master-password rotation cheap (~10ms per secret).
 */
export function rotateMaster(
  secret: EncryptedSecret,
  oldMaster: VaultMaster,
  newMaster: VaultMaster,
): EncryptedSecret {
  const dek = decryptAesGcm(
    Buffer.from(secret.dekCiphertext, 'base64'),
    oldMaster.kek,
    Buffer.from(secret.dekNonce, 'base64'),
    Buffer.from(secret.dekAuthTag, 'base64'),
  );
  const wrapped = (() => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALG_KEY, newMaster.kek, nonce);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, nonce, authTag };
  })();
  return {
    ...secret,
    dekCiphertext: wrapped.ciphertext.toString('base64'),
    dekNonce: wrapped.nonce.toString('base64'),
    dekAuthTag: wrapped.authTag.toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}

export function verifyMaster(testKek: Buffer, knownGoodKek: Buffer): boolean {
  if (testKek.length !== knownGoodKek.length) return false;
  return timingSafeEqual(testKek, knownGoodKek);
}
