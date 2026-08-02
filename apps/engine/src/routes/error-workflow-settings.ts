/**
 * GAP 5 (d) — settings del catch-all error-workflow di tenant.
 *
 *   GET /api/v1/settings/error-workflow  → { errorWorkflowId: string|null }
 *   PUT /api/v1/settings/error-workflow  → body { errorWorkflowId: string|null }
 *
 * PUT è owner-only (requireRole): cambiare il catch-all reindirizza il
 * fan-out di OGNI run fallito del tenant. Validazioni esplicite:
 *  - il workflow deve ESISTERE nel tenant (un id fantasma = catch-all che
 *    fallisce in silenzio a ogni errore);
 *  - deve CONTENERE un trigger_error (un handler senza entry-point error è
 *    quasi certamente una svista — 400 con messaggio chiaro);
 *  - null/'' rimuove il catch-all.
 * Ogni PUT è audit-loggato (hash-chain) con before/after.
 */
import { Hono } from 'hono';
import { WorkflowService } from '@/services/workflow.service.js';
import { AuditLogService } from '@/services/audit.service.js';
import {
  getTenantErrorWorkflowId,
  setTenantErrorWorkflowId,
} from '@/services/error-workflow-flag.service.js';
import { requireRole } from '@/middleware/rbac.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import type { IEventBus } from '@/ports/event-bus.js';

export function createErrorWorkflowSettingsRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);

  // RBAC esplicito anche sul GET (era asimmetrico col PUT owner-only): fail-closed
  // su ruolo ignoto. La lettura dell'id non è sensibile → 'viewer' (qualsiasi
  // membro autenticato), ma il gate esplicito evita il pass-through silenzioso.
  app.get('/settings/error-workflow', requireRole('viewer'), (c) => {
    return c.json({ errorWorkflowId: getTenantErrorWorkflowId() });
  });

  app.put('/settings/error-workflow', requireRole('owner'), async (c) => {
    const tenantId = getTenantId(c);
    let body: { errorWorkflowId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const raw = body.errorWorkflowId;
    if (raw !== null && typeof raw !== 'string') {
      return c.json({ error: '`errorWorkflowId` must be a string or null' }, 400);
    }
    const next = raw === null || raw === '' ? null : raw;

    if (next !== null) {
      const wf = await workflows.get(next, tenantId);
      if (!wf) {
        return c.json({ error: `Workflow "${next}" not found in tenant` }, 400);
      }
      if (!wf.nodes.some((n) => n.defId === 'trigger_error')) {
        return c.json(
          {
            error: `Workflow "${wf.name}" non ha un nodo trigger_error: aggiungilo come entry-point dell'handler prima di impostarlo come catch-all.`,
          },
          400,
        );
      }
    }

    const previous = getTenantErrorWorkflowId();
    setTenantErrorWorkflowId(next);
    try {
      await new AuditLogService().append({
        tenantId,
        actorId: getActorId(c) ?? 'system',
        action: 'settings.error_workflow.updated',
        resourceType: 'settings',
        resourceId: 'error_workflow_id',
        metadata: { previous, next },
      });
    } catch {
      /* fail-soft: il setting è applicato, l'audit non lo annulla */
    }
    return c.json({ ok: true, errorWorkflowId: next });
  });

  return app;
}
