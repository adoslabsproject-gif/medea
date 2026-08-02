/**
 * SystemEmailAccountsService — multi-tenant directory of pre-configured
 * SMTP/IMAP accounts that workflow nodes can pick from a dropdown
 * instead of inlining host/port/credentials in every node.
 *
 * Why this exists:
 *   The `action_send_email` and `trigger_imap` nodes each need 5+ secret
 *   fields. Asking the user to fill them per-node is hostile UX (and
 *   risks leaking credentials in workflow exports). With this service:
 *     1. The admin configures `flowforge@nothumanallowed.com` ONCE in
 *        Settings → Email Accounts (host=smtp.ionos.com, port=465, …).
 *     2. Workflow nodes show a dropdown "Account: …" listing all accounts
 *        configured for the tenant; selecting one means the executor
 *        resolves the secrets at run time and the workflow JSON only
 *        contains the opaque account id.
 *
 * Storage:
 *   • Non-secret fields stored plaintext (host, port, username, label).
 *   • Passwords (SMTP + IMAP) stored with envelope encryption identical
 *     to `CredentialsService` — DEK encrypted by the master KEK, both
 *     ciphertexts kept in the row. Decrypts only at run-time.
 *
 * Default-account rule:
 *   At most ONE row per tenant can have `is_default = 1`. Setting a row
 *   default automatically unsets the previous one. The wizard reads
 *   this row to auto-fill the action_send_email step.
 */

import { nanoid } from 'nanoid';
import { createVaultSalt, deriveKek, encryptSecret, decryptSecret, type VaultMaster } from '@medea/engine-secrets';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { loadMasterPassword } from '@/lib/master-password.js';

/** Encrypted-blob mirror of `EncryptedSecret` — fields are base64-encoded
 *  strings (NOT Buffers) because that's how `@medea/engine-secrets` returns
 *  them and how we persist them in SQLite TEXT columns. */
export interface EncryptedBlob {
  ciphertext: string;
  nonce: string;
  authTag: string;
  dekCiphertext: string;
  dekNonce: string;
  dekAuthTag: string;
}

