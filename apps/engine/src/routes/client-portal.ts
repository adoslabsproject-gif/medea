/**
 * Client Portal routes — modalità "portale cliente" white-label.
 *
 * Due gruppi di endpoint:
 *
 * 1. ADMIN (gated da requireRole('owner')):
 *    GET    /api/v1/client-portal-admin              → lista token portal del tenant
 *    POST   /api/v1/client-portal-admin              → crea nuovo token portal
 *    DELETE /api/v1/client-portal-admin/:id          → revoca token
 *
 * 2. PUBLIC (token-gated, no auth middleware — registrato in publicPrefixes):
 *    GET  /api/v1/portal/:tenantId/:token            → info portal (brand, permissions visible, lista workflow)
 *    GET  /api/v1/portal/:tenantId/:token/workflows  → lista workflow visibili (default-deny)
 *    GET  /api/v1/portal/:tenantId/:token/runs       → cronologia run dei workflow visibili
 *    GET  /api/v1/portal/:tenantId/:token/runs/:id   → dettaglio run (gated by visibility)
 *    POST /api/v1/portal/:tenantId/:token/workflows/:wfId/run → esegui (gated da canRunWorkflow)
 *
 * Sicurezza (defense in depth):
 *  - Ogni endpoint public valida token PRIMA di qualsiasi side effect
 *  - Workflow visibility → check su listVisibleWorkflows()
 *  - Run gating → check su canRunWorkflow() 3-AND
 *  - Audit log su run-from-portal
 *  - Errori "generici" verso il cliente (no leak interno, "Invalid or expired")
 *  - SECURITY: stesso pattern viewer-share.route (battle-tested)
 */

import type { Context } from 'hono';
import { coerceString } from '@/lib/coerce.js';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ClientPortalService,
  computeExposedFields,
  validateExposedFieldValue,
  redactForAudit,
  type PortalToken,
  type PortalPermissions,
} from '@/services/client-portal.service.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import { requireRole } from '@/middleware/rbac.js';
import { getTenantId } from '@/lib/tenant.js';
import type { IEventBus } from '@/ports/event-bus.js';

// ─── Schemas ──────────────────────────────────────────────────────────

const PermissionsSchema = z.object({
  workflowTags: z.array(z.string().min(1).max(64)).max(20).optional(),
  workflowIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  allowRun: z.boolean().optional(),
  allowedTriggerTypes: z.array(z.string().min(1).max(64)).max(20).optional(),
  showHistory: z.boolean().optional(),
  showLiveCanvas: z.boolean().optional(),
  brandName: z.string().min(1).max(120).optional(),
  brandLogoUrl: z.string().url().max(500).optional(),
});

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(120),
  permissions: PermissionsSchema,
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

