import { createHash } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { auditLog } from '@/storage/schema.js';
import { desc } from 'drizzle-orm';

export interface AuditRecord {
  tenantId?: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

function computeHash(payload: {
  prevHash: string;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadataJson: string;
  createdAt: string;
}): string {
  const serialized = [
    payload.prevHash,
    payload.tenantId,
    payload.actorId,
    payload.action,
    payload.resourceType,
    payload.resourceId,
    payload.metadataJson,
    payload.createdAt,
  ].join('|');
  return createHash('sha256').update(serialized).digest('hex');
}

export class AuditLogService {
  async append(record: AuditRecord): Promise<void> {
    const { db } = getDatabase();
    const [last] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    const prevHash = last?.hash ?? 'GENESIS';
    const createdAt = new Date().toISOString();
    const metadataJson = JSON.stringify(record.metadata ?? {});

    const hash = computeHash({
      prevHash,
      tenantId: record.tenantId ?? 'default',
      actorId: record.actorId ?? 'system',
      action: record.action,
      resourceType: record.resourceType,
      resourceId: record.resourceId ?? '',
      metadataJson,
      createdAt,
    });

    const values: typeof auditLog.$inferInsert = {
      action: record.action,
      resourceType: record.resourceType,
      prevHash,
      hash,
      createdAt,
      metadataJson,
    };
    if (record.tenantId !== undefined) values.tenantId = record.tenantId;
    if (record.actorId !== undefined) values.actorId = record.actorId;
    if (record.resourceId !== undefined) values.resourceId = record.resourceId;

    await db.insert(auditLog).values(values);
  }

  /**
   * Variante SINCRONA di {@link append} — per i chiamanti che mutano dentro una
   * transazione better-sqlite3 sincrona (es. `TenantService.create` dentro
   * `sqlite.transaction(...)`, dove NON si può `await`).
   *
   * Perché esiste (audit 2026-07-02, finding #1): `TenantService` usava
   * `void this.audit.append(...)` — fire-and-forget. Un crash tra la mutazione e
   * il flush async dell'insert → l'evento andava perso → BUCO nella hash-chain
   * su operazioni GDPR-critiche (soft-delete tenant). È lo stesso bug #208 P0-9
   * già corretto in run.service/llm-providers.service, ma dimenticato qui.
   *
   * `appendSync` legge il `prev_hash` e inserisce nello STESSO tick sincrono
   * (better-sqlite3 è sincrono, Node è single-thread): niente fire-and-forget e
   * niente await-gap → la hash-chain non può forkarsi sotto concorrenza. Le
   * righe prodotte sono verificabili da {@link verifyIntegrity} in modo identico
   * a quelle di `append` (stesso coalescing NULL→default/system/'' in verifica).
   */
  appendSync(record: AuditRecord): void {
    const { sqlite } = getDatabase();
    const last = sqlite
      .prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? 'GENESIS';
    const createdAt = new Date().toISOString();
    const metadataJson = JSON.stringify(record.metadata ?? {});

    const hash = computeHash({
      prevHash,
      tenantId: record.tenantId ?? 'default',
      actorId: record.actorId ?? 'system',
      action: record.action,
      resourceType: record.resourceType,
      resourceId: record.resourceId ?? '',
      metadataJson,
      createdAt,
    });

    sqlite
      .prepare(
        `INSERT INTO audit_log
           (tenant_id, actor_id, action, resource_type, resource_id, metadata_json, prev_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.tenantId ?? 'default',
        record.actorId ?? null,
        record.action,
        record.resourceType,
        record.resourceId ?? null,
        metadataJson,
        prevHash,
        hash,
        createdAt,
      );
  }

  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }> {
    const { db } = getDatabase();
    const rows = await db.select().from(auditLog).orderBy(auditLog.id);
    let prev = 'GENESIS';
    for (const row of rows) {
      const expected = computeHash({
        prevHash: prev,
        tenantId: row.tenantId ?? 'default',
        actorId: row.actorId ?? 'system',
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId ?? '',
        metadataJson: row.metadataJson ?? '{}',
        createdAt: row.createdAt,
      });
      if (expected !== row.hash) {
        return { valid: false, brokenAt: row.id };
      }
      prev = row.hash;
    }
    return { valid: true };
  }
}
