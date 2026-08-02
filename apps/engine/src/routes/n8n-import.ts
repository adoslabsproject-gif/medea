/**
 * n8n → FlowForge workflow JSON migration.
 *
 * n8n workflow shape (relevant fields):
 *   { name, nodes: [{ id, name, type, position, parameters, ... }], connections: { fromId: { main: [[{node, type, index}]] } } }
 *
 * Map n8n node types to FlowForge defIds. Unmapped types become a generic
 * 'action_http' node with the original parameters preserved for manual review.
 */

import { Hono } from 'hono';
import { n8nTypeToDefId, resolveNodeAlias } from '@/lib/node-aliases.js';
import { mapN8nParams } from '@/lib/n8n-param-map.js';
import { transpileConfigExpressions } from '@/lib/n8n-expression.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';

interface N8nNode {
  id?: string;
  name: string;
  type: string;
  position?: [number, number];
  parameters?: Record<string, unknown>;
}

interface N8nWorkflow {
  name?: string;
  nodes?: N8nNode[];
  connections?: Record<string, { main?: { node: string; type?: string; index?: number }[][] }>;
}

/** Pass 1: id/defId/posizione (il config arriva nel pass 2, serve la mappa nome→id). */
function convertNodeMeta(
  n8nNode: N8nNode,
  idx: number,
): { id: string; defId: string; x: number; y: number } {
  // Mapping n8n-type → defId via vocabolario condiviso (lib/node-aliases).
  const defId = n8nTypeToDefId(n8nNode.type);
  const id =
    (n8nNode.id ?? n8nNode.name).replace(/[^a-z0-9_-]/gi, '_') +
    (n8nNode.id ? '' : `_${idx.toString()}`);
  const x = n8nNode.position?.[0] ?? idx * 200;
  const y = n8nNode.position?.[1] ?? 100;
  return { id, defId, x, y };
}

function convertConnections(
  connections: NonNullable<N8nWorkflow['connections']>,
  nodeIdMap: Map<string, string>,
): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  for (const [sourceName, conn] of Object.entries(connections)) {
    const main = conn.main ?? [];
    for (const branch of main) {
      for (const target of branch) {
        const from = nodeIdMap.get(sourceName);
        const to = nodeIdMap.get(target.node);
        if (from && to) edges.push({ from, to });
      }
    }
  }
  return edges;
}

export function createN8nImportRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);

  app.post('/import/n8n', async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object')
      return c.json({ error: 'Body must be a JSON object' }, 400);
    const n8n = raw as N8nWorkflow;

    const n8nNodes = n8n.nodes ?? [];
    // Pass 1: id/defId/posizione + mappa nome-n8n → id-FlowForge (per le espressioni $node).
    const meta = n8nNodes.map((n, i) => convertNodeMeta(n, i));
    const nodeIdMap = new Map<string, string>();
    n8nNodes.forEach((n, i) => {
      const m = meta[i];
      if (m) nodeIdMap.set(n.name, m.id);
    });

    // Pass 2: parametri n8n → config FlowForge (mapper per-tipo) → transpile espressioni.
    const mappingWarnings: string[] = [];
    const converted = meta.map((m, i) => {
      const n = n8nNodes[i]!;
      const { config: mapped, warnings: mapW } = mapN8nParams(m.defId, n.parameters ?? {});
      const { config: cfg, warnings: exprW } = transpileConfigExpressions(mapped, nodeIdMap);
      cfg._n8nOriginalType = n.type;
      for (const w of [...mapW, ...exprW]) mappingWarnings.push(`${n.name}: ${w}`);
      return { ...m, config: cfg };
    });

    const edges = convertConnections(n8n.connections ?? {}, nodeIdMap);

    const unmappedTypes = new Set<string>();
    for (const n of n8nNodes) {
      if (!resolveNodeAlias(n.type)) unmappedTypes.add(n.type); // nessun alias = mappato a fallback action_http
    }

    const input: Parameters<WorkflowService['create']>[0] = {
      name: n8n.name ?? 'Imported from n8n',
      enabled: false,
      nodes: converted,
      edges,
      nodeDefs: [],
      tags: ['imported-from-n8n'],
      tenantId,
    };
    if (actorId !== undefined) input.createdBy = actorId;
    const created = await workflows.create(input);

    return c.json(
      {
        workflow: created,
        stats: {
          nodesImported: converted.length,
          edgesImported: edges.length,
          unmappedTypes: [...unmappedTypes],
          // Cosa l'utente deve rivedere a mano (auth, header, espressioni non convertibili,
          // strutture Set/IF, schedule). Trasparenza: l'import è un punto di partenza assistito.
          mappingWarnings,
          warnings:
            unmappedTypes.size > 0
              ? `${unmappedTypes.size.toString()} node type(s) had no direct mapping; converted to action_http with original parameters preserved in config._n8nOriginalType.`
              : null,
        },
      },
      201,
    );
  });

  return app;
}
