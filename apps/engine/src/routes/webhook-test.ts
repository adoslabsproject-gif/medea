/**
 * /api/v1/workflows/:id/webhook-test — start a "Listen for Test Event"
 * session for a webhook trigger. n8n parity feature.
 *
 *   POST /workflows/:id/webhook-test    → block up to 5 min waiting for a
 *                                          real webhook request to arrive;
 *                                          return the captured payload.
 *   DELETE /workflows/:id/webhook-test  → cancel the listener (the editor
 *                                          closed the panel).
 *
 * The actual catching happens in routes/webhooks.ts: when a request hits
 * /webhooks/:workflowId/* AND there is an active test listener, the route
 * forwards the request to publishTestEvent() — the listener resolves and
 * the editor renders the captured payload as a usable sample.
 *
 * The webhook request is STILL executed normally (the workflow runs); the
 * listener only OBSERVES. This matches n8n's "Production" mode behavior.
 */

import { Hono } from 'hono';
import {
  subscribeForTestEvent,
  cancelTestListener,
  hasTestListener,
} from '@/services/test-event-bus.service.js';
import { getTenantId } from '@/lib/tenant.js';

export function createWebhookTestRoutes(): Hono {
  const app = new Hono();

  app.post('/workflows/:id/webhook-test', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const workflowId = c.req.param('id');
    try {
      const event = await subscribeForTestEvent(getTenantId(c), workflowId);
      return c.json({ event });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      if (reason === 'timeout') return c.json({ error: 'timeout', message: 'Nessuna richiesta ricevuta entro 5 minuti' }, 408);
      if (reason === 'superseded') return c.json({ error: 'superseded' }, 409);
      if (reason === 'cancelled') return c.json({ error: 'cancelled' }, 410);
      return c.json({ error: reason }, 500);
    }
  });

  app.delete('/workflows/:id/webhook-test', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const workflowId = c.req.param('id');
    const ok = cancelTestListener(getTenantId(c), workflowId);
    return c.json({ cancelled: ok });
  });

  app.get('/workflows/:id/webhook-test/status', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const workflowId = c.req.param('id');
    return c.json({ listening: hasTestListener(getTenantId(c), workflowId) });
  });

  return app;
}
