/**
 * Audit log read endpoint with cursor pagination.
 *
 * Pagination via `before` query (the id of the last seen entry — entries
 * are returned newest-first, so `before=X` means "give me older than X").
 * Response includes `nextBefore` cursor when more entries exist.
 */

import { Hono } from 'hono';
import { desc, eq, and, lt, like } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { auditLog } from '@/storage/schema.js';
import { getTenantId } from '@/lib/tenant.js';

function toCsvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/gu, '""')}"`;
  return s;
}

export function createAuditRoutes(): Hono {
  const app = new Hono();

  app.get('/audit', async (c) => {
    // tenantId from JWT-bound helper (honors superadmin override).
    const tenantId = getTenantId(c);
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '100')));
    const before = c.req.query('before');
    // ?actionPrefix=workflow.test_node — matches both workflow.test_node
    // and workflow.test_node_ephemeral. Used by the Test Runs tab in the
    // editor's RunHistoryView to surface single-node tests (which DON'T
    // create rows in the `runs` table by design).
    const actionPrefix = c.req.query('actionPrefix');
    const { db } = getDatabase();

    const conds = [eq(auditLog.tenantId, tenantId)];
    if (before) {
      const beforeId = Number(before);
      if (!Number.isFinite(beforeId)) {
        return c.json({ error: '`before` must be a numeric id' }, 400);
      }
      conds.push(lt(auditLog.id, beforeId));
    }
    if (actionPrefix) {
      conds.push(like(auditLog.action, `${actionPrefix}%`));
    }

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextBefore = hasMore && last ? last.id : null;

    return c.json({
      entries: page.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        actorId: r.actorId ?? null,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId ?? null,
        metadata: (() => {
          try {
            return JSON.parse(r.metadataJson ?? '{}') as unknown;
          } catch {
            return r.metadataJson;
          }
        })(),
        createdAt: r.createdAt,
        hash: r.hash,
        prevHash: r.prevHash,
      })),
      total: page.length,
      nextBefore,
      hasMore,
    });
  });

  /**
   * Export audit log as CSV or JSON download. No pagination — full tenant log.
   * Use ?format=csv (default) or ?format=json.
   */
  app.get('/audit/export', async (c) => {
    const tenantId = getTenantId(c);
    const format = c.req.query('format') === 'json' ? 'json' : 'csv';
    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(desc(auditLog.id));

    if (format === 'json') {
      return new Response(JSON.stringify(rows, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="audit-${tenantId}-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }

    const header = [
      'id',
      'tenant_id',
      'actor_id',
      'action',
      'resource_type',
      'resource_id',
      'metadata',
      'created_at',
      'hash',
      'prev_hash',
    ];
    const csv = [
      header.join(','),
      ...rows.map((r) =>
        [
          toCsvCell(r.id),
          toCsvCell(r.tenantId),
          toCsvCell(r.actorId),
          toCsvCell(r.action),
          toCsvCell(r.resourceType),
          toCsvCell(r.resourceId),
          toCsvCell(r.metadataJson),
          toCsvCell(r.createdAt),
          toCsvCell(r.hash),
          toCsvCell(r.prevHash),
        ].join(','),
      ),
    ].join('\n');

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-${tenantId}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  });

  return app;
}
