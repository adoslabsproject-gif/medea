/**
 * Admin workflows health — visibility ops per workflow corrotti.
 *
 * Estratto da routes/admin.ts (#199 H14 split) — 1 endpoint:
 *   GET /admin/workflows/health[?tenantId=...]
 *
 * Elenca i workflow del tenant (default: tutti) con diagnostica schema.
 * Workflow corrotti (skipped da GET /workflows resilient) sono visibili
 * qui con ok=false + issues[]. Pattern: post-deploy / post-migration /
 * post-AI-scaffold debugging.
 */

import type { Hono } from 'hono';
import { tenantService } from '@/services/tenant.service.js';
import { WorkflowService, diagnoseWorkflowRow } from '@/services/workflow.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';

export function registerWorkflowsHealthRoutes(app: Hono): void {
  app.get('/admin/workflows/health', async (c) => {
    const tenantFilter = c.req.query('tenantId');
    const ws = new WorkflowService(new InMemoryEventBus());
    const tenants = tenantFilter ? [tenantFilter] : tenantService.list({}).tenants.map((t) => t.id);
    const result: {
      tenantId: string;
      workflowId: string;
      name: string;
      ok: boolean;
      issues?: { path: string; code: string; message: string }[];
    }[] = [];
    for (const tid of tenants) {
      const rows = await ws.listRowsForHealth(tid);
      for (const row of rows) {
        const diag = diagnoseWorkflowRow(row);
        result.push({
          tenantId: tid,
          workflowId: row.id,
          name: row.name,
          ok: diag.ok,
          ...(diag.issues ? { issues: diag.issues } : {}),
        });
      }
    }
    const corruptedCount = result.filter((r) => !r.ok).length;
    return c.json({
      total: result.length,
      ok: result.length - corruptedCount,
      corrupted: corruptedCount,
      workflows: result,
    });
  });
}
