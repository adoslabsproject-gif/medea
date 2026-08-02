/**
 * /api/v1/workflows/:id/extract-subworkflow — lift selected nodes into a
 * new workflow and replace them with a `logic_subworkflow` invocation.
 *
 * Body:
 *   {
 *     nodeIds: string[],        // nodes to extract from the current workflow
 *     newWorkflowName: string,  // name of the workflow to create
 *   }
 *
 * Behavior:
 *   1. Load the parent workflow.
 *   2. Validate every nodeId belongs to it. Reject otherwise.
 *   3. Split nodes:
 *        extracted = nodes ∈ selection
 *        kept      = nodes ∉ selection
 *      Edges are split into:
 *        inner     = both endpoints ∈ selection  → go to new workflow
 *        in-cross  = source ∉ selection, target ∈ selection
 *        out-cross = source ∈ selection, target ∉ selection
 *   4. Create the new workflow with `extracted` + `inner`.
 *      The new workflow starts with a `trigger_manual` (auto-added) so it
 *      can be invoked by a `logic_subworkflow`.
 *   5. In the parent workflow:
 *        - Remove `extracted` nodes and `inner`/`in-cross`/`out-cross` edges.
 *        - Insert ONE `logic_subworkflow` node pointing to the new workflow.
 *        - For every `in-cross` edge: rewrite target → subworkflow node.
 *        - For every `out-cross` edge: rewrite source → subworkflow node.
 *   6. Persist both workflows. Return the new workflow id + updated parent.
 *
 * Atomicity: the two updates run inside a single SQLite transaction.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { nanoid } from 'nanoid';
import { WorkflowService } from '@/services/workflow.service.js';
import { getDatabase } from '@/storage/db.js';
import { getTenantId } from '@/lib/tenant.js';
import { AuditLogService } from '@/services/audit.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import type { Workflow, CanvasNode, Edge } from '@medea/engine-core-schema';

const audit = new AuditLogService();

const ExtractBodySchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(2, 'Selezionare almeno 2 nodi per estrarli'),
  newWorkflowName: z.string().min(1).max(200),
});

export function createSubworkflowExtractRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);

  app.post('/workflows/:id/extract-subworkflow', zValidator('json', ExtractBodySchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const parentId = c.req.param('id');
    const { nodeIds, newWorkflowName } = c.req.valid('json');

    const parent = await workflows.get(parentId, getTenantId(c));
    if (!parent) return c.json({ error: 'Workflow not found' }, 404);

    const selection = new Set(nodeIds);
    const unknown = nodeIds.find((id) => !parent.nodes.some((n) => n.id === id));
    if (unknown !== undefined) {
      return c.json({ error: `Node ${unknown} not in workflow` }, 400);
    }

    // Split nodes & edges
    const extractedNodes = parent.nodes.filter((n) => selection.has(n.id));
    const keptNodes = parent.nodes.filter((n) => !selection.has(n.id));
    const innerEdges: Edge[] = [];
    const inCross: Edge[] = [];
    const outCross: Edge[] = [];
    for (const e of parent.edges) {
      const fromIn = selection.has(e.from);
      const toIn = selection.has(e.to);
      if (fromIn && toIn) innerEdges.push(e);
      else if (!fromIn && toIn) inCross.push(e);
      else if (fromIn && !toIn) outCross.push(e);
    }

    // Build the new workflow with a manual trigger at the front so it's runnable
    const triggerId = `t-${nanoid(8)}`;
    const minXExtracted = Math.min(...extractedNodes.map((n) => n.x));
    const avgY = extractedNodes.reduce((acc, n) => acc + n.y, 0) / Math.max(1, extractedNodes.length);
    const trigger: CanvasNode = { id: triggerId, defId: 'trigger_manual', x: minXExtracted - 240, y: avgY, config: {} };

    // First node(s) without inner-incoming edges in extracted → connect to trigger
    const innerTargets = new Set(innerEdges.map((e) => e.to));
    const headNodes = extractedNodes.filter((n) => !innerTargets.has(n.id));
    const triggerEdges: Edge[] = headNodes.map((n) => ({ from: triggerId, to: n.id }));

    const newWorkflow: Omit<Workflow, 'createdAt' | 'updatedAt'> = {
      id: nanoid(),
      schemaVersion: parent.schemaVersion,
      name: newWorkflowName,
      enabled: false,
      tenantId: getTenantId(c),
      description: `Estratto da "${parent.name}"`,
      nodes: [trigger, ...extractedNodes],
      edges: [...triggerEdges, ...innerEdges],
      nodeDefs: parent.nodeDefs,
      tags: parent.tags ?? [],
    };

    // Replace the extracted block in the parent with a single logic_subworkflow node
    const subNodeId = `sub-${nanoid(8)}`;
    const subNode: CanvasNode = {
      id: subNodeId,
      defId: 'logic_subworkflow',
      x: minXExtracted,
      y: avgY,
      config: { workflowId: newWorkflow.id },
    };
    const updatedEdges: Edge[] = [
      ...parent.edges.filter((e) => !selection.has(e.from) && !selection.has(e.to)),
      ...inCross.map((e) => ({ ...e, to: subNodeId })),
      ...outCross.map((e) => ({ ...e, from: subNodeId })),
    ];

    // Persist transactionally
    const { sqlite } = getDatabase();
    const tx = sqlite.transaction(() => {
      // create the new workflow
      const now = new Date().toISOString();
      sqlite.prepare(`
        INSERT INTO workflows (id, tenant_id, name, description, enabled, schema_version, nodes_json, edges_json, node_defs_json, tags_json, created_at, updated_at, created_by, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newWorkflow.id,
        getTenantId(c),
        newWorkflow.name,
        newWorkflow.description ?? '',
        0,
        newWorkflow.schemaVersion,
        JSON.stringify(newWorkflow.nodes),
        JSON.stringify(newWorkflow.edges),
        JSON.stringify(newWorkflow.nodeDefs ?? []),
        JSON.stringify(newWorkflow.tags ?? []),
        now,
        now,
        auth.userId,
        auth.userId,
      );
      // update the parent
      sqlite.prepare(`
        UPDATE workflows
        SET nodes_json = ?, edges_json = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(
        JSON.stringify([...keptNodes, subNode]),
        JSON.stringify(updatedEdges),
        now,
        parentId,
        getTenantId(c),
      );
    });
    tx();

    await audit.append({
      tenantId: getTenantId(c),
      action: 'workflow.subworkflow_extract',
      resourceType: 'workflow',
      resourceId: parentId,
      actorId: auth.userId,
      metadata: { newWorkflowId: newWorkflow.id, extractedNodeCount: extractedNodes.length },
    });

    const updatedParent = await workflows.get(parentId, getTenantId(c));
    const created = await workflows.get(newWorkflow.id, getTenantId(c));
    return c.json({ parent: updatedParent, subworkflow: created });
  });

  return app;
}
