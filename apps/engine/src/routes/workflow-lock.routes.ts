/**
 * Endpoint del lock di editing (Tier 1 multi-user, #7), estratti per testabilità
 * in isolamento. Registra su un'app Hono i 4 endpoint REST sopra il
 * WorkflowLockService. Identità = auth.userId (banner usa email come nome).
 *
 * 2026-06-09 AUDIT FIX H3+M3:
 *   - **H3 tenant gate**: ogni mutating handler (POST/POST heartbeat/DELETE)
 *     verifica `workflowService.get(workflowId, auth.tenantId)` come gate
 *     iniziale. Superadmin impersonate con workflow_id di altro tenant non
 *     può più rubare/refresh/release il lock di un altro tenant.
 *   - **M3 zombie row prevention**: il check `service.get` impedisce di creare
 *     row `workflow_locks` per workflow inesistenti (id sconosciuto → 404 invece
 *     di insert in DB).
 *   - GET resta passante (read-only, no effetto collaterale): mostra lock status
 *     anche per id sconosciuto (defaultDecision unlocked).
 */
import type { Hono } from 'hono';
import type { WorkflowLockService } from '@/services/workflow-lock.service.js';
import type { WorkflowService } from '@/services/workflow.service.js';

export function registerWorkflowLockRoutes(
  app: Hono,
  lockService: WorkflowLockService,
  workflowService: WorkflowService,
): void {
  app.get('/:id/lock', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(lockService.status(c.req.param('id'), auth.userId));
  });

  app.post('/:id/lock', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    // H3+M3 tenant gate: il workflow deve esistere E appartenere al tenant.
    const wf = await workflowService.get(id, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    const decision = lockService.acquire(id, auth.userId, auth.email);
    return c.json(
      { acquired: decision.ok, decision, status: lockService.status(id, auth.userId) },
      decision.ok ? 200 : 409,
    );
  });

  app.post('/:id/lock/heartbeat', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const wf = await workflowService.get(id, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    const renewed = lockService.heartbeat(id, auth.userId);
    return c.json({ renewed }, renewed ? 200 : 409);
  });

  app.delete('/:id/lock', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const wf = await workflowService.get(id, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    lockService.release(id, auth.userId);
    return c.json({ released: true });
  });

  /**
   * AUDIT FIX M4 (2026-06-09): POST alias per sendBeacon-based release.
   *
   * `navigator.sendBeacon()` supporta SOLO POST. Per garantire release del
   * lock anche su tab chiusa brutalmente (window close, OS shutdown) il client
   * fa `sendBeacon(POST /lock/release)` invece di DELETE. Semantica identica
   * al DELETE — duplicate route per compatibilità Page Lifecycle browser.
   * Pattern allineato a Stripe/Auth0/Linear (POST alias per "tracking exit").
   */
  app.post('/:id/lock/release', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const id = c.req.param('id');
    const wf = await workflowService.get(id, auth.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    lockService.release(id, auth.userId);
    return c.json({ released: true });
  });
}
