import { Hono } from 'hono';
import { LicenseService } from '@/services/license.service.js';
import { getTenantId } from '@/lib/tenant.js';

export function createLicenseRoutes(): Hono {
  const app = new Hono();
  const service = new LicenseService();

  app.get('/license/status', async (c) => {
    const tenantId = getTenantId(c);
    const status = await service.getStatus(tenantId);
    return c.json(status);
  });

  app.post('/license/install', async (c) => {
    const tenantId = getTenantId(c);
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const token = (raw as { token?: unknown }).token;
    if (typeof token !== 'string' || !token.trim()) {
      return c.json({ error: '`token` (string) required' }, 400);
    }
    try {
      const status = await service.install(tenantId, token.trim());
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
    }
  });

  app.delete('/license', (c) => {
    const tenantId = getTenantId(c);
    const removed = service.remove(tenantId);
    return c.json({ removed });
  });

  return app;
}
