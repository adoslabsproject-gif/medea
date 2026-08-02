/**
 * Missing-Node Wizard — REST API.
 *
 * Endpoint:
 *   POST /api/v1/ai-scaffold/synthesize-missing-nodes
 *
 * Body:
 *   {
 *     workflow: { nodes: [...], edges: [...] }   // workflow allucinato da Liara
 *     userPrompt: string                         // prompt originale (context per LLM)
 *   }
 *
 * Output:
 *   {
 *     workflow: { ... }                          // workflow con defId riscritti
 *     mapping: Record<oldDefId, newDefId>
 *     succeeded: Array<{ oldDefId, newDefId, customNodeId, reused }>
 *     failed:    Array<{ oldDefId, reason }>
 *     skipped:   Array<{ defId, reason }>
 *   }
 *
 * Sicurezza/Plan gating:
 *  - requireRole('owner') — la creazione di custom node è action privilegiata
 *  - assertCanCreateMoreCustomNodes(N) chiamato N volte (1 per item): se quota
 *    superata, l'orchestrator fail-soft per quel item ma altri proseguono
 *  - llmRateLimit middleware: previene burst LLM
 *  - Audit log append per ogni synthesis (action: 'custom_node_synthesized')
 *  - Idempotency-Key opzionale (riusa risposta cached per stesso payload)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '@/middleware/rbac.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import { logger } from '@/lib/logger.js';
import {
  buildNodeCatalog,
  buildPrePromptedAgentDefIds,
} from '@/services/ai-scaffold/node-catalog.js';
import { listCustomNodes, customNodeDefId } from '@/services/custom-nodes/index.js';
import {
  applyDefIdMapping,
  detectMissingDefIds,
  executeSynthesisPlan,
  planSynthesis,
  type Workflow,
} from '@/services/ai-scaffold/missing-node-orchestrator.js';
import { buildRealOrchestratorDeps } from '@/services/ai-scaffold/missing-node-orchestrator.deps.js';
import { AuditLogService } from '@/services/audit.service.js';
import { smokeTestWorkflow } from '@/services/ai-scaffold/preimport-smoke-test.js';

const NodeSchema = z
  .object({
    id: z.string().min(1),
    defId: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

const EdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const RequestSchema = z.object({
  workflow: z
    .object({
      nodes: z.array(NodeSchema).min(1).max(200),
      edges: z.array(EdgeSchema).max(1000),
    })
    .passthrough(),
  userPrompt: z.string().min(1).max(8_000),
});

function resolveCtx(c: { get: (k: string) => unknown }): {
  workspaceId: string;
  actorUserId: string;
} {
  const auth = c.get('auth') as { userId?: string; tenantId?: string } | undefined;
  return {
    workspaceId: auth?.tenantId ?? 'default',
    actorUserId: auth?.userId ?? 'owner',
  };
}

export function createAiScaffoldMissingNodesRoutes(): Hono {
  const app = new Hono();
  app.use('*', requireRole('owner'));

  app.post(
    '/synthesize-missing-nodes',
    llmRateLimit('ai-scaffold-synthesize-missing'),
    zValidator('json', RequestSchema),
    async (c) => {
      const { workflow, userPrompt } = c.req.valid('json');
      const { workspaceId, actorUserId } = resolveCtx(c);

      // 1) Costruisci known defIds: catalog stdlib + community + custom nodi del tenant.
      const catalog = buildNodeCatalog();
      const knownDefIds = new Set<string>(catalog.map((e) => e.defId));
      const customList = await listCustomNodes({ workspaceId, filter: { limit: 200 } });
      const knownCustomDefIds = new Set<string>(
        customList.items.map((n) => customNodeDefId(n.slug)),
      );

      // 2) Detect missing.
      const wf: Workflow = workflow;
      const missing = detectMissingDefIds(wf, knownDefIds, knownCustomDefIds);
      if (missing.length === 0) {
        return c.json({
          workflow: wf,
          mapping: {},
          succeeded: [],
          failed: [],
          skipped: [],
          message: 'Nessun defId mancante. Workflow già valido per il catalog.',
        });
      }

      // 3) Plan + execute con deps reali.
      const plan = planSynthesis(missing, {
        userPrompt,
        contextNodes: wf.nodes,
        contextEdges: wf.edges,
      });

      logger.info(
        {
          workspaceId,
          missingCount: missing.length,
          planItems: plan.items.length,
          skipped: plan.skipped.length,
        },
        '[ai-scaffold] synthesize-missing-nodes: piano pronto',
      );

      const deps = buildRealOrchestratorDeps(workspaceId);
      const result = await executeSynthesisPlan(plan, deps, {
        workspaceId,
        ownerUserId: actorUserId,
      });

      // 4) Riscrivi workflow con i nuovi defId.
      const rewritten = applyDefIdMapping(wf, result.mapping);

      // 5) Audit log per ogni synthesis (immutable trigger DB-protected).
      const audit = new AuditLogService();
      for (const s of result.succeeded) {
        await audit.append({
          tenantId: workspaceId,
          actorId: actorUserId,
          action: 'custom_node_synthesized',
          resourceType: 'custom_node',
          resourceId: s.customNodeId || s.newDefId,
          metadata: {
            oldDefId: s.oldDefId,
            newDefId: s.newDefId,
            reused: s.reused,
            reasonCode: 'ai_scaffold_missing_node',
            userPromptHash: hashPrompt(userPrompt),
          },
        });
      }
      for (const f of result.failed) {
        await audit.append({
          tenantId: workspaceId,
          actorId: actorUserId,
          action: 'custom_node_synthesis_failed',
          resourceType: 'custom_node',
          resourceId: f.oldDefId,
          metadata: {
            oldDefId: f.oldDefId,
            reason: f.reason,
            reasonCode: 'ai_scaffold_missing_node_failed',
          },
        });
      }

      // 6) Serialize Map → plain object per JSON.
      const mappingObj: Record<string, string> = {};
      for (const [k, v] of result.mapping.entries()) mappingObj[k] = v;

      return c.json({
        workflow: rewritten,
        mapping: mappingObj,
        succeeded: result.succeeded,
        failed: result.failed,
        skipped: plan.skipped,
      });
    },
  );

  // Step 5: pre-import smoke test. Pure, no LLM, no DB write — cost zero.
  app.post(
    '/smoke-test',
    zValidator(
      'json',
      z.object({
        workflow: z
          .object({
            nodes: z.array(NodeSchema).min(1).max(200),
            edges: z.array(EdgeSchema).max(1000),
          })
          .passthrough(),
      }),
    ),
    async (c) => {
      const { workflow } = c.req.valid('json');

      // Build registered defIds: catalog stdlib + custom del tenant.
      const { workspaceId } = resolveCtx(c);
      const catalog = buildNodeCatalog();
      const customList = await listCustomNodes({ workspaceId, filter: { limit: 200 } });
      const registered = new Set<string>([
        ...catalog.map((e) => e.defId),
        ...customList.items.map((n) => customNodeDefId(n.slug)),
      ]);

      const wf = workflow;
      const report = smokeTestWorkflow(wf, {
        registeredDefIds: registered,
        prePromptedDefIds: buildPrePromptedAgentDefIds(),
      });
      return c.json(report);
    },
  );

  return app;
}

function hashPrompt(s: string): string {
  // Light-weight hash (non-crypto): identifica un prompt per audit aggregation
  // senza salvare il testo PII-sensitive. SHA-256 sarebbe overkill ma OK.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) + h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(16);
}
