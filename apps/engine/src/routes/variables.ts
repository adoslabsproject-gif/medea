import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { VariablesService } from '@/services/variables.service.js';
import { GlobalVariablesService } from '@/services/global-variables.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';

const SetVarSchema = z.object({
  value: z.unknown(),
});

export function createVariableRoutes(): Hono {
  const app = new Hono();
  const service = new VariablesService();
  const globals = new GlobalVariablesService();

  // Tenant-global variables (env-like, across workflows)
  app.get('/variables', (c) => {
    const tenantId = getTenantId(c);
    return c.json({ variables: globals.list(tenantId) });
  });

  app.put('/variables/:name', zValidator('json', SetVarSchema), (c) => {
    const tenantId = getTenantId(c);
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'Bad request' }, 400);
    globals.set(name, c.req.valid('json').value, tenantId);
    return c.json({ ok: true });
  });

  app.delete('/variables/:name', (c) => {
    const tenantId = getTenantId(c);
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'Bad request' }, 400);
    const ok = globals.delete(name, tenantId);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  app.get('/workflows/:id/variables', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    return c.json({ variables: service.list(id, tenantId) });
  });

  app.get('/workflows/:id/variables/:name', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const name = c.req.param('name');
    if (!id || !name) return c.json({ error: 'Bad request' }, 400);
    const value = service.get(id, name, tenantId);
    if (value === undefined) return c.json({ error: 'Not found' }, 404);
    return c.json({ value });
  });

  app.put('/workflows/:id/variables/:name', zValidator('json', SetVarSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    const name = c.req.param('name');
    if (!id || !name) return c.json({ error: 'Bad request' }, 400);
    await service.set(id, name, c.req.valid('json').value, tenantId, actorId);
    return c.json({ ok: true });
  });

  app.delete('/workflows/:id/variables/:name', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    const name = c.req.param('name');
    if (!id || !name) return c.json({ error: 'Bad request' }, 400);
    const ok = await service.delete(id, name, tenantId, actorId);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  return app;
}
