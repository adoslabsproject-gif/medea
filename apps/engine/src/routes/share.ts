/**
 * Workflow shareable read-only links.
 * POST creates a token with TTL; GET resolves to a sanitized workflow view
 * (no secrets, no credentials references).
 */

import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';

// F2 (2026-06-10): `workflow_shares` consolidata in migrate.schema.ts →
// SCHEMA_SQL, applicata da runMigrations al boot. Niente DDL inline.

function redactConfig(value: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/key|secret|password|token|credential/i.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createShareRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);

  app.post('/workflows/:id/shares', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const wf = await workflows.get(id, tenantId);
    if (!wf) return c.json({ error: 'Not found' }, 404);

    // #194 M4 fix: role check minimo editor — viewer NON deve poter creare
    // share link pubblici (escalation: viewer leak entire workflow logic).
    const auth = c.get('auth') as { role?: string } | null;
    const role = auth?.role ?? 'viewer';
    const ALLOWED_SHARE_ROLES = new Set(['owner', 'admin', 'editor', 'superadmin']);
    if (!ALLOWED_SHARE_ROLES.has(role)) {
      return c.json({ error: { code: 'ROLE_FORBIDDEN', message: 'Solo editor+ può creare share link pubblici' } }, 403);
    }

    const ttlDays = Number(c.req.query('ttlDays') ?? '30');
    const token = randomBytes(24).toString('base64url');
    const expires = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;
    const { sqlite } = getDatabase();
    sqlite
      .prepare('INSERT INTO workflow_shares (token, workflow_id, tenant_id, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, id, tenantId, new Date().toISOString(), expires, actorId);

    return c.json({ token, expiresAt: expires, url: `/shared/${token}` }, 201);
  });

  app.get('/workflows/:id/shares', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT token, created_at, expires_at, view_count FROM workflow_shares WHERE workflow_id = ? AND tenant_id = ?')
      .all(id, tenantId);
    return c.json({ shares: rows });
  });

  app.delete('/workflows/:id/shares/:token', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const token = c.req.param('token');
    if (!id || !token) return c.json({ error: 'Bad request' }, 400);
    const { sqlite } = getDatabase();
    sqlite.prepare('DELETE FROM workflow_shares WHERE token = ? AND workflow_id = ? AND tenant_id = ?').run(token, id, tenantId);
    return c.body(null, 204);
  });

  // Public unauthenticated endpoint for share-link viewers
  app.get('/public/shared/:token', async (c) => {
    const token = c.req.param('token');
    if (!token) return c.json({ error: 'Bad request' }, 400);
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM workflow_shares WHERE token = ?')
      .get(token) as { token: string; workflow_id: string; tenant_id: string; expires_at: string | null } | undefined;
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return c.json({ error: 'Link expired' }, 410);
    }
    const wf = await workflows.get(row.workflow_id, row.tenant_id);
    if (!wf) return c.json({ error: 'Workflow no longer exists' }, 404);

    sqlite.prepare('UPDATE workflow_shares SET view_count = view_count + 1 WHERE token = ?').run(token);

    return c.json({
      workflow: {
        id: wf.id,
        name: wf.name,
        description: wf.description,
        schemaVersion: wf.schemaVersion,
        nodes: wf.nodes.map((n) => ({ ...n, config: redactConfig(n.config) })),
        edges: wf.edges,
        nodeDefs: wf.nodeDefs,
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
      },
      readOnly: true,
    });
  });

  return app;
}
