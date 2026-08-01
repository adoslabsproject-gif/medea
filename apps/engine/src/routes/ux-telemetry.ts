/**
 * /api/v1/ux/events       — POST: client-side tracker records a milestone event.
 * /api/v1/admin/ux/funnel — GET (superadmin): cross-tenant funnel for the dashboard.
 * /api/v1/admin/ux/stuck  — GET (superadmin): stuck-users report.
 * /api/v1/admin/ux/recent — GET (superadmin): last 200 events.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { UxTelemetryService, type UxEventType } from '@/services/ux-telemetry.service.js';
import { requireSuperAdmin } from '@/middleware/rbac.js';
import { getTenantId } from '@/lib/tenant.js';

const ALLOWED_EVENT_TYPES: readonly UxEventType[] = [
  'workflow_created',
  'node_added_unconfigured',
  'run_blocked_validation',
  'run_started',
  'run_completed',
  'welcome_dismissed',
  'tour_completed',
  'helpchat_opened',
  'helpchat_message_sent',
  'wizard_started',
  'wizard_finished',
  'template_used',
];

const RecordEventSchema = z.object({
  eventType: z.enum(ALLOWED_EVENT_TYPES as unknown as [UxEventType, ...UxEventType[]]),
  workflowId: z.string().optional(),
  nodeId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createUxTelemetryRoutes(): Hono {
  const app = new Hono();
  const service = new UxTelemetryService();

  // ─── Client tracker endpoint ─────────────────────────────────────
  app.post('/events', zValidator('json', RecordEventSchema), (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const body = c.req.valid('json');
    service.record({
      tenantId: getTenantId(c),
      userId: auth.userId,
      eventType: body.eventType,
      ...(body.workflowId !== undefined ? { workflowId: body.workflowId } : {}),
      ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });
    return c.json({ ok: true });
  });

  // ─── Admin dashboard endpoints (superadmin only) ─────────────────
  app.get('/admin/funnel', requireSuperAdmin(), (c) => {
    const sinceHours = Number(c.req.query('sinceHours') ?? '24');
    return c.json({ funnel: service.funnel({ sinceHours }) });
  });

  app.get('/admin/stuck', requireSuperAdmin(), (c) => {
    const sinceHours = Number(c.req.query('sinceHours') ?? '24');
    return c.json({ stuck: service.stuckUsers({ sinceHours }) });
  });

  app.get('/admin/recent', requireSuperAdmin(), (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '200')));
    const tenantId = c.req.query('tenantId');
    return c.json({ events: service.recent(limit, tenantId) });
  });

  return app;
}