const RunPortalSchema = z
  .object({
    triggerInput: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

const UpdateExposedFieldSchema = z.object({
  nodeId: z.string().min(1).max(128),
  fieldKey: z.string().min(1).max(128),
  value: z.string().max(10_000),
});

// ─── Public-facing redaction ──────────────────────────────────────────

/**
 * Quello che il portale cliente vede del proprio token. Niente token
 * raw (mai esporre il segreto in API responses), niente createdBy
 * (chi l'ha emesso e\` info interna).
 */
function redactPortalInfo(token: PortalToken): {
  name: string;
  permissions: Pick<
    PortalPermissions,
    'allowRun' | 'showHistory' | 'showLiveCanvas' | 'brandName' | 'brandLogoUrl'
  >;
  expiresAt?: string;
} {
  const result: ReturnType<typeof redactPortalInfo> = {
    name: token.name,
    permissions: {
      ...(token.permissions.allowRun !== undefined ? { allowRun: token.permissions.allowRun } : {}),
      ...(token.permissions.showHistory !== undefined
        ? { showHistory: token.permissions.showHistory }
        : {}),
      ...(token.permissions.showLiveCanvas !== undefined
        ? { showLiveCanvas: token.permissions.showLiveCanvas }
        : {}),
      ...(token.permissions.brandName !== undefined
        ? { brandName: token.permissions.brandName }
        : {}),
      ...(token.permissions.brandLogoUrl !== undefined
        ? { brandLogoUrl: token.permissions.brandLogoUrl }
        : {}),
    },
  };
  if (token.expiresAt !== undefined) result.expiresAt = token.expiresAt;
  return result;
}

// ─── Admin routes (owner-gated) ───────────────────────────────────────

export function createClientPortalAdminRoutes(): Hono {
  const app = new Hono();
  const svc = new ClientPortalService();

  app.use('/client-portal-admin/*', requireRole('owner'));
  app.use('/client-portal-admin', requireRole('owner'));

  app.post('/client-portal-admin', zValidator('json', CreateTokenSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const body = c.req.valid('json');
    const opts: Parameters<typeof svc.create>[1] = {
      name: body.name,
      permissions: body.permissions as PortalPermissions,
      createdBy: auth.userId,
    };
    if (body.expiresInDays !== undefined) opts.expiresInDays = body.expiresInDays;
    const token = await svc.create(getTenantId(c), opts);
    return c.json({ token }, 201);
  });

  return app;
}

// ─── Public routes (token-gated, NO auth middleware) ──────────────────

export function createClientPortalPublicRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const svc = new ClientPortalService();
  const workflows = new WorkflowService(eventBus);
  const runs = new RunService(eventBus);

  /**
   * Middleware-like helper: valida tenant+token, ritorna PortalToken o
   * risposta 401 generica. Stessa shape errore per tutti i 401 (anti-enum).
   */
  function verifyOrReject(c: Context): PortalToken | Response {
    const tenantId = c.req.param('tenantId');
    const token = c.req.param('token');
    if (!tenantId || !token) {
      return new Response(JSON.stringify({ error: 'Invalid portal link' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const valid = svc.verify(tenantId, token);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid or expired portal link' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return valid;
  }

  // GET /api/v1/portal/:tenantId/:token  → info portal redacted
  app.get('/portal/:tenantId/:token', (c) => {
    const verified = verifyOrReject(c);
    if (verified instanceof Response) return verified;
    return c.json({ portal: redactPortalInfo(verified) });
  });

  // GET /api/v1/portal/:tenantId/:token/workflows  → lista filtered
  app.get('/portal/:tenantId/:token/workflows', (c) => {
    const verified = verifyOrReject(c);
    if (verified instanceof Response) return verified;
    return c.json({ workflows: svc.listVisibleWorkflows(verified) });
  });

  // GET /api/v1/portal/:tenantId/:token/runs  → cronologia (filtered by visible workflows)
  app.get('/portal/:tenantId/:token/runs', async (c) => {
    const verified = verifyOrReject(c);
    if (verified instanceof Response) return verified;
    if (verified.permissions.showHistory === false) {
      return c.json({ runs: [] });
    }
    const visible = svc.listVisibleWorkflows(verified);
    const visibleIds = new Set(visible.map((w) => w.id));
    if (visibleIds.size === 0) return c.json({ runs: [] });
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Math.min(100, Math.max(1, parseInt(limitParam, 10) || 20)) : 20;
    const all = await runs.listRecent(verified.tenantId, limit * 3);
    const filtered = all
      .filter((r) => visibleIds.has(r.workflowId))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        workflowId: r.workflowId,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        totalDurationMs: r.totalDurationMs,
      }));
    return c.json({ runs: filtered });
  });

  // GET /api/v1/portal/:tenantId/:token/runs/:runId  → dettaglio (visibility gated)
  app.get('/portal/:tenantId/:token/runs/:runId', async (c) => {
    const verified = verifyOrReject(c);
    if (verified instanceof Response) return verified;
    const runId = c.req.param('runId');
    if (!runId) return c.json({ error: 'Bad request' }, 400);
    const run = await runs.getById(runId, verified.tenantId);
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const visible = svc.listVisibleWorkflows(verified);
    if (!visible.some((w) => w.id === run.workflowId)) {
      return c.json({ error: 'Run not found' }, 404); // 404 instead of 403 (no enum)
    }
    // Sprint 2.5: includi nodes+edges del workflow per il canvas read-only,
    // REDACTED — solo id, defId, label, x, y. Nessun config (no credential
    // leak). Edges solo id, source, target, handles.
    let canvasNodes: { id: string; defId?: string; label?: string; x?: number; y?: number }[] = [];
    let canvasEdges: {
      id?: string;
      source: string;
      target: string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
    }[] = [];
    try {
      const wf = await workflows.get(run.workflowId, verified.tenantId);
      if (wf) {
        const wfNodes = Array.isArray(wf.nodes) ? (wf.nodes as Record<string, unknown>[]) : [];
        const wfEdges = Array.isArray(wf.edges) ? (wf.edges as Record<string, unknown>[]) : [];
        canvasNodes = wfNodes
          .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
          .map((n) => ({
            id: coerceString(n.id ?? ''),
            ...(typeof n.defId === 'string' ? { defId: n.defId } : {}),
            ...(typeof n.label === 'string' ? { label: n.label } : {}),
            ...(typeof n.x === 'number' ? { x: n.x } : {}),
            ...(typeof n.y === 'number' ? { y: n.y } : {}),
          }));
        canvasEdges = wfEdges
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
          .map((e) => ({
            ...(typeof e.id === 'string' ? { id: e.id } : {}),
            source: coerceString(e.source ?? ''),
            target: coerceString(e.target ?? ''),
            ...(typeof e.sourceHandle === 'string' || e.sourceHandle === null
              ? { sourceHandle: e.sourceHandle }
              : {}),
            ...(typeof e.targetHandle === 'string' || e.targetHandle === null
              ? { targetHandle: e.targetHandle }
              : {}),
          }));
      }
    } catch {
      // Best-effort: se il workflow non c'è più, ritorna solo gli step lista.
    }

    return c.json({
      run: {
        id: run.id,
        workflowId: run.workflowId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        totalDurationMs: run.totalDurationMs,
        steps: run.steps.map((s) => ({
          nodeId: s.nodeId,
          nodeLabel: s.nodeLabel,
          status: s.status,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          durationMs: s.durationMs,
          // NB: NO output / NO error message dettagliato — il cliente
          // vede SOLO lo stato per nodo, non il payload interno.
        })),
        canvas: { nodes: canvasNodes, edges: canvasEdges },
      },
    });
  });

  // GET /api/v1/portal/:tenantId/:token/workflows/:wfId/exposed-fields
  //   → lista dei campi esposti dal NodeDef con exposeToClient=true
  app.get('/portal/:tenantId/:token/workflows/:wfId/exposed-fields', async (c) => {
    const verified = verifyOrReject(c);
    if (verified instanceof Response) return verified;
    const wfId = c.req.param('wfId');
    if (!wfId) return c.json({ error: 'Bad request' }, 400);
    // Visibility check
    const visible = svc.listVisibleWorkflows(verified);
    if (!visible.some((w) => w.id === wfId)) {
      return c.json({ error: 'Workflow not found' }, 404);
    }
    const wf = await workflows.get(wfId, verified.tenantId);
    if (!wf) return c.json({ error: 'Workflow not found' }, 404);
    const fields = computeExposedFields({ nodes: wf.nodes, nodeDefs: wf.nodeDefs });
    return c.json({ fields });
  });

  // PATCH /api/v1/portal/:tenantId/:token/workflows/:wfId/exposed-fields
  //   → aggiorna un campo esposto (gated: deve essere in computeExposedFields list)
  app.patch(
    '/portal/:tenantId/:token/workflows/:wfId/exposed-fields',
    zValidator('json', UpdateExposedFieldSchema),
    async (c) => {
      const verified = verifyOrReject(c);
      if (verified instanceof Response) return verified;
      const wfId = c.req.param('wfId');
      if (!wfId) return c.json({ error: 'Bad request' }, 400);
      const visible = svc.listVisibleWorkflows(verified);
      if (!visible.some((w) => w.id === wfId)) {
        return c.json({ error: 'Workflow not found' }, 404);
      }
      const wf = await workflows.get(wfId, verified.tenantId);
      if (!wf) return c.json({ error: 'Workflow not found' }, 404);

      const body = c.req.valid('json');
      const exposed = computeExposedFields({ nodes: wf.nodes, nodeDefs: wf.nodeDefs });
      // Defense: il field deve essere nell'allowlist (exposeToClient=true).
      // Senza questo check, un cliente potrebbe PATCH-are qualsiasi field
      // del workflow (es. URL endpoint, credenziali) bypassando la whitelist.
      const descriptor = exposed.find(
        (f) => f.nodeId === body.nodeId && f.fieldKey === body.fieldKey,
      );
      if (!descriptor) {
        return c.json({ error: 'Campo non modificabile dal portale.' }, 403);
      }
      const validation = validateExposedFieldValue(descriptor, body.value);
      if (!validation.ok) {
        return c.json({ error: validation.error }, 422);
      }

      // Update node config + persist
      const nodes = Array.isArray(wf.nodes) ? [...(wf.nodes as unknown[])] : [];
      let oldRedacted = '(non impostato)';
      let touched = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || typeof n !== 'object') continue;
        const nodeAny = n as { id?: string; config?: Record<string, unknown> };
        if (nodeAny.id !== body.nodeId) continue;
        const cfg =
          nodeAny.config && typeof nodeAny.config === 'object' ? { ...nodeAny.config } : {};
        const oldVal = cfg[body.fieldKey];
        if (typeof oldVal === 'string') oldRedacted = redactForAudit(oldVal);
        cfg[body.fieldKey] = body.value;
        nodes[i] = { ...nodeAny, config: cfg };
        touched = true;
        break;
      }
      if (!touched) {
        return c.json({ error: 'Nodo non trovato.' }, 404);
      }

      // Persist workflow update (signature: id, input, tenantId)
      await workflows.update(wfId, { nodes }, verified.tenantId);

      // Audit log: portalTokenId + workflowId + nodeId + fieldKey + oldRedacted
      await svc.auditFieldUpdate({
        tenantId: verified.tenantId,
        tokenId: verified.id,
        workflowId: wfId,
        nodeId: body.nodeId,
        fieldKey: body.fieldKey,
        oldValueRedacted: oldRedacted,
      });

      return c.json({ ok: true, fieldKey: body.fieldKey, nodeId: body.nodeId });
    },
  );

  // POST /api/v1/portal/:tenantId/:token/workflows/:wfId/run  → execute (gate 3-AND)
  app.post(
    '/portal/:tenantId/:token/workflows/:wfId/run',
    zValidator('json', RunPortalSchema),
    async (c) => {
      const verified = verifyOrReject(c);
      if (verified instanceof Response) return verified;
      const wfId = c.req.param('wfId');
      if (!wfId) return c.json({ error: 'Bad request' }, 400);
      const wf = await workflows.get(wfId, verified.tenantId);
      if (!wf) return c.json({ error: 'Workflow not found' }, 404);
      const gate = svc.canRunWorkflow(verified, {
        id: wf.id,
        nodesJson: JSON.stringify(wf.nodes),
      });
      if (!gate.ok) {
        return c.json({ error: 'Not allowed', reason: gate.reason }, 403);
      }

      const body = c.req.valid('json');
      const triggerInput = body?.triggerInput ?? {};
      const result = await runs.execute({
        workflowId: wf.id,
        tenantId: verified.tenantId,
        triggerType: 'portal',
        triggerInput,
        triggeredBy: `portal:${verified.id}`,
      });

      // Audit con portal token id (chi ha autorizzato) — distinto dai run normali
      await svc.auditPortalRun({
        tenantId: verified.tenantId,
        tokenId: verified.id,
        workflowId: wf.id,
        runId: result.runId,
        triggerInputSummary: Object.keys(triggerInput).reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = '<redacted>';
          return acc;
        }, {}),
      });

      return c.json(
        {
          runId: result.runId,
          status: result.status,
        },
        202,
      );
    },
  );

  return app;
}
