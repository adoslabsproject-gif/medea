/**
 * /api/v1/workflows/:id/test-node/:nodeId — run a SINGLE node in isolation.
 *
 * The n8n equivalent is "Execute Node" — invaluable during iterative
 * development when you don't want to re-run the whole workflow just to
 * test one node's reaction to a given input.
 *
 * Semantics:
 *   1. Load the workflow.
 *   2. Find the target node.
 *   3. Compute the carried input:
 *      - If the node has an upstream edge AND the upstream node has a pin,
 *        use the pinned value as the input.
 *      - Otherwise, accept a `triggerInput` from the request body.
 *      - Fallback: empty object {}.
 *   4. Invoke WorkflowEngine.executeNode for just that node. Bypass the
 *      BFS so downstream nodes are NOT triggered.
 *   5. Return { output, durationMs, status, error?, step }.
 *
 * Lifecycle:
 *   - Emits a `run.step` event so the canvas can flash the node's status ring.
 *   - Does NOT create a `runs` row — single-node tests are ephemeral.
 *   - Audit log: `workflow.test_node` with nodeId.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { WorkflowService } from '@/services/workflow.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { WorkflowEngine } from '@/engine/workflow-engine.js';
import { LlmProvidersService } from '@/services/llm-providers.service.js';
import { PinService } from '@/services/pin.service.js';
import { AuditLogService } from '@/services/audit.service.js';
import { interpolateConfig } from '@/engine/interpreter.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';

const TestNodeBodySchema = z.object({
  triggerInput: z.unknown().optional(),
});

/**
 * Ephemeral test-node body — accepts the WHOLE workflow draft so the user
 * doesn't need to save it before testing a single node. Mirrors n8n's
 * "Execute Node" which works on the unsaved canvas. Federico-reported
 * gap: "n8n permette test senza salvare, noi forziamo save".
 */
const EphemeralTestNodeBodySchema = z.object({
  nodeId: z.string().min(1),
  nodes: z.array(z.object({
    id: z.string(),
    defId: z.string(),
    config: z.record(z.string()).optional(),
  }).passthrough()),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
  }).passthrough()).optional(),
  triggerInput: z.unknown().optional(),
});

const audit = new AuditLogService();

export function createTestNodeRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);
  const pins = new PinService();
  const llmProviders = new LlmProvidersService();
  const engine = new WorkflowEngine(eventBus, { llmProviders });

  app.post('/workflows/:id/test-node/:nodeId', zValidator('json', TestNodeBodySchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const workflowId = c.req.param('id');
    const nodeId = c.req.param('nodeId');
    const body = c.req.valid('json');

    const workflow = await workflows.get(workflowId, getTenantId(c));
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return c.json({ error: `Node ${nodeId} not in workflow` }, 404);

    // Resolve carried input — priority: explicit request body > upstream pin > {}
    let carriedInput: unknown = body.triggerInput ?? {};
    const incomingEdge = workflow.edges.find((e) => e.to === nodeId);
    if (incomingEdge && body.triggerInput === undefined) {
      const upstreamPin = pins.get(workflowId, incomingEdge.from, getTenantId(c));
      if (upstreamPin?.enabled) carriedInput = upstreamPin.output;
    }

    const module = engine.resolveNodeModule(node.defId);
    if (!module) {
      return c.json({ error: `Unknown node definition: ${node.defId}` }, 400);
    }

    const startedAt = Date.now();
    try {
      const res = await engine.executeNode({
        node,
        module,
        carriedInput,
        outputsById: new Map(), // single-node, no vars
        tenantId: getTenantId(c),
        runId: `test-${Date.now().toString(36)}`,
        workflowId,
      });
      await audit.append({
        tenantId: getTenantId(c),
        action: 'workflow.test_node',
        resourceType: 'workflow',
        resourceId: workflowId,
        actorId: auth.userId,
        metadata: { nodeId, durationMs: Date.now() - startedAt, status: res.step.status },
      });
      return c.json({
        output: res.output,
        chosenBranch: res.chosenBranch,
        step: res.step,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      logger.warn({ err, workflowId, nodeId }, 'Test-node failed');
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      }, 500);
    }
  });

  /**
   * POST /workflows/test-node-ephemeral
   *
   * Run ONE node from an UNSAVED workflow draft. The caller passes the
   * whole node + edge list so the engine can resolve incoming/outgoing
   * connections without a persisted row.
   *
   * Observability: even though no `runs` row is created (the workflow
   * has no ID to attach it to), we DO write an audit log entry with
   * actor + node defId + duration + status. Owners need to see what
   * their editors are running, even when those runs don't persist.
   *
   * UX: the editor binds the "Esegui questo nodo" button to this endpoint
   * regardless of whether the draft has an ID — works on a brand-new
   * workflow before the user has clicked Save.
   */
  app.post('/workflows/test-node-ephemeral', zValidator('json', EphemeralTestNodeBodySchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const body = c.req.valid('json');

    const node = body.nodes.find((n) => n.id === body.nodeId);
    if (!node) return c.json({ error: `Node ${body.nodeId} non trovato nella bozza` }, 404);

    const module = engine.resolveNodeModule(node.defId);
    if (!module) return c.json({ error: `NodeDef sconosciuto: ${node.defId}` }, 400);

    const carriedInput: unknown = body.triggerInput ?? {};

    const startedAt = Date.now();
    const ephemeralRunId = `ephemeral-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await engine.executeNode({
        node: { id: node.id, defId: node.defId, x: 0, y: 0, config: (node.config ?? {}) },
        module,
        carriedInput,
        outputsById: new Map(),
        tenantId: getTenantId(c),
        runId: ephemeralRunId,
        workflowId: '__ephemeral__',
      });
      // Audit-log the ephemeral run so owners can see WHO ran WHAT, even
      // though the workflow itself wasn't saved.
      await audit.append({
        tenantId: getTenantId(c),
        action: 'workflow.test_node_ephemeral',
        resourceType: 'workflow',
        resourceId: '__ephemeral__',
        actorId: auth.userId,
        metadata: {
          nodeId: body.nodeId,
          defId: node.defId,
          runId: ephemeralRunId,
          durationMs: Date.now() - startedAt,
          status: res.step.status,
          totalNodesInDraft: body.nodes.length,
        },
      });
      return c.json({
        output: res.output,
        chosenBranch: res.chosenBranch,
        step: res.step,
        durationMs: Date.now() - startedAt,
        ephemeral: true,
        runId: ephemeralRunId,
      });
    } catch (err) {
      logger.warn({ err, nodeId: body.nodeId }, 'Ephemeral test-node failed');
      await audit.append({
        tenantId: getTenantId(c),
        action: 'workflow.test_node_ephemeral',
        resourceType: 'workflow',
        resourceId: '__ephemeral__',
        actorId: auth.userId,
        metadata: {
          nodeId: body.nodeId,
          defId: node.defId,
          runId: ephemeralRunId,
          durationMs: Date.now() - startedAt,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
        ephemeral: true,
        runId: ephemeralRunId,
      }, 500);
    }
  });

  return app;
}

// Sanity: keep `interpolateConfig` import alive — re-exported for future use
// (the test-node endpoint may pre-interpolate config when adding template
// preview). Removed `void` once we ship the preview UI in Batch 3.
void interpolateConfig;
