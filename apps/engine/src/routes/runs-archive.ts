/**
 * Runs archive endpoints (F3 Cappella 2026-06-07 sera).
 *
 *  - GET /api/v1/workflows/:id/runs/archive — lista file archivio
 *  - GET /api/v1/workflows/:id/runs/archive/:filename — download .jsonl.gz
 *
 * Auth: token cookie + tenant guard (lo stesso pattern di /workflows/:id).
 *
 * Path-traversal hardening: `archivePathSafe` rifiuta filename con / \\ ..
 * o con format diverso da `runs-YYYY-MM-<id>.jsonl.gz`.
 */
import { Hono } from 'hono';
import { readFileSync, statSync } from 'node:fs';
import { listArchives, archivePathSafe } from '@/services/runs-archive.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';

export function createRunsArchiveRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const wfSvc = new WorkflowService(eventBus);

  app.get('/workflows/:id/runs/archive', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const wf = await wfSvc.get(id, tenantId);
    if (!wf) return c.json({ error: 'Not found' }, 404);
    return c.json({ archives: listArchives(id) });
  });

  app.get('/workflows/:id/runs/archive/:filename', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const filename = c.req.param('filename');
    const wf = await wfSvc.get(id, tenantId);
    if (!wf) return c.json({ error: 'Not found' }, 404);
    const path = archivePathSafe(id, filename);
    if (!path) return c.json({ error: 'Invalid filename' }, 400);
    try { statSync(path); } catch { return c.json({ error: 'Archive not found' }, 404); }
    // Lettura sincrona — dimensione tipica < 50MB (gzip rate ~70%). Per
    // archivi più grandi un futuro PR può migrare a stream-based response.
    const body = readFileSync(path);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(body.length),
      },
    });
  });

  return app;
}
