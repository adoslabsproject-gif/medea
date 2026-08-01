/**
 * Re-run a workflow from a specific failed node — without re-executing nodes
 * before it. Uses the original run's step outputs as pre-populated inputs.
 *
 * POST /api/v1/workflows/:wfId/runs/:runId/replay?fromNode=<nodeId>[&toNode=<nodeId>]
 *
 * Body (optional): {
 *   triggerInput?: any        — overrides if you want different inputs.
 *   pinnedOverrides?: Record<nodeId, any> — GAP 4 pin-edit: sostituisce al volo
 *     l'output pinnato di uno o più nodi a monte (l'utente edita i dati e
 *     ri-esegue SOLO il nodo target, senza toccare il workflow salvato).
 * }
 *
 * Behavior: loads the original run's steps, pins all step outputs BEFORE
 * `fromNode` so the engine returns them instead of re-executing, then runs
 * normally from `fromNode` onwards. n8n equivalent: "Replay from this node".
 *
 * GAP 4 (esecuzione parziale): `toNode` ferma l'engine DOPO quel nodo (coda
 * residua scartata). `fromNode=X&toNode=X` = "Esegui solo questo nodo":
 * antenati pinnati (istantanei), X ri-eseguito, grafo a valle NON toccato.
 */

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { runs } from '@/storage/schema.js';
import { RunService } from '@/services/run.service.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import type { RunStep } from '@flowforge/core-schema';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';

export function createRunReplayRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const runService = new RunService(eventBus);
  const workflowService = new WorkflowService(eventBus);

  app.post('/workflows/:wfId/runs/:runId/replay', async (c) => {
    const tenantId = getTenantId(c);
    const wfId = c.req.param('wfId');
    const runId = c.req.param('runId');
    const fromNode = c.req.query('fromNode');
    if (!fromNode) return c.json({ error: '`fromNode` query param required' }, 400);
    const toNode = c.req.query('toNode');

    const workflow = await workflowService.get(wfId, tenantId);
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

    // Bug-fix (pre-GAP 4): un fromNode INESISTENTE non interrompeva mai il
    // loop di pinning → TUTTI gli step venivano pinnati e il "replay"
    // restituiva in silenzio gli output storici senza eseguire nulla.
    // Validazione esplicita: 400, non un successo finto.
    const nodeIds = new Set(workflow.nodes.map((n) => n.id));
    if (!nodeIds.has(fromNode)) {
      return c.json({ error: `fromNode "${fromNode}" not found in workflow` }, 400);
    }
    if (toNode !== undefined && !nodeIds.has(toNode)) {
      return c.json({ error: `toNode "${toNode}" not found in workflow` }, 400);
    }

    const { db } = getDatabase();
    const [originalRun] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workflowId, wfId), eq(runs.tenantId, tenantId)))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    if (!originalRun) return c.json({ error: 'Original run not found' }, 404);

    let originalSteps: RunStep[] = [];
    try { originalSteps = JSON.parse(originalRun.stepsJson) as RunStep[]; } catch { /* keep empty */ }

    // Compute the "ancestors" of fromNode — all nodes that the engine traversed
    // BEFORE reaching fromNode. We pin their outputs so the engine skips them.
    // BFS-walk the original step list up to (excluding) fromNode.
    const pinnedOutputs = new Map<string, unknown>();
    for (const step of originalSteps) {
      if (step.nodeId === fromNode) break;
      if (step.status === 'success' && step.output) {
        let parsed: unknown = step.output;
        try { parsed = JSON.parse(step.output); } catch { /* keep string */ }
        pinnedOutputs.set(step.nodeId, parsed);
      }
    }

    // Optional trigger input override + GAP 4 pin-edit overrides
    let triggerInput: unknown = originalRun.input ? safeParseJson(originalRun.input) : undefined;
    let overriddenCount = 0;
    try {
      const text = await c.req.text();
      if (text) {
        const body = JSON.parse(text) as { triggerInput?: unknown; pinnedOverrides?: unknown };
        if (body && typeof body === 'object' && 'triggerInput' in body) {
          triggerInput = body.triggerInput;
        }
        if (body && typeof body === 'object' && body.pinnedOverrides !== undefined) {
          // Pin-edit: l'utente modifica i dati a monte e ri-esegue il nodo.
          // Solo chiavi che sono nodi REALI del workflow (una chiave fantasma
          // è un errore del client, non un soft-ignore: 400 esplicito).
          if (body.pinnedOverrides === null || typeof body.pinnedOverrides !== 'object' || Array.isArray(body.pinnedOverrides)) {
            return c.json({ error: '`pinnedOverrides` must be an object map nodeId→output' }, 400);
          }
          for (const [nodeId, value] of Object.entries(body.pinnedOverrides as Record<string, unknown>)) {
            if (!nodeIds.has(nodeId)) {
              return c.json({ error: `pinnedOverrides: node "${nodeId}" not found in workflow` }, 400);
            }
            pinnedOutputs.set(nodeId, value); // override DOPO i pin storici: vince l'edit
            overriddenCount += 1;
          }
        }
      }
    } catch (err) {
      // JSON malformato nel body = errore del client, non "tieni l'originale"
      if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const input: Parameters<RunService['execute']>[0] = {
      workflowId: wfId,
      tenantId,
      triggerType: `replay-from:${fromNode}`,
    };
    if (triggerInput !== undefined) input.triggerInput = triggerInput;
    if (toNode !== undefined) input.stopAfterNodeId = toNode;
    const actorId = getActorId(c) ?? undefined;
    if (actorId) input.triggeredBy = actorId;

    // RunService.execute pulls pinnedOutputs from PinService for this workflow.
    // For replay, we bypass the PinService and pass the map directly through a
    // one-shot execute method (added below).
    const result = await runService.executeWithPins(input, pinnedOutputs);
    return c.json({
      run: result,
      replayedFromNode: fromNode,
      ...(toNode !== undefined ? { stoppedAfterNode: toNode } : {}),
      pinnedCount: pinnedOutputs.size,
      overriddenCount,
    });
  });

  return app;
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
