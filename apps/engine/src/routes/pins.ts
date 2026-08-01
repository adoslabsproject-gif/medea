import { Hono } from 'hono';
import { PinService } from '@/services/pin.service.js';
import { getTenantId } from '@/lib/tenant.js';

export function createPinRoutes(): Hono {
  const app = new Hono();
  const service = new PinService();

  app.get('/workflows/:id/pins', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    return c.json({ pins: service.list(id, tenantId) });
  });

  app.put('/workflows/:id/pins/:nodeId', async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const nodeId = c.req.param('nodeId');
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const body = raw as { output?: unknown; enabled?: boolean };
    if (body.output === undefined) return c.json({ error: '`output` required' }, 400);
    service.set(id, nodeId, body.output, body.enabled !== false, tenantId);
    return c.json({ ok: true });
  });

  app.delete('/workflows/:id/pins/:nodeId', (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const nodeId = c.req.param('nodeId');
    const removed = service.delete(id, nodeId, tenantId);
    return c.json({ removed });
  });

  return app;
}
