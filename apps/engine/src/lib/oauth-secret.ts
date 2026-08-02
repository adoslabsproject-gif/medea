/**
 * oauth-secret — envelope encryption del `client_secret` degli IdP OAuth.
 *
 * Parità con i secret BYOK (llm) e le password email: il client_secret OAuth NON
 * deve stare in chiaro nel SQLite del container (esfiltrazione del volume /data =
 * secret leggibili). Riusa lo stesso envelope AES-256-GCM (KEK→DEK) di
 * `@medea/engine-secrets` e la stessa master key (`loadMaster`).
 *
 * Backward-compat: i record storici hanno solo `client_secret` (plaintext) e
 * nessun ciphertext → `resolveClientSecret` li ritorna as-is finché non vengono
 * ri-salvati (che li cifra). I NUOVI record salvano i 6 campi cifrati e lasciano
 * `client_secret` vuoto.
 *
 * @module lib/oauth-secret
 */
import { encryptSecret, decryptSecret } from '@medea/engine-secrets';
import { loadMaster } from '@/services/credentials.service.js';

/** I 6 campi base64 dell'envelope persistiti accanto alla riga oauth_providers. */
export interface ClientSecretCipher {
  ciphertext: string;
  nonce: string;
  authTag: string;
  dekCiphertext: string;
  dekNonce: string;
  dekAuthTag: string;
}

// id/tenantId/name/provider sono dummy: contano solo quando il secret è esposto
// via Credentials API (qui non lo è — è interno alla riga oauth_providers).
const WRAP = { id: 'oauth', tenantId: 'oauth', name: 'client_secret', provider: 'oauth' } as const;
const EPOCH = '1970-01-01T00:00:00.000Z';

/** Cifra un client_secret → 6 campi base64. Lancia se la master key manca. */
export function encryptClientSecret(plaintext: string): ClientSecretCipher {
  const enc = encryptSecret({ ...WRAP, plaintext }, loadMaster());
  return {
    ciphertext: enc.ciphertext,
    nonce: enc.nonce,
    authTag: enc.authTag,
    dekCiphertext: enc.dekCiphertext,
    dekNonce: enc.dekNonce,
    dekAuthTag: enc.dekAuthTag,
  };
}

/** Decifra i 6 campi → plaintext. Lancia su tamper (authTag) o master errata. */
export function decryptClientSecret(c: ClientSecretCipher): string {
  return decryptSecret({ ...WRAP, ...c, createdAt: EPOCH, updatedAt: EPOCH }, loadMaster());
}

/** Forma minima della riga necessaria per risolvere il secret (cifrato o legacy). */
export interface ClientSecretRow {
  client_secret: string;
  client_secret_ciphertext?: string | null;
  client_secret_nonce?: string | null;
  client_secret_auth_tag?: string | null;
  client_secret_dek_ciphertext?: string | null;
  client_secret_dek_nonce?: string | null;
  client_secret_dek_auth_tag?: string | null;
}

/**
 * Ritorna il client_secret in chiaro da una riga oauth_providers:
 * cifrato (nuovi record) → decifra; altrimenti `client_secret` (legacy plaintext).
 */
export function resolveClientSecret(row: ClientSecretRow): string {
  if (
    row.client_secret_ciphertext && row.client_secret_nonce && row.client_secret_auth_tag &&
    row.client_secret_dek_ciphertext && row.client_secret_dek_nonce && row.client_secret_dek_auth_tag
  ) {
    return decryptClientSecret({
      ciphertext: row.client_secret_ciphertext,
      nonce: row.client_secret_nonce,
      authTag: row.client_secret_auth_tag,
      dekCiphertext: row.client_secret_dek_ciphertext,
      dekNonce: row.client_secret_dek_nonce,
      dekAuthTag: row.client_secret_dek_auth_tag,
    });
  }
  return row.client_secret;
}
