/**
 * Workflow → sync REST endpoint.
 *
 * POST /api/v1/workflows/:id/invoke
 *   body  → triggerInput (any JSON)
 *   reply → last successful step's output, parsed if JSON
 *
 * This is the simplest "every workflow is a REST API" surface — also the
 * substrate the MCP bridge uses to advertise each workflow as a tool.
 *
 * Differences from /run:
 *   - /run returns the full step-by-step trace (operator-facing)
 *   - /invoke returns ONLY the terminal output (API-consumer-facing)
 */

import { Hono } from 'hono';
import { RunService } from '@/services/run.service.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { safeParseJson } from '@/lib/safe-parse-json.js';

export function createInvokeRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const runs = new RunService(eventBus);
  const workflows = new WorkflowService(eventBus);

  app.post('/workflows/:id/invoke', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const workflowId = c.req.param('id');

    let triggerInput: unknown = null;
    try {
      const text = await c.req.text();
      triggerInput = text ? JSON.parse(text) : null;
    } catch (err) {
      return c.json(
        {
          error: 'Body must be valid JSON',
          detail: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    const workflow = await workflows.get(workflowId, tenantId);
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

    // AUDIT FIX WE-16 (2026-06-09 MEDIUM): refuse invoke of disabled workflows.
    //
    // Pre-fix: invoke ignorava workflow.enabled → workflow disabilitato via
    // UI dell'operatore poteva comunque essere triggerato via REST/MCP. Side
    // effect: l'operatore credeva di aver "spento" un cron malfunzionante,
    // ma client esterni con la URL/MCP descriptor cached continuavano a
    // chiamare. Stesso allineamento del MCP service che filtra `enabled=1`.
    //
    // Post-fix: 409 esplicito con error code, payload diagnostico.
    if (!workflow.enabled) {
      logger.warn({ workflowId, tenantId }, '[WE-16] invoke rejected: workflow disabled');
      return c.json(
        {
          error: 'WORKFLOW_DISABLED',
          message: 'Workflow is disabled; enable it before invoking.',
        },
        409,
      );
    }

    try {
      const input: Parameters<RunService['execute']>[0] = {
        workflowId,
        tenantId,
        triggerType: 'invoke',
      };
      if (triggerInput !== null) input.triggerInput = triggerInput;
      if (actorId !== undefined) input.triggeredBy = actorId;

      const result = await runs.execute(input);

      if (result.status !== 'success') {
        const failed = (
          result.steps as { nodeId: string; status: string; error?: string | null }[]
        ).find((s) => s.status === 'error');
        return c.json(
          {
            status: result.status,
            runId: result.runId,
            error: failed?.error ?? 'Workflow ended without success',
            failedNodeId: failed?.nodeId,
          },
          422,
        );
      }

      const successSteps = (result.steps as { status: string; output: string }[]).filter(
        (s) => s.status === 'success',
      );
      const last = successSteps[successSteps.length - 1];
      return c.json({
        status: 'success',
        runId: result.runId,
        durationMs: result.totalDurationMs,
        result: safeParseJson(last?.output),
      });
    } catch (err) {
      logger.error({ err, workflowId }, 'Workflow invoke failed');
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}
