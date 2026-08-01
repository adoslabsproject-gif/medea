/**
 * Viewer share token — let a tenant owner generate a public, no-login link
 * that exposes a READ-ONLY dashboard for the tenant.
 *
 * Token shape: opaque random 32-byte hex string. Used in URL
 *   /share/:tenantId/:token
 * Tokens can be revoked or expire. Access count + last-access timestamp
 * are tracked for audit.
 *
 * Security:
 *  - Token is random, not guessable
 *  - Stored as plaintext (it IS the secret URL — no extra derivation needed)
 *  - One token = one tenant (no cross-tenant escalation)
 *  - Revocable instantly (set revoked_at)
 *  - Server enforces tenantId match — token bound to tenant in DB
 */

import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from './audit.service.js';

const audit = new AuditLogService();

export interface ViewerShareToken {
  id: string;
  tenantId: string;
  token: string;
  name: string;
  createdBy?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastAccessedAt?: string;
  accessCount: number;
}

interface ViewerShareTokenRow {
  id: string;
  tenant_id: string;
  token: string;
  name: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

function rowToToken(r: ViewerShareTokenRow): ViewerShareToken {
  const t: ViewerShareToken = {
    id: r.id,
    tenantId: r.tenant_id,
    token: r.token,
    name: r.name,
    createdAt: r.created_at,
    accessCount: r.access_count,
  };
  if (r.created_by) t.createdBy = r.created_by;
  if (r.expires_at) t.expiresAt = r.expires_at;
  if (r.revoked_at) t.revokedAt = r.revoked_at;
  if (r.last_accessed_at) t.lastAccessedAt = r.last_accessed_at;
  return t;
}

export class ViewerShareService {
  list(tenantId: string): ViewerShareToken[] {
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT * FROM viewer_share_tokens WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(tenantId) as ViewerShareTokenRow[];
    return rows.map(rowToToken);
  }

  async create(tenantId: string, opts: { name: string; expiresInDays?: number; createdBy?: string }): Promise<ViewerShareToken> {
    const { sqlite } = getDatabase();
    const id = nanoid();
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = opts.expiresInDays !== undefined
      ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    sqlite
      .prepare(
        'INSERT INTO viewer_share_tokens (id, tenant_id, token, name, created_by, created_at, expires_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(id, tenantId, token, opts.name, opts.createdBy ?? null, now, expiresAt);

    // #208 P0-9: await — audit durable.
    await audit.append({
      tenantId,
      action: 'viewer_share.create',
      resourceType: 'viewer_share_token',
      resourceId: id,
      ...(opts.createdBy ? { actorId: opts.createdBy } : {}),
      metadata: { name: opts.name, expiresAt },
    });

    return rowToToken({
      id,
      tenant_id: tenantId,
      token,
      name: opts.name,
      created_by: opts.createdBy ?? null,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      last_accessed_at: null,
      access_count: 0,
    });
  }

  async revoke(tenantId: string, id: string, actorId?: string): Promise<boolean> {
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();
    const info = sqlite
      .prepare('UPDATE viewer_share_tokens SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL')
      .run(now, id, tenantId);
    if (info.changes > 0) {
      // #208 P0-9: await — audit durable.
      await audit.append({
        tenantId,
        action: 'viewer_share.revoke',
        resourceType: 'viewer_share_token',
        resourceId: id,
        ...(actorId ? { actorId } : {}),
      });
    }
    return info.changes > 0;
  }

  /**
   * Verify a token coming from the public URL. Returns the tenantId if
   * valid, null otherwise. Side effects: increments access_count + sets
   * last_accessed_at.
   */
  verify(tenantId: string, token: string): { tenantId: string; tokenId: string } | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM viewer_share_tokens WHERE tenant_id = ? AND token = ?')
      .get(tenantId, token) as ViewerShareTokenRow | undefined;
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

    sqlite
      .prepare('UPDATE viewer_share_tokens SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);

    return { tenantId: row.tenant_id, tokenId: row.id };
  }
}
