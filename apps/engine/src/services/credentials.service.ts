/**
 * Credentials store wired to the secrets vault.
 * Credentials are encrypted at rest with envelope encryption (AES-256-GCM).
 * The master KEK is derived from the master password (file or env, vedi
 * `lib/master-password.ts`) + a vault salt generated and persisted to
 * MEDEA_DATA_DIR/master.key on first boot.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createVaultSalt,
  deriveKek,
  encryptSecret,
  decryptSecret,
  type EncryptedSecret,
  type VaultMaster,
} from '@medea/engine-secrets';
import { getDatabase } from '@/storage/db.js';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';
import { loadMasterPassword } from '@/lib/master-password.js';
import { nanoid } from 'nanoid';
import { AuditLogService } from './audit.service.js';
import { VaultSecretsService } from './vault-secrets.service.js';

const audit = new AuditLogService();
const vault = new VaultSecretsService();

interface CredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  provider: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  dek_ciphertext: string;
  dek_nonce: string;
  dek_auth_tag: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export function ensureCredentialsTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      dek_ciphertext TEXT NOT NULL,
      dek_nonce TEXT NOT NULL,
      dek_auth_tag TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, name)
    );
    CREATE INDEX IF NOT EXISTS user_credentials_provider_idx ON user_credentials(provider);
  `);
}

let cachedMaster: VaultMaster | null = null;

export function loadMaster(): VaultMaster {
  if (cachedMaster) return cachedMaster;
  const config = loadConfig();
  // Single source of truth: file (Docker secrets) → env → dev sentinel.
  // Vedi `lib/master-password.ts` per la precedenza.
  const { password, source } = loadMasterPassword();
  const keyPath = join(config.MEDEA_DATA_DIR, 'master.key');
  if (!existsSync(dirname(keyPath))) mkdirSync(dirname(keyPath), { recursive: true });

  let salt: Buffer;
  if (existsSync(keyPath)) {
    salt = Buffer.from(readFileSync(keyPath));
  } else {
    salt = createVaultSalt();
    writeFileSync(keyPath, salt);
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* not POSIX */
    }
    logger.info({ path: keyPath }, 'Generated new vault master salt');
  }

  if (source === 'dev-sentinel') {
    logger.warn(
      'master password from dev sentinel — set MEDEA_MASTER_PASSWORD_FILE or env in production.',
    );
  }

  cachedMaster = { kek: deriveKek(password, salt), salt };
  return cachedMaster;
}

export class CredentialsService {
  constructor() {
    ensureCredentialsTable();
  }

  list(
    tenantId = 'default',
  ): { id: string; name: string; provider: string; createdAt: string; updatedAt: string }[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(
        'SELECT id, name, provider, created_at, updated_at FROM user_credentials WHERE tenant_id = ? ORDER BY updated_at DESC',
      )
      .all(tenantId) as Pick<
      CredentialRow,
      'id' | 'name' | 'provider' | 'created_at' | 'updated_at'
    >[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async create(input: {
    name: string;
    provider: string;
    plaintext: string;
    metadata?: Record<string, string>;
    tenantId?: string;
    actorId?: string;
  }): Promise<{ id: string }> {
    const tenantId = input.tenantId ?? 'default';
    const id = nanoid();
    const master = loadMaster();
    const enc = encryptSecret(
      input.metadata
        ? {
            id,
            tenantId,
            name: input.name,
            provider: input.provider,
            plaintext: input.plaintext,
            metadata: input.metadata,
          }
        : { id, tenantId, name: input.name, provider: input.provider, plaintext: input.plaintext },
      master,
    );

    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        `
      INSERT INTO user_credentials (id, tenant_id, name, provider, ciphertext, nonce, auth_tag, dek_ciphertext, dek_nonce, dek_auth_tag, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        tenantId,
        input.name,
        input.provider,
        enc.ciphertext,
        enc.nonce,
        enc.authTag,
        enc.dekCiphertext,
        enc.dekNonce,
        enc.dekAuthTag,
        enc.metadata ? JSON.stringify(enc.metadata) : null,
        enc.createdAt,
        enc.updatedAt,
      );

    await audit.append({
      tenantId,
      action: 'credential.create',
      resourceType: 'credential',
      resourceId: id,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      metadata: { name: input.name, provider: input.provider },
    });

    return { id };
  }

  /**
   * Reveal by id: returns the decrypted plaintext, or, if the credential's
   * name is a Vault reference ("vault:..."), resolves it against the
   * configured Vault server.
   */
  async revealById(id: string, tenantId = 'default'): Promise<string | null> {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM user_credentials WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as CredentialRow | undefined;
    if (!row) return null;

    const vaultResult = await vault.resolve(row.name);
    if (vaultResult !== undefined) return vaultResult;

    return this.reveal(id, tenantId);
  }

  reveal(id: string, tenantId = 'default'): string | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM user_credentials WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as CredentialRow | undefined;
    if (!row) return null;
    const master = loadMaster();
    const enc: EncryptedSecret = {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      provider: row.provider,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
      dekCiphertext: row.dek_ciphertext,
      dekNonce: row.dek_nonce,
      dekAuthTag: row.dek_auth_tag,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return decryptSecret(enc, master);
  }

  async delete(id: string, tenantId = 'default', actorId?: string): Promise<boolean> {
    const { sqlite } = getDatabase();
    const info = sqlite
      .prepare('DELETE FROM user_credentials WHERE id = ? AND tenant_id = ?')
      .run(id, tenantId);
    if (info.changes === 0) return false;
    await audit.append({
      tenantId,
      action: 'credential.delete',
      resourceType: 'credential',
      resourceId: id,
      ...(actorId !== undefined ? { actorId } : {}),
    });
    return true;
  }
}
