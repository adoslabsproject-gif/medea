/**
 * Sink for client-side JavaScript errors reported by the editor's
 * error-reporter.ts. Logged at warn level so they show in journalctl.
 */

import { Hono } from 'hono';
import { logger } from '@/lib/logger.js';
import { getContainerTenantId } from '@/lib/tenant.js';

export function createClientErrorsRoutes(): Hono {
  const app = new Hono();

  app.post('/client-errors', async (c) => {
    // PUBLIC sink (editor reports JS errors, no auth). The tenant label is the
    // container's own identity, not a client header — otherwise an attacker
    // could forge log entries attributed to another tenant.
    const tenantId = getContainerTenantId();
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const b = (body as Record<string, unknown>) ?? {};
    logger.warn(
      {
        tenantId,
        clientError: true,
        message: typeof b.message === 'string' ? b.message : null,
        source: typeof b.source === 'string' ? b.source : null,
        stack: typeof b.stack === 'string' ? b.stack.slice(0, 1000) : null,
        url: typeof b.url === 'string' ? b.url : null,
        userAgent: typeof b.userAgent === 'string' ? b.userAgent : null,
      },
      'Client-side error reported',
    );
    return c.json({ logged: true });
  });

  return app;
}
