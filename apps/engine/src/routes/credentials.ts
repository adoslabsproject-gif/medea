import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { CredentialsService } from '@/services/credentials.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { requireRole } from '@/middleware/auth.js';

const CreateCredSchema = z.object({
  name: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  plaintext: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
});

export function createCredentialsRoutes(): Hono {
  const app = new Hono();
  const service = new CredentialsService();

  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    const list = service.list(tenantId);
    return c.json({ credentials: list, total: list.length });
  });

  app.post('/', zValidator('json', CreateCredSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const body = c.req.valid('json');
    const input: Parameters<CredentialsService['create']>[0] = {
      name: body.name,
      provider: body.provider,
      plaintext: body.plaintext,
      tenantId,
    };
    if (body.metadata !== undefined) input.metadata = body.metadata;
    if (actorId !== undefined) input.actorId = actorId;
    const created = await service.create(input);
    return c.json({ credential: created }, 201);
  });

  // HIGH (2026-05-29): role gate. Reveal del plaintext deve essere
  // riservato a owner/superadmin del workspace tenant — un editor/viewer
  // non deve poter esfiltrare segreti API key tramite UI.
  app.get('/:id/reveal', requireRole('owner', 'superadmin'), (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const plaintext = service.reveal(id, tenantId);
    if (plaintext === null) return c.json({ error: 'Not found' }, 404);
    return c.json({ plaintext });
  });

  app.delete('/:id', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'Bad request' }, 400);
    const ok = await service.delete(id, tenantId, actorId);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  return app;
}
