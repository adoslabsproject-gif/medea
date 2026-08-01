/**
 * Tenant-scoped secrets crypto helper — AES-256-GCM + HKDF-SHA256.
 *
 * Why this exists (vs. `@flowforge/secrets` envelope encryption)
 * --------------------------------------------------------------
 * The existing CredentialsService uses two-tier envelope encryption (KEK→DEK)
 * because user-provided credentials are PER-CREDENTIAL: each row gets its own
 * DEK, which is the right shape when an admin can rotate or revoke a single
 * credential without re-encrypting the rest.
 *
 * Third-party integrations (Gmail, Stripe, WhatsApp, Drive, OCR) are a DIFFERENT
 * shape: a tenant typically has 0-3 instances of each integration, frequent
 * token refreshes (OAuth refresh tokens rotate every ~1h), and the value being
 * encrypted is small JSON (refresh_token, access_token, expiry, scope). The
 * envelope overhead (extra DEK column, two AES ops per read) is unnecessary
 * here. A single tenant-scoped key + GCM is plenty — that's what Stripe, Auth0,
 * and 1Password do for similar workloads.
 *
 * Design
 * ------
 *   • Master input  = FLOWFORGE_MASTER_PASSWORD (same env var as the rest of
 *                     the secrets stack — single source of trust).
 *   • Derivation    = HKDF-SHA256(master_pw, salt=tenantId, info="flowforge-
 *                     tenant-secrets-v1") → 32-byte AES-256-GCM key.
 *   • Per-record    = fresh 12-byte nonce; 16-byte GCM auth tag is appended.
 *                     We store (ciphertext, nonce) as two BLOB columns so the
 *                     auth tag is part of `ciphertext` (last 16 bytes — that's
 *                     how Node's GCM `final()` packs them when used via the
 *                     `update + getAuthTag` API).
 *   • Versioning    = the HKDF `info` string embeds "v1" so a future key
 *                     rotation (v2 with HSM-backed master) doesn't risk
 *                     deriving the same key bytes.
 *
 * Threat model coverage
 * ---------------------
 *   • At-rest DB exfiltration → ciphertext is useless without master password.
 *   • Cross-tenant leak       → HKDF salt = tenantId makes each tenant's key
 *                               unique, so a key compromise for tenant A does
 *                               NOT help an attacker decrypt tenant B's data.
 *   • Tampering               → GCM auth tag detects any bit flip.
 *
 * NOT covered (out of scope, handled at other layers):
 *   • Master password leak    → use Vault/KMS (`@flowforge/secrets` `loadMaster`
 *                               supports both env var and persistent salt).
 *   • Memory dump while live  → unavoidable for any encryption-at-rest scheme.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { loadMasterPassword } from './master-password.js';

const HKDF_INFO = 'flowforge-tenant-secrets-v1';
const HKDF_HASH = 'sha256';
const KEY_LEN_BYTES = 32; // AES-256
const NONCE_LEN_BYTES = 12; // GCM-recommended
const TAG_LEN_BYTES = 16; // GCM auth tag

export interface EncryptedBlob {
  /** Raw ciphertext WITH appended 16-byte GCM auth tag. */
  ciphertext: Buffer;
  /** 12-byte GCM nonce (unique per encryption). */
  nonce: Buffer;
}

/**
 * Derive a per-tenant AES-256 key from the master password using HKDF-SHA256.
 *
 * Performance note: HKDF is cheap (<1ms) but we still cache per-tenant inside
 * the encrypt/decrypt functions via a Map to avoid re-deriving on every save.
 */
const tenantKeyCache = new Map<string, Buffer>();

function deriveTenantKey(masterPassword: string, tenantId: string): Buffer {
  // HIGH (2026-05-29): cache key includeva SOLO la lunghezza del password
  // → collisione tra password diversi della stessa lunghezza (es. rotation
  // hardcoded: "a"*32 vs "b"*32 producono lo stesso cacheKey, ma hkdfSync
  // produrrebbe key diverse). Fix: usa SHA-256(password) prefix come
  // fingerprint univoco (no plaintext leak — solo hash).
  const fingerprint = createHash('sha256').update(masterPassword, 'utf8').digest('hex').slice(0, 16);
  const cacheKey = `${tenantId}::${fingerprint}`;
  const cached = tenantKeyCache.get(cacheKey);
  if (cached) return cached;

  // Node's hkdfSync returns an ArrayBuffer; coerce to Buffer for crypto API.
  const ikm = Buffer.from(masterPassword, 'utf8');
  const salt = Buffer.from(tenantId, 'utf8');
  const derived = hkdfSync(HKDF_HASH, ikm, salt, HKDF_INFO, KEY_LEN_BYTES);
  const key = Buffer.from(derived);

  // Bounded cache — at most 256 tenants live in memory. Beyond that, evict
  // the oldest entry (Map preserves insertion order). 256 keys × 32 bytes
  // = 8 KB, negligible. Production tenants per container are typically 1.
  if (tenantKeyCache.size >= 256) {
    const firstKey = tenantKeyCache.keys().next().value;
    if (firstKey) tenantKeyCache.delete(firstKey);
  }
  tenantKeyCache.set(cacheKey, key);
  return key;
}

/**
 * Encrypt UTF-8 plaintext with AES-256-GCM. Returns ciphertext (with appended
 * GCM auth tag) and a fresh 12-byte nonce.
 */
export function encrypt(plain: string, masterPassword: string, tenantId: string): EncryptedBlob {
  if (!plain) throw new Error('encrypt: empty plaintext');
  if (!masterPassword) throw new Error('encrypt: FLOWFORGE_MASTER_PASSWORD is required');
  if (!tenantId) throw new Error('encrypt: tenantId is required (HKDF salt)');

  const key = deriveTenantKey(masterPassword, tenantId);
  const nonce = randomBytes(NONCE_LEN_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertextOnly = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Append auth tag to ciphertext so we only need to persist 2 BLOBs.
  const ciphertext = Buffer.concat([ciphertextOnly, authTag]);
  return { ciphertext, nonce };
}

/**
 * Decrypt a blob produced by `encrypt`. Throws if the auth tag fails — this
 * means either the master password rotated without re-encryption, or the
 * ciphertext was tampered with.
 */
export function decrypt(ciphertext: Buffer, nonce: Buffer, masterPassword: string, tenantId: string): string {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < TAG_LEN_BYTES + 1) {
    throw new Error('decrypt: ciphertext too short (missing GCM auth tag?)');
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_LEN_BYTES) {
    throw new Error(`decrypt: nonce must be exactly ${NONCE_LEN_BYTES.toString()} bytes`);
  }
  if (!masterPassword) throw new Error('decrypt: FLOWFORGE_MASTER_PASSWORD is required');
  if (!tenantId) throw new Error('decrypt: tenantId is required (HKDF salt)');

  const key = deriveTenantKey(masterPassword, tenantId);
  const authTag = ciphertext.subarray(ciphertext.length - TAG_LEN_BYTES);
  const data = ciphertext.subarray(0, ciphertext.length - TAG_LEN_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf8');
}

/**
 * Reads `FLOWFORGE_MASTER_PASSWORD` from env. Centralized here so executors
 * and the store can stay decoupled from `node:process`.
 *
 * In production, this MUST be set (we throw). In development/test, we accept
 * the same default-token sentinel that CredentialsService uses for parity.
 */
export function getMasterPasswordOrThrow(): string {
  // Delega al loader unificato: file (Docker secrets) → env (backward-compat)
  // → dev-sentinel. Single source of truth, single error message.
  return loadMasterPassword().password;
}
