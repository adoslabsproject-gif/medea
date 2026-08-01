/**
 * Viewer share routes:
 *  - /api/v1/viewer-share — owner manages tokens (CRUD)
 *  - /api/v1/share/:tenantId/:token/dashboard — PUBLIC, no auth
 *    Returns the same dashboard data the tenant owner sees in admin/* but
 *    scoped strictly to that tenant + token-validated.
 *
 * The public path is registered separately (in server.ts publicPaths)
 * so authMiddleware doesn't reject it.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ViewerShareService } from '@/services/viewer-share.service.js';
import { AdminStatsService } from '@/services/admin-stats.service.js';
import { requireRole } from '@/middleware/rbac.js';
import { getTenantId } from '@/lib/tenant.js';

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

export function createViewerShareRoutes(): Hono {
  const app = new Hono();
  const service = new ViewerShareService();

  // Path-specific — vedi commento in admin.ts. NON usare '*' wildcard quando
  // il sub-app e\` montato a /api/v1 (sibling routes /api/v1/dashboard/*
  // verrebbero bloccate dal middleware).
  app.use('/viewer-share/*', requireRole('owner'));
  app.use('/viewer-share', requireRole('owner'));

  app.get('/viewer-share', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ tokens: service.list(getTenantId(c)) });
  });

  app.post('/viewer-share', zValidator('json', CreateSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const body = c.req.valid('json');
    const opts: { name: string; expiresInDays?: number; createdBy?: string } = {
      name: body.name,
      createdBy: auth.userId,
    };
    if (body.expiresInDays !== undefined) opts.expiresInDays = body.expiresInDays;
    // BUG-FIX (audit coverage 2026-06-12): `service.create` è async (audit
    // durabile). Senza await la response serializzava una Promise pendente
    // → `{ token: {} }`, token undefined nel client = link condivisibile rotto.
    const token = await service.create(getTenantId(c), opts);
    return c.json({ token }, 201);
  });

  app.delete('/viewer-share/:id', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const ok = service.revoke(getTenantId(c), id, auth.userId);
    return c.json({ ok });
  });

  return app;
}

/**
 * Public read-only share dashboard. Mounted at /api/v1/share/:tenantId/:token/*.
 * authMiddleware MUST skip this prefix (set in server.ts publicPaths).
 */
export function createPublicShareRoutes(): Hono {
  const app = new Hono();
  const shareService = new ViewerShareService();
  const stats = new AdminStatsService();

  app.get('/share/:tenantId/:token/dashboard', (c) => {
    const tenantId = c.req.param('tenantId');
    const token = c.req.param('token');
    if (!tenantId || !token) return c.json({ error: 'Bad request' }, 400);
    const valid = shareService.verify(tenantId, token);
    if (!valid) return c.json({ error: 'Invalid or revoked share link' }, 401);
    return c.json({ tenantId, ...stats.tenantDashboard(tenantId) });
  });

  return app;
}
