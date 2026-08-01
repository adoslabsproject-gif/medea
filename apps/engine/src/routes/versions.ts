import { Hono } from 'hono';
import { WorkflowVersionsService } from '@/services/workflow-versions.service.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';

export function createVersionRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const versions = new WorkflowVersionsService(eventBus);
  const workflows = new WorkflowService(eventBus);

  app.post('/workflows/:id/versions', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const comment = c.req.query('comment') ?? undefined;
    const workflow = await workflows.get(id, tenantId);
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
    const result = versions.snapshot(workflow, tenantId, actorId, comment);
    return c.json(result, 201);
  });

  app.get('/workflows/:id/versions', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const list = versions.list(id, tenantId);
    return c.json({ versions: list, total: list.length });
  });

  app.get('/workflows/:id/versions/:versionId', (c) => {
    const tenantId = getTenantId(c);
    const versionId = c.req.param('versionId');
    if (!versionId) return c.json({ error: 'Bad request' }, 400);
    const workflow = versions.get(versionId, tenantId);
    if (!workflow) return c.json({ error: 'Version not found' }, 404);
    return c.json({ workflow });
  });

  app.post('/workflows/:id/versions/:versionId/rollback', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    const versionId = c.req.param('versionId');
    if (!id || !versionId) return c.json({ error: 'Bad request' }, 400);
    try {
      const result = await versions.rollback(id, versionId, tenantId, actorId);
      if (!result) return c.json({ error: 'Not found' }, 404);
      return c.json({ workflow: result });
    } catch (error) {
      logger.error({ err: error }, 'Rollback failed');
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get('/workflows/:id/versions/:versionA/diff/:versionB', (c) => {
    const tenantId = getTenantId(c);
    const versionA = c.req.param('versionA');
    const versionB = c.req.param('versionB');
    if (!versionA || !versionB) return c.json({ error: 'Bad request' }, 400);
    const diff = versions.diff(versionA, versionB, tenantId);
    if (!diff) return c.json({ error: 'One or both versions not found' }, 404);
    return c.json(diff);
  });

  return app;
}
