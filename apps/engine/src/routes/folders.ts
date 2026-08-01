/**
 * Folders (projects) — hierarchical organization for workflows.
 * Each folder has parent_id (nullable for root) and inherits tenant.
 * Workflows reference folder via workflows.folder_id (nullable).
 *
 * Tree retrieval is on-demand client-side via /folders → array + parent_id
 * (small N, so we let the editor build the tree). For very large orgs
 * (>10k folders) a materialized-path index can be added later.
 */

import { Hono } from 'hono';
import { getDatabase } from '@/storage/db.js';
import { nanoid } from 'nanoid';
import { getTenantId } from '@/lib/tenant.js';

interface FolderRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

// F2 (2026-06-10): `workflow_folders` consolidata in migrate.schema.ts →
// SCHEMA_SQL, applicata da runMigrations al boot. Niente DDL inline.

export function createFolderRoutes(): Hono {
  const app = new Hono();

  app.get('/folders', (c) => {
    const tenantId = getTenantId(c);
    const { sqlite } = getDatabase();
    const rows = sqlite
      .prepare('SELECT * FROM workflow_folders WHERE tenant_id = ? ORDER BY name')
      .all(tenantId) as FolderRow[];
    return c.json({
      folders: rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        name: r.name,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  });

  app.post('/folders', async (c) => {
    const tenantId = getTenantId(c);
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const body = raw as { name?: unknown; parentId?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return c.json({ error: '`name` required' }, 400);
    }
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;

    if (parentId !== null) {
      const { sqlite } = getDatabase();
      const exists = sqlite
        .prepare('SELECT id FROM workflow_folders WHERE id = ? AND tenant_id = ?')
        .get(parentId, tenantId);
      if (!exists) return c.json({ error: 'Parent folder not found' }, 404);
    }

    const id = nanoid();
    const now = new Date().toISOString();
    const { sqlite } = getDatabase();
    sqlite
      .prepare(
        'INSERT INTO workflow_folders (id, tenant_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, tenantId, parentId, body.name.trim(), now, now);
    return c.json({ id, name: body.name.trim(), parentId, createdAt: now, updatedAt: now }, 201);
  });

  app.patch('/folders/:id', async (c) => {
    const tenantId = getTenantId(c);
    const folderId = c.req.param('id');
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const body = raw as { name?: unknown; parentId?: unknown };
    const { sqlite } = getDatabase();
    const current = sqlite
      .prepare('SELECT * FROM workflow_folders WHERE id = ? AND tenant_id = ?')
      .get(folderId, tenantId) as FolderRow | undefined;
    if (!current) return c.json({ error: 'Folder not found' }, 404);

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : current.name;
    let parentId = current.parent_id;
    if (body.parentId === null) parentId = null;
    else if (typeof body.parentId === 'string' && body.parentId) {
      if (body.parentId === folderId) return c.json({ error: 'Cannot parent a folder under itself' }, 400);
      parentId = body.parentId;
    }
    const now = new Date().toISOString();
    sqlite
      .prepare('UPDATE workflow_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?')
      .run(name, parentId, now, folderId);
    return c.json({ id: folderId, name, parentId, updatedAt: now });
  });

  app.delete('/folders/:id', (c) => {
    const tenantId = getTenantId(c);
    const folderId = c.req.param('id');
    const { sqlite } = getDatabase();
    // Detach children (re-parent to null) before delete; refuse if workflows still pinned
    const wfCount = (sqlite
      .prepare('SELECT COUNT(*) as c FROM workflows WHERE folder_id = ? AND tenant_id = ?')
      .get(folderId, tenantId) as { c: number } | undefined)?.c ?? 0;
    if (wfCount > 0) {
      return c.json({ error: `Folder has ${wfCount.toString()} workflow(s); move them first` }, 409);
    }
    sqlite
      .prepare('UPDATE workflow_folders SET parent_id = NULL WHERE parent_id = ? AND tenant_id = ?')
      .run(folderId, tenantId);
    const info = sqlite
      .prepare('DELETE FROM workflow_folders WHERE id = ? AND tenant_id = ?')
      .run(folderId, tenantId);
    return c.json({ removed: info.changes > 0 });
  });

  return app;
}
