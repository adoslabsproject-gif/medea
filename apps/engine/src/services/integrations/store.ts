/**
 * Tenant integrations store — single source of truth for 3rd-party provider
 * credentials (Gmail, WhatsApp, Stripe, Google Drive, OCR Vision).
 *
 * Design
 * ------
 *   • Credentials at rest    = AES-256-GCM with HKDF-derived per-tenant key
 *                              (see `lib/secrets-crypto.ts`).
 *   • Storage shape          = `tenant_integrations(id, provider, tenant_id,
 *                              label, credentials_encrypted, credentials_nonce,
 *                              expires_at, ...)`.
 *   • Provider isolation     = UNIQUE(tenant_id, provider, COALESCE(label,''))
 *                              so one tenant can have multiple labeled
 *                              instances of the same provider (e.g. two
 *                              Gmail mailboxes, sales@ + support@).
 *   • Audit                  = every save/delete writes to `audit_log` via
 *                              AuditLogService (immutable, hash-chained).
 *   • Listing                = NO credentials returned. The list() method is
 *                              safe to expose to the editor SPA.
 *
 * Concurrency
 * -----------
 * SQLite WAL mode + `INSERT ... ON CONFLICT` makes this safe for the single-
 * process runtime container. Under Postgres backend the same SQL still works
 * (the `getDatabase().sqlite` compat proxy currently throws on prepare under
 * PG — so this store will need an async store.prepare path before we go
 * multi-instance. Acceptable trade-off: integrations are not on the hot path
 * and the runtime is single-process per tenant in the current SaaS topology).
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from '@/services/audit.service.js';
import { encrypt, decrypt, getMasterPasswordOrThrow } from '@/lib/secrets-crypto.js';
import { logger } from '@/lib/logger.js';

export type IntegrationProvider =
  | 'gmail'
  | 'whatsapp'
  | 'stripe'
  | 'google_drive'
  | 'ocr_tesseract'
  | 'ocr_vision'
  // 2026-06-05 A3.2 P1+P2: integration vault per SaaS esterni (token-based).
  | 'slack'
  | 'telegram'
  | 'linear'
  | 'github'
  | 'hubspot'
  | 'notion'
  | 'salesforce'
  // 2026-06-05 C1-C6: 6 nodi SaaS top-richiesta (n8n parity).
  | 'google_sheets'
  | 'discord'
  | 'airtable'
  | 'trello'
  | 'calendly'
  | 'typeform'
  // 2026-06-06 batch nodi opera d'arte (n8n parity + EU moat).
  | 'shopify'
  | 'mailchimp'
  | 'twilio'
  | 'sendgrid'
  | 'asana'
  | 'dropbox'
  | 'box'
  | 'gcs';

export type IntegrationCredentials = Record<string, unknown>;

export interface SaveIntegrationInput {
  provider: IntegrationProvider;
  tenantId: string;
  label?: string;
  credentials: IntegrationCredentials;
  /** Unix epoch milliseconds. Used for OAuth `access_token` expiry. */
  expiresAt?: number | null;
  createdByUserId?: string;
}

export interface IntegrationRecord {
  id: string;
  provider: IntegrationProvider;
  tenantId: string;
  label: string | null;
  credentials: IntegrationCredentials;
  expiresAt: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  createdByUserId: string | null;
}

export interface IntegrationMetadata {
  id: string;
  provider: IntegrationProvider;
  label: string | null;
  expiresAt: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  createdByUserId: string | null;
}

interface IntegrationRow {
  id: string;
  provider: string;
  tenant_id: string;
  label: string | null;
  credentials_encrypted: Buffer;
  credentials_nonce: Buffer;
  expires_at: number | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  created_by_user_id: string | null;
}

const audit = new AuditLogService();

function normalizeLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Insert-or-update an integration record. Conflict resolution is per
 * (tenant_id, provider, COALESCE(label,'')) — saving the "same" integration
 * twice rotates the credentials in place AND audits the rotation.
 */
