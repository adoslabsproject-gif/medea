/**
 * Encryption-at-rest dei secret di connessione DB Studio (fix 2026-06-15).
 *
 * PROBLEMA: `passwordSecretRef` di una connessione esterna poteva essere un
 * valore LETTERALE (la UI accetta "valore o riferimento vault://"). Prima
 * veniva persistito IN CHIARO in `db_studio_databases.spec_json` (SQLite del
 * tenant). Chi compromette il volume /data del container vedeva le password.
 *
 * SOLUZIONE (design B, blast-radius minimo):
 *   • SEAL alla scrittura (create/update): un literal non-vault, non-vuoto →
 *     `enc:1:<b64nonce>:<b64ciphertext>` via AES-256-GCM per-tenant
 *     (lib/secrets-crypto, stessa master password delle credenziali workflow).
 *   • UNSEAL solo al CONNECT (getAdapter), just-in-time, su una COPIA: gli
 *     adapter ricevono il plaintext, lo spec a riposo resta cifrato. I path di
 *     re-persist (sync manifest) portano il valore SEALED → niente plaintext
 *     riscritto per sbaglio.
 *   • Il frontend NON riceve mai il secret: la route redige in display
 *     (redactConnectionSecrets). In update il sentinel di redazione = "mantieni".
 *
 * Backward-compat: un valore literal pre-esistente NON è `enc:` → unseal lo
 * lascia invariato (l'adapter lo usa) e viene migrato a `enc:` al primo save.
 * `vault:` non viene mai toccato (risolto altrove).
 *
 * @module services/db-studio/connection-secrets
 */
import { encrypt, decrypt, getMasterPasswordOrThrow } from '@/lib/secrets-crypto.js';
import type { Database } from '@medea/engine-db-studio-core';

/** Prefisso dello schema di sealing. Versionato per future rotazioni di formato. */
export const ENC_PREFIX = 'enc:1:';
/** Prefisso dei riferimenti vault (risolti dal VaultSecretsService, non qui). */
const VAULT_PREFIX = 'vault:';

/** True se il valore è già un blob cifrato dal nostro schema. */
export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** True se il valore è un secret LETTERALE da cifrare (no vault:, no enc:, non vuoto). */
function isPlainSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.startsWith(VAULT_PREFIX) &&
    !value.startsWith(ENC_PREFIX)
  );
}

/** Cifra un secret letterale → `enc:1:<b64nonce>:<b64ciphertext>`. */
export function sealSecret(plain: string, tenantId: string): string {
  const { ciphertext, nonce } = encrypt(plain, getMasterPasswordOrThrow(), tenantId);
  return `${ENC_PREFIX}${nonce.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decifra un blob `enc:1:...`. Lancia se malformato o auth-tag non valido. */
export function unsealSecret(value: string, tenantId: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value; // non nostro → invariato
  const rest = value.slice(ENC_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0)
    throw new Error('unsealSecret: blob malformato (manca il separatore nonce:ciphertext)');
  const nonce = Buffer.from(rest.slice(0, sep), 'base64');
  const ciphertext = Buffer.from(rest.slice(sep + 1), 'base64');
  return decrypt(ciphertext, nonce, getMasterPasswordOrThrow(), tenantId);
}

/**
 * Restituisce una COPIA della connection col secret cifrato a riposo. Idempotente:
 * `enc:`/`vault:`/vuoto/assente restano invariati (solo i literal vengono cifrati).
 */
export function sealConnectionSecrets(
  connection: Database['connection'],
  tenantId: string,
): Database['connection'] {
  const c = connection as Record<string, unknown>;
  if (!isPlainSecret(c.passwordSecretRef)) return connection;
  return { ...connection, passwordSecretRef: sealSecret(c.passwordSecretRef, tenantId) };
}

/**
 * Restituisce una COPIA della connection col secret DECIFRATO (per il connect).
 * `enc:` → plaintext; literal/vault:/vuoto → invariati. Mai muta l'input.
 */
export function unsealConnectionSecrets(
  connection: Database['connection'],
  tenantId: string,
): Database['connection'] {
  const c = connection as Record<string, unknown>;
  if (!isSealed(c.passwordSecretRef)) return connection;
  return { ...connection, passwordSecretRef: unsealSecret(c.passwordSecretRef, tenantId) };
}