interface DbRow {
  id: string;
  tenant_id: string;
  label: string;
  from_address: string;
  is_default: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
  smtp_username: string | null;
  smtp_pw_ciphertext: string | null;
  smtp_pw_nonce: string | null;
  smtp_pw_auth_tag: string | null;
  smtp_pw_dek_ciphertext: string | null;
  smtp_pw_dek_nonce: string | null;
  smtp_pw_dek_auth_tag: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_username: string | null;
  imap_pw_ciphertext: string | null;
  imap_pw_nonce: string | null;
  imap_pw_auth_tag: string | null;
  imap_pw_dek_ciphertext: string | null;
  imap_pw_dek_nonce: string | null;
  imap_pw_dek_auth_tag: string | null;
  // OAuth2 columns (added by ensureTable ALTER 2026-06-04). Strict mode
  // SQLite returns `undefined` for columns the row doesn't have set —
  // the schema default keeps `auth_type='password'` for legacy rows.
  auth_type?: string;
  oauth_provider?: string | null;
  oauth_email?: string | null;
  oauth_scope?: string | null;
  oauth_expires_at?: string | null;
  oauth_refresh_ciphertext?: string | null;
  oauth_refresh_nonce?: string | null;
  oauth_refresh_auth_tag?: string | null;
  oauth_refresh_dek_ciphertext?: string | null;
  oauth_refresh_dek_nonce?: string | null;
  oauth_refresh_dek_auth_tag?: string | null;
  oauth_access_ciphertext?: string | null;
  oauth_access_nonce?: string | null;
  oauth_access_auth_tag?: string | null;
  oauth_access_dek_ciphertext?: string | null;
  oauth_access_dek_nonce?: string | null;
  oauth_access_dek_auth_tag?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SystemEmailAccount {
  id: string;
  label: string;
  fromAddress: string;
  isDefault: boolean;
  /** 'password' (default, legacy) or 'oauth2' (Gmail XOAUTH2 etc). */
  authType: 'password' | 'oauth2';
  /** Set when authType='oauth2' — provider id + Google email + expiry. */
  oauth?: {
    provider: 'google';
    email: string;
    expiresAt: string;
  };
  smtp: {
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'plain';
    username: string;
    /** Plaintext password — only present in `resolveForExecutor()`. */
    password?: string;
    hasPassword: boolean;
  };
  imap?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    hasPassword: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface UpsertInput {
  tenantId: string;
  label: string;
  fromAddress: string;
  isDefault: boolean;
  smtp: {
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'plain';
    username: string;
    /** Plaintext — encrypted before write. Send empty string to keep existing. */
    password: string;
  };
  imap?: {
    host: string;
    port: number;
    username: string;
    /** Plaintext — encrypted before write. Send empty string to keep existing. */
    password: string;
  };
}

function ensureTable(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS system_email_accounts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      label TEXT NOT NULL,
      from_address TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_security TEXT,
      smtp_username TEXT,
      smtp_pw_ciphertext TEXT,
      smtp_pw_nonce TEXT,
      smtp_pw_auth_tag TEXT,
      smtp_pw_dek_ciphertext TEXT,
      smtp_pw_dek_nonce TEXT,
      smtp_pw_dek_auth_tag TEXT,
      imap_host TEXT,
      imap_port INTEGER,
      imap_username TEXT,
      imap_pw_ciphertext TEXT,
      imap_pw_nonce TEXT,
      imap_pw_auth_tag TEXT,
      imap_pw_dek_ciphertext TEXT,
      imap_pw_dek_nonce TEXT,
      imap_pw_dek_auth_tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS system_email_accounts_tenant_idx ON system_email_accounts(tenant_id);
    CREATE INDEX IF NOT EXISTS system_email_accounts_default_idx ON system_email_accounts(tenant_id, is_default);
  `);

  // 2026-06-04: OAuth2 support (Gmail XOAUTH2 send+IMAP). Idempotent ALTER:
  // each ADD COLUMN is wrapped in try-catch because SQLite refuses duplicates
  // and we want the migration to be no-op on already-migrated DBs.
  //
  // auth_type   — 'password' (default, smtp/imap_pw_* used) | 'oauth2'
  // oauth_provider — 'google' | 'microsoft' (future)
  // oauth_email — the address Google authorized (matches `from_address` —
  //               stored separately so a future "re-link" flow can swap
  //               account without losing the workflow binding).
  // oauth_*_ciphertext etc — AES-256-GCM envelope encrypted refresh + access
  //               tokens, same KEK derivation as smtp_pw_*. We DO encrypt the
  //               access token: while it's short-lived, it carries the full
  //               mail.google.com scope and a compromised DB row would let
  //               the attacker exfiltrate the whole mailbox before the
  //               refresh expires.
  const alters = [
    "ALTER TABLE system_email_accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password'",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_provider TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_email TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_scope TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_expires_at TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_refresh_ciphertext TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_refresh_nonce TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_refresh_auth_tag TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_refresh_dek_ciphertext TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_refresh_dek_nonce TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_refresh_dek_auth_tag TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_access_ciphertext TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_access_nonce TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_access_auth_tag TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_access_dek_ciphertext TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_access_dek_nonce TEXT",
    "ALTER TABLE system_email_accounts ADD COLUMN oauth_access_dek_auth_tag TEXT",
  ];
  for (const stmt of alters) {
    try { sqlite.exec(stmt); } catch { /* column already exists — fine */ }
  }
}

function loadMaster(): VaultMaster {
  // Single source: file (Docker secrets) → env → dev sentinel. loadMasterPassword
  // throws in production se nessuno dei due e\` settato.
  const { password } = loadMasterPassword();
  const { sqlite } = getDatabase();
  // vault_meta is created by CredentialsService — we read the same salt
  // so SystemEmailAccounts and Credentials share the same KEK derivation.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = sqlite.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as { value: string } | undefined;
  let salt: Buffer;
  if (row) {
    salt = Buffer.from(row.value, 'base64');
  } else {
    salt = createVaultSalt();
    sqlite.prepare("INSERT INTO vault_meta (key, value) VALUES ('salt', ?)").run(salt.toString('base64'));
  }
  return { kek: deriveKek(password, salt), salt };
}

/**
 * Encapsulates a plaintext password into the 6 base64 strings we persist.
 * The wrapping EncryptedSecret (id/name/provider) is dummy — those fields
 * matter only when the secret is exposed through the Credentials API.
 */
export function loadEmailVaultMaster(): VaultMaster {
  return loadMaster();
}

export function encBlob(plaintext: string, master: VaultMaster): EncryptedBlob {
  const enc = encryptSecret(
    { id: 'sea', tenantId: 'sea', name: 'pw', provider: 'sea', plaintext },
    master,
  );
  return {
    ciphertext: enc.ciphertext,
    nonce: enc.nonce,
    authTag: enc.authTag,
    dekCiphertext: enc.dekCiphertext,
    dekNonce: enc.dekNonce,
    dekAuthTag: enc.dekAuthTag,
  };
}

export function decBlob(blob: EncryptedBlob, master: VaultMaster): string {
  return decryptSecret(
    {
      id: 'sea', tenantId: 'sea', name: 'pw', provider: 'sea',
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      authTag: blob.authTag,
      dekCiphertext: blob.dekCiphertext,
      dekNonce: blob.dekNonce,
      dekAuthTag: blob.dekAuthTag,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    master,
  );
}

export class SystemEmailAccountsService {
  constructor() {
    ensureTable();
  }

  list(tenantId: string): SystemEmailAccount[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare(`SELECT * FROM system_email_accounts WHERE tenant_id = ? ORDER BY is_default DESC, label`)
      .all(tenantId) as DbRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Picker payload — non-secret only, used by the editor dropdowns. */
  picker(tenantId: string): { id: string; label: string; fromAddress: string; isDefault: boolean }[] {
    return this.list(tenantId).map((a) => ({
      id: a.id, label: a.label, fromAddress: a.fromAddress, isDefault: a.isDefault,
    }));
  }

  /** Engine-side resolver — returns the FULL account with plaintext passwords. */
  resolveForExecutor(tenantId: string, accountId: string): SystemEmailAccount | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(`SELECT * FROM system_email_accounts WHERE id = ? AND tenant_id = ?`)
      .get(accountId, tenantId) as DbRow | undefined;
    if (!row) return null;
    const acct = this.mapRow(row);
    try {
      const master = loadMaster();
      if (row.smtp_pw_ciphertext && row.smtp_pw_nonce && row.smtp_pw_auth_tag
          && row.smtp_pw_dek_ciphertext && row.smtp_pw_dek_nonce && row.smtp_pw_dek_auth_tag) {
        acct.smtp.password = decBlob({
          ciphertext: row.smtp_pw_ciphertext, nonce: row.smtp_pw_nonce, authTag: row.smtp_pw_auth_tag,
          dekCiphertext: row.smtp_pw_dek_ciphertext, dekNonce: row.smtp_pw_dek_nonce, dekAuthTag: row.smtp_pw_dek_auth_tag,
        }, master);
      }
      if (acct.imap && row.imap_pw_ciphertext && row.imap_pw_nonce && row.imap_pw_auth_tag
          && row.imap_pw_dek_ciphertext && row.imap_pw_dek_nonce && row.imap_pw_dek_auth_tag) {
        acct.imap.password = decBlob({
          ciphertext: row.imap_pw_ciphertext, nonce: row.imap_pw_nonce, authTag: row.imap_pw_auth_tag,
          dekCiphertext: row.imap_pw_dek_ciphertext, dekNonce: row.imap_pw_dek_nonce, dekAuthTag: row.imap_pw_dek_auth_tag,
        }, master);
      }
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to decrypt system email account password');
    }
    return acct;
  }

  getDefault(tenantId: string): SystemEmailAccount | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare(`SELECT * FROM system_email_accounts WHERE tenant_id = ? AND is_default = 1 LIMIT 1`)
      .get(tenantId) as DbRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  upsert(input: UpsertInput, existingId?: string): SystemEmailAccount {
    const { sqlite } = getDatabase();
    const master = loadMaster();
    const id = existingId ?? nanoid();
    const now = new Date().toISOString();

    // If marked default, clear the previous default for this tenant.
    if (input.isDefault) {
      sqlite.prepare(`UPDATE system_email_accounts SET is_default = 0 WHERE tenant_id = ?`).run(input.tenantId);
    }

    // Decide whether to (re-)encrypt the SMTP password
    let smtpBlob: EncryptedBlob | null = null;
    if (input.smtp.password) {
      smtpBlob = encBlob(input.smtp.password, master);
    }
    let imapBlob: EncryptedBlob | null = null;
    if (input.imap?.password) {
      imapBlob = encBlob(input.imap.password, master);
    }

    const existing = existingId
      ? sqlite.prepare(`SELECT * FROM system_email_accounts WHERE id = ? AND tenant_id = ?`)
          .get(existingId, input.tenantId) as DbRow | undefined
      : undefined;

    sqlite.prepare(`
      INSERT INTO system_email_accounts (
        id, tenant_id, label, from_address, is_default,
        smtp_host, smtp_port, smtp_security, smtp_username,
        smtp_pw_ciphertext, smtp_pw_nonce, smtp_pw_auth_tag,
        smtp_pw_dek_ciphertext, smtp_pw_dek_nonce, smtp_pw_dek_auth_tag,
        imap_host, imap_port, imap_username,
        imap_pw_ciphertext, imap_pw_nonce, imap_pw_auth_tag,
        imap_pw_dek_ciphertext, imap_pw_dek_nonce, imap_pw_dek_auth_tag,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        from_address = excluded.from_address,
        is_default = excluded.is_default,
        smtp_host = excluded.smtp_host,
        smtp_port = excluded.smtp_port,
        smtp_security = excluded.smtp_security,
        smtp_username = excluded.smtp_username,
        smtp_pw_ciphertext = COALESCE(excluded.smtp_pw_ciphertext, system_email_accounts.smtp_pw_ciphertext),
        smtp_pw_nonce = COALESCE(excluded.smtp_pw_nonce, system_email_accounts.smtp_pw_nonce),
        smtp_pw_auth_tag = COALESCE(excluded.smtp_pw_auth_tag, system_email_accounts.smtp_pw_auth_tag),
        smtp_pw_dek_ciphertext = COALESCE(excluded.smtp_pw_dek_ciphertext, system_email_accounts.smtp_pw_dek_ciphertext),
        smtp_pw_dek_nonce = COALESCE(excluded.smtp_pw_dek_nonce, system_email_accounts.smtp_pw_dek_nonce),
        smtp_pw_dek_auth_tag = COALESCE(excluded.smtp_pw_dek_auth_tag, system_email_accounts.smtp_pw_dek_auth_tag),
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        imap_username = excluded.imap_username,
        imap_pw_ciphertext = COALESCE(excluded.imap_pw_ciphertext, system_email_accounts.imap_pw_ciphertext),
        imap_pw_nonce = COALESCE(excluded.imap_pw_nonce, system_email_accounts.imap_pw_nonce),
        imap_pw_auth_tag = COALESCE(excluded.imap_pw_auth_tag, system_email_accounts.imap_pw_auth_tag),
        imap_pw_dek_ciphertext = COALESCE(excluded.imap_pw_dek_ciphertext, system_email_accounts.imap_pw_dek_ciphertext),
        imap_pw_dek_nonce = COALESCE(excluded.imap_pw_dek_nonce, system_email_accounts.imap_pw_dek_nonce),
        imap_pw_dek_auth_tag = COALESCE(excluded.imap_pw_dek_auth_tag, system_email_accounts.imap_pw_dek_auth_tag),
        updated_at = excluded.updated_at
    `).run(
      id, input.tenantId, input.label, input.fromAddress, input.isDefault ? 1 : 0,
      input.smtp.host, input.smtp.port, input.smtp.security, input.smtp.username,
      smtpBlob?.ciphertext ?? null, smtpBlob?.nonce ?? null, smtpBlob?.authTag ?? null,
      smtpBlob?.dekCiphertext ?? null, smtpBlob?.dekNonce ?? null, smtpBlob?.dekAuthTag ?? null,
      input.imap?.host ?? null, input.imap?.port ?? null, input.imap?.username ?? null,
      imapBlob?.ciphertext ?? null, imapBlob?.nonce ?? null, imapBlob?.authTag ?? null,
      imapBlob?.dekCiphertext ?? null, imapBlob?.dekNonce ?? null, imapBlob?.dekAuthTag ?? null,
      existing?.created_at ?? now, now,
    );

    logger.info({ id, label: input.label, isDefault: input.isDefault }, 'System email account upserted');
    const row = sqlite.prepare(`SELECT * FROM system_email_accounts WHERE id = ?`).get(id) as DbRow;
    return this.mapRow(row);
  }

  delete(id: string, tenantId: string): boolean {
    const { sqlite } = getDatabase();
    const res = sqlite.prepare(`DELETE FROM system_email_accounts WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
    return res.changes > 0;
  }

  /**
   * Create or update an OAuth2 email account (Gmail XOAUTH2).
   *
   * Called by `/email-accounts/oauth/google/callback` after the
   * authorization code grant. Stores the refresh + access tokens encrypted
   * with the same KEK used for password vault entries.
   *
   * SMTP/IMAP host+port are baked from the provider so the workflow author
   * doesn't have to know them — `Gmail` always means smtp.gmail.com:465 +
   * imap.gmail.com:993, both TLS. The XOAUTH2 layer kicks in at send-time
   * (via `resolveForExecutor` returning `authType:'oauth2'` + access token).
   */
  upsertOAuthAccount(args: {
    tenantId: string;
    existingId?: string;
    label: string;
    fromAddress: string;
    isDefault: boolean;
    provider: 'google';
    email: string;
    refreshToken: string;
    accessToken: string;
    expiresAt: Date;
    scope: string;
  }): SystemEmailAccount {
    const { sqlite } = getDatabase();
    const master = loadMaster();
    const id = args.existingId ?? nanoid();
    const now = new Date().toISOString();

    if (args.isDefault) {
      sqlite.prepare(`UPDATE system_email_accounts SET is_default = 0 WHERE tenant_id = ?`).run(args.tenantId);
    }

    const refreshBlob = encBlob(args.refreshToken, master);
    const accessBlob = encBlob(args.accessToken, master);

    // Provider preset — caller may override per-account, but these are the
    // values Google publishes per la XOAUTH2 transport.
    //
    // 2026-06-05: cambio port 465 → 587 (STARTTLS). Hetzner (e molti altri
    // datacenter EU) blocca la port 465 outbound by default come politica
    // anti-spam — i container in cgroup user-net non riescono a stabilire
    // la TCP connection a smtp.gmail.com:465 → connection timeout. La port
    // 587 (Mail Submission, STARTTLS) e\` SEMPRE aperta. Gmail XOAUTH2 funziona
    // identico su entrambe.
    const PROVIDER_PRESETS: Record<'google', { smtp: { host: string; port: number; security: 'tls' | 'starttls' }; imap: { host: string; port: number } }> = {
      google: {
        smtp: { host: 'smtp.gmail.com', port: 587, security: 'starttls' },
        imap: { host: 'imap.gmail.com', port: 993 },
      },
    };
    const preset = PROVIDER_PRESETS[args.provider];

    sqlite.prepare(`
      INSERT INTO system_email_accounts (
        id, tenant_id, label, from_address, is_default,
        smtp_host, smtp_port, smtp_security, smtp_username,
        imap_host, imap_port, imap_username,
        auth_type, oauth_provider, oauth_email, oauth_scope, oauth_expires_at,
        oauth_refresh_ciphertext, oauth_refresh_nonce, oauth_refresh_auth_tag,
        oauth_refresh_dek_ciphertext, oauth_refresh_dek_nonce, oauth_refresh_dek_auth_tag,
        oauth_access_ciphertext, oauth_access_nonce, oauth_access_auth_tag,
        oauth_access_dek_ciphertext, oauth_access_dek_nonce, oauth_access_dek_auth_tag,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'oauth2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, from_address = excluded.from_address, is_default = excluded.is_default,
        smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_security = excluded.smtp_security,
        smtp_username = excluded.smtp_username,
        imap_host = excluded.imap_host, imap_port = excluded.imap_port, imap_username = excluded.imap_username,
        auth_type = 'oauth2',
        oauth_provider = excluded.oauth_provider, oauth_email = excluded.oauth_email,
        oauth_scope = excluded.oauth_scope, oauth_expires_at = excluded.oauth_expires_at,
        oauth_refresh_ciphertext = excluded.oauth_refresh_ciphertext,
        oauth_refresh_nonce = excluded.oauth_refresh_nonce,
        oauth_refresh_auth_tag = excluded.oauth_refresh_auth_tag,
        oauth_refresh_dek_ciphertext = excluded.oauth_refresh_dek_ciphertext,
        oauth_refresh_dek_nonce = excluded.oauth_refresh_dek_nonce,
        oauth_refresh_dek_auth_tag = excluded.oauth_refresh_dek_auth_tag,
        oauth_access_ciphertext = excluded.oauth_access_ciphertext,
        oauth_access_nonce = excluded.oauth_access_nonce,
        oauth_access_auth_tag = excluded.oauth_access_auth_tag,
        oauth_access_dek_ciphertext = excluded.oauth_access_dek_ciphertext,
        oauth_access_dek_nonce = excluded.oauth_access_dek_nonce,
        oauth_access_dek_auth_tag = excluded.oauth_access_dek_auth_tag,
        updated_at = excluded.updated_at
    `).run(
      id, args.tenantId, args.label, args.fromAddress, args.isDefault ? 1 : 0,
      preset.smtp.host, preset.smtp.port, preset.smtp.security, args.email,
      preset.imap.host, preset.imap.port, args.email,
      args.provider, args.email, args.scope, args.expiresAt.toISOString(),
      refreshBlob.ciphertext, refreshBlob.nonce, refreshBlob.authTag,
      refreshBlob.dekCiphertext, refreshBlob.dekNonce, refreshBlob.dekAuthTag,
      accessBlob.ciphertext, accessBlob.nonce, accessBlob.authTag,
      accessBlob.dekCiphertext, accessBlob.dekNonce, accessBlob.dekAuthTag,
      now, now,
    );
    logger.info({ id, label: args.label, provider: args.provider, email: args.email }, 'OAuth email account upserted');
    const row = sqlite.prepare(`SELECT * FROM system_email_accounts WHERE id = ?`).get(id) as DbRow;
    return this.mapRow(row);
  }

  /**
   * Refresh-and-store: after `EmailOAuthService.refreshAccessToken` returns
   * a new access token, persist it + the new `expires_at`. Refresh token
   * stays put — Google rotates it only rarely (long-lived refresh).
   */
  updateOAuthAccessToken(args: {
    tenantId: string;
    accountId: string;
    accessToken: string;
    expiresAt: Date;
  }): void {
    const { sqlite } = getDatabase();
    const master = loadMaster();
    const accessBlob = encBlob(args.accessToken, master);
    sqlite.prepare(`
      UPDATE system_email_accounts SET
        oauth_access_ciphertext = ?, oauth_access_nonce = ?, oauth_access_auth_tag = ?,
        oauth_access_dek_ciphertext = ?, oauth_access_dek_nonce = ?, oauth_access_dek_auth_tag = ?,
        oauth_expires_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND auth_type = 'oauth2'
    `).run(
      accessBlob.ciphertext, accessBlob.nonce, accessBlob.authTag,
      accessBlob.dekCiphertext, accessBlob.dekNonce, accessBlob.dekAuthTag,
      args.expiresAt.toISOString(), new Date().toISOString(),
      args.accountId, args.tenantId,
    );
  }

  /**
   * Engine-side resolver for OAuth: returns the decrypted refresh + access
   * tokens + the `expiresAt` so the caller can decide whether to refresh
   * first. Returns null when the account is not OAuth or not found.
   */
  resolveOAuthForExecutor(tenantId: string, accountId: string): {
    accountId: string;
    provider: string;
    email: string;
    scope: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  } | null {
    const { sqlite } = getDatabase();
    const row = sqlite.prepare(`SELECT * FROM system_email_accounts WHERE id = ? AND tenant_id = ? AND auth_type = 'oauth2'`)
      .get(accountId, tenantId) as DbRow | undefined;
    if (!row?.oauth_refresh_ciphertext || !row.oauth_access_ciphertext) return null;
    const master = loadMaster();
    try {
      const refreshToken = decBlob({
        ciphertext: row.oauth_refresh_ciphertext, nonce: row.oauth_refresh_nonce!, authTag: row.oauth_refresh_auth_tag!,
        dekCiphertext: row.oauth_refresh_dek_ciphertext!, dekNonce: row.oauth_refresh_dek_nonce!, dekAuthTag: row.oauth_refresh_dek_auth_tag!,
      }, master);
      const accessToken = decBlob({
        ciphertext: row.oauth_access_ciphertext, nonce: row.oauth_access_nonce!, authTag: row.oauth_access_auth_tag!,
        dekCiphertext: row.oauth_access_dek_ciphertext!, dekNonce: row.oauth_access_dek_nonce!, dekAuthTag: row.oauth_access_dek_auth_tag!,
      }, master);
      return {
        accountId: row.id,
        provider: row.oauth_provider ?? 'google',
        email: row.oauth_email ?? '',
        scope: row.oauth_scope ?? '',
        accessToken, refreshToken,
        expiresAt: new Date(row.oauth_expires_at ?? Date.now()),
      };
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to decrypt OAuth tokens');
      return null;
    }
  }

  private mapRow(row: DbRow): SystemEmailAccount {
    const authType: 'password' | 'oauth2' = row.auth_type === 'oauth2' ? 'oauth2' : 'password';
    const out: SystemEmailAccount = {
      id: row.id,
      label: row.label,
      fromAddress: row.from_address,
      isDefault: row.is_default === 1,
      authType,
      smtp: {
        host: row.smtp_host ?? '',
        port: row.smtp_port ?? 465,
        security: (row.smtp_security ?? 'tls') as 'tls' | 'starttls' | 'plain',
        username: row.smtp_username ?? '',
        hasPassword: row.smtp_pw_ciphertext !== null,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (authType === 'oauth2' && row.oauth_provider && row.oauth_email) {
      out.oauth = {
        provider: row.oauth_provider as 'google',
        email: row.oauth_email,
        expiresAt: row.oauth_expires_at ?? '1970-01-01T00:00:00.000Z',
      };
    }
    if (row.imap_host) {
      out.imap = {
        host: row.imap_host,
        port: row.imap_port ?? 993,
        username: row.imap_username ?? '',
        hasPassword: row.imap_pw_ciphertext !== null,
      };
    }
    return out;
  }
}