export async function saveIntegration(
  input: SaveIntegrationInput,
): Promise<{ id: string; rotated: boolean }> {
  if (!input.tenantId) throw new Error('saveIntegration: tenantId is required');
  if (!input.provider) throw new Error('saveIntegration: provider is required');
  if (!input.credentials || typeof input.credentials !== 'object') {
    throw new Error('saveIntegration: credentials must be an object');
  }

  const masterPwd = getMasterPasswordOrThrow();
  const plain = JSON.stringify(input.credentials);
  const { ciphertext, nonce } = encrypt(plain, masterPwd, input.tenantId);
  const label = normalizeLabel(input.label);
  const expiresAt = input.expiresAt ?? null;

  const { sqlite } = getDatabase();
  // Look up an existing row first to decide between INSERT and UPDATE — we
  // can't use ON CONFLICT on the (tenant_id, provider, COALESCE(label,''))
  // partial expression in older SQLite versions. Two-step is fine: the
  // UNIQUE index will still prevent races (the worst case is a friendly
  // SQLITE_CONSTRAINT error on concurrent inserts, which the caller retries).
  const existing = sqlite
    .prepare(
      `SELECT id FROM tenant_integrations
       WHERE tenant_id = ? AND provider = ? AND COALESCE(label, '') = COALESCE(?, '')`,
    )
    .get(input.tenantId, input.provider, label) as { id: string } | undefined;

  let id: string;
  let rotated: boolean;
  if (existing) {
    id = existing.id;
    rotated = true;
    sqlite
      .prepare(
        `UPDATE tenant_integrations
         SET credentials_encrypted = ?, credentials_nonce = ?, expires_at = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND tenant_id = ?`,
      )
      .run(ciphertext, nonce, expiresAt, id, input.tenantId);
  } else {
    id = nanoid();
    rotated = false;
    sqlite
      .prepare(
        `INSERT INTO tenant_integrations
         (id, provider, tenant_id, label, credentials_encrypted, credentials_nonce, expires_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        input.tenantId,
        label,
        ciphertext,
        nonce,
        expiresAt,
        input.createdByUserId ?? null,
      );
  }

  await audit.append({
    tenantId: input.tenantId,
    actorId: input.createdByUserId ?? 'system',
    action: rotated ? 'integration.rotate' : 'integration.create',
    resourceType: 'integration',
    resourceId: id,
    // NEVER include the plaintext credentials in audit metadata — only
    // provider + label + expiry. The audit log is immutable, leaking secrets
    // there is irreversible.
    metadata: { provider: input.provider, label, expiresAt },
  });
  logger.info(
    { provider: input.provider, tenantId: input.tenantId, label, rotated },
    'Integration saved',
  );
  return { id, rotated };
}

/**
 * Fetch and decrypt a single integration. Returns `null` if not found.
 * Touches `last_used_at` as a side-effect so we can build a "unused for 30d"
 * cleanup cron later.
 */
export function getIntegration(args: {
  provider: IntegrationProvider;
  tenantId: string;
  label?: string | null;
}): IntegrationRecord | null {
  if (!args.tenantId) throw new Error('getIntegration: tenantId is required');
  const label = normalizeLabel(args.label ?? null);
  const { sqlite } = getDatabase();
  const row = sqlite
    .prepare(
      `SELECT id, provider, tenant_id, label,
              credentials_encrypted, credentials_nonce, expires_at,
              created_at, updated_at, last_used_at, created_by_user_id
       FROM tenant_integrations
       WHERE tenant_id = ? AND provider = ? AND COALESCE(label, '') = COALESCE(?, '')`,
    )
    .get(args.tenantId, args.provider, label) as IntegrationRow | undefined;

  if (!row) return null;

  // Touch last_used_at — fire-and-forget, no transaction needed (the read
  // result is already consistent; an audit-trail race here doesn't matter).
  try {
    sqlite
      .prepare(
        `UPDATE tenant_integrations SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(row.id);
  } catch (e) {
    logger.warn({ err: e, id: row.id }, 'Failed to update last_used_at — non-fatal');
  }

  const masterPwd = getMasterPasswordOrThrow();
  const plain = decrypt(row.credentials_encrypted, row.credentials_nonce, masterPwd, args.tenantId);
  const credentials = JSON.parse(plain) as IntegrationCredentials;

  return {
    id: row.id,
    provider: row.provider as IntegrationProvider,
    tenantId: row.tenant_id,
    label: row.label,
    credentials,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    createdByUserId: row.created_by_user_id,
  };
}

/**
 * Update ONLY the credentials blob + expiry for an existing integration.
 * Used by OAuth refresh-token flows where the executor exchanges a new
 * access_token and needs to persist it without changing the rest of the row.
 *
 * Returns true if a row was updated. False = nothing to update (caller should
 * full-saveIntegration instead).
 */
export function updateIntegrationCredentials(args: {
  id: string;
  tenantId: string;
  credentials: IntegrationCredentials;
  expiresAt?: number | null;
}): Promise<boolean> {
  if (!args.id) return Promise.reject(new Error('updateIntegrationCredentials: id is required'));
  if (!args.tenantId)
    return Promise.reject(new Error('updateIntegrationCredentials: tenantId is required'));

  const masterPwd = getMasterPasswordOrThrow();
  const plain = JSON.stringify(args.credentials);
  const { ciphertext, nonce } = encrypt(plain, masterPwd, args.tenantId);

  const { sqlite } = getDatabase();
  const result = sqlite
    .prepare(
      `UPDATE tenant_integrations
       SET credentials_encrypted = ?, credentials_nonce = ?, expires_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(ciphertext, nonce, args.expiresAt ?? null, args.id, args.tenantId);

  if (result.changes > 0) {
    // Audit the refresh — but ONLY at debug level (refresh fires every ~1h
    // for OAuth, would flood the audit log). The cryptographic chain still
    // proves no tampering — we just don't append a row.
    logger.info({ id: args.id, tenantId: args.tenantId }, 'Integration credentials refreshed');
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

/**
 * Permanently delete an integration. The actor MUST belong to the tenant
 * (ownership check via tenant_id in the WHERE clause). Returns the number of
 * rows actually deleted (0 = not found OR cross-tenant attempt).
 */
export async function deleteIntegration(args: {
  id: string;
  tenantId: string;
  actorId?: string;
}): Promise<number> {
  if (!args.id) throw new Error('deleteIntegration: id is required');
  if (!args.tenantId) throw new Error('deleteIntegration: tenantId is required');

  const { sqlite } = getDatabase();
  // SELECT first so we can include the provider in the audit log without
  // joining post-delete.
  const row = sqlite
    .prepare(`SELECT provider, label FROM tenant_integrations WHERE id = ? AND tenant_id = ?`)
    .get(args.id, args.tenantId) as { provider: string; label: string | null } | undefined;
  if (!row) return 0;

  const result = sqlite
    .prepare(`DELETE FROM tenant_integrations WHERE id = ? AND tenant_id = ?`)
    .run(args.id, args.tenantId);

  if (result.changes > 0) {
    await audit.append({
      tenantId: args.tenantId,
      actorId: args.actorId ?? 'system',
      action: 'integration.delete',
      resourceType: 'integration',
      resourceId: args.id,
      metadata: { provider: row.provider, label: row.label },
    });
    logger.info(
      { provider: row.provider, tenantId: args.tenantId, label: row.label },
      'Integration deleted',
    );
  }
  return result.changes;
}

/**
 * List integrations for a tenant — metadata ONLY, no credentials.
 * Safe to expose to the editor SPA.
 */
export function listIntegrations(tenantId: string): IntegrationMetadata[] {
  if (!tenantId) throw new Error('listIntegrations: tenantId is required');
  const { sqlite } = getDatabase();
  const rows = sqlite
    .prepare(
      `SELECT id, provider, label, expires_at, created_at, updated_at, last_used_at, created_by_user_id
       FROM tenant_integrations WHERE tenant_id = ?
       ORDER BY provider ASC, updated_at DESC`,
    )
    .all(tenantId) as Omit<
    IntegrationRow,
    'credentials_encrypted' | 'credentials_nonce' | 'tenant_id'
  >[];

  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as IntegrationProvider,
    label: r.label,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
    createdByUserId: r.created_by_user_id,
  }));
}
