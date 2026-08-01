/**
 * /api/v1/signals/:signalName — the external API that wakes paused workflows.
 *
 * Auth: requires session token (workflows are tenant-scoped — only same-tenant
 * users can fire signals). Service-to-service calls also work via the
 * internal token header (x-internal-token).
 *
 * Flow:
 *   1. POST /api/v1/signals/contract_signed with {orderId: "abc"}
 *   2. PausedWorkflowsService.resumeBySignal() flips status, returns rows.
 *   3. For each resumed row, RunService.resumeFromPause() rebuilds the
 *      engine state and continues execution from the wait_signal node's
 *      downstream edges.
 */

import { Hono } from 'hono';
import { PausedWorkflowsService } from '@/services/paused-workflows.service.js';
import type { RunService } from '@/services/run.service.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';

export function createSignalRoutes(runs: RunService): Hono {
  const app = new Hono();
  const paused = new PausedWorkflowsService();

  // POST /:signalName — fire a signal; resumes all matching paused workflows
  app.post('/:signalName', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const signalName = c.req.param('signalName');
    let payload: unknown = {};
    try {
      payload = await c.req.json();
    } catch {
      // body optional
    }

    const resumed = paused.resumeBySignal(getTenantId(c), signalName, payload);
    // Resume execution for each row — asynchronously, in the background.
    // The HTTP response returns immediately with the count.
    for (const row of resumed) {
      runs.resumeFromPause(row).catch((err: unknown) => {
        logger.error({ err, pausedId: row.id, runId: row.runId }, 'Failed to resume paused workflow');
      });
    }
    return c.json({ resumed: resumed.length, signal: signalName });
  });

  // GET / — list paused workflows for the tenant (UI dashboard)
  app.get('/', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const status = c.req.query('status') as 'waiting' | 'resumed' | 'timeout' | 'cancelled' | undefined;
    const list = paused.listByTenant(getTenantId(c), status);
    return c.json({ paused: list, total: list.length });
  });

  // DELETE /:id — cancel a paused workflow (UI: "give up waiting")
  app.delete('/:id', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const ok = paused.cancel(id, getTenantId(c));
    return c.json({ cancelled: ok });
  });

  return app;
}
