/**
 * Custom Nodes routes — REST API per il Custom Node Editor (Fase 1).
 *
 * Tutti gli endpoint sono OWNER-ONLY (`requireRole('owner')`): la creazione +
 * esecuzione di codice arbitrario nel container del tenant e\` privilege
 * massimo. La UI client-side (Tab "I Miei Nodi") chiama questi endpoint via
 * cookie session.
 *
 * Mount point: app.route('/api/v1/custom-nodes', createCustomNodesRoutes())
 *
 * Endpoints:
 *   GET    /                          — list (filter + paginate)
 *   POST   /                          — create draft
 *   GET    /:id                       — get full (sources + metadata + history meta)
 *   PUT    /:id                       — update (source/metadata + auto semver bump)
 *   DELETE /:id                       — archive (soft-delete)
 *   GET    /:id/versions              — list snapshot history
 *   POST   /:id/rollback              — rollback to {semverTarget}
 *   POST   /:id/compile               — server-side esbuild + security scan
 *   GET    /quota                     — plan capability + counter (UI banner)
 *
 * Error responses: { error: { code, message, meta?, status } } shape uniforme
 * — mappata da CustomNodeError tramite errorMapper().
 *
 * @module routes/custom-nodes
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireRole } from '@/middleware/rbac.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import { logger } from '@/lib/logger.js';
import type { SandboxTrace } from '@/executors/community-node-sandbox.js';
import {
  createCustomNode,
  getCustomNode,
  listCustomNodes,
  listCustomNodeDefinitions,
  updateCustomNode,
  listVersions,
  rollbackToVersion,
  archiveCustomNode,
  compileAndPersist,
  countActiveCustomNodes,
  resolveTenantPlan,
  publishCustomNodePrivate,
  unpublishCustomNode,
  submitCustomNodeToMarketplace,
  withdrawCustomNodeFromMarketplace,
  PLAN_CAPABILITIES,
  CustomNodeError,
  CustomNodeCreateInputSchema,
  CustomNodeUpdateInputSchema,
  CustomNodeListFilterSchema,
  semverField,
} from '@/services/custom-nodes/index.js';
import {
  generateNodeFromOpenApi,
  OpenApiParseError,
  type OpenApiImportOptions,
} from '@/lib/openapi-to-node.js';
import { postmanToOpenApi, PostmanParseError } from '@/lib/postman-to-openapi.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Body di POST /import/openapi. `spec` = oggetto OpenAPI 3.x già parsato. */
const OpenApiImportBodySchema = z.object({
  spec: z.record(z.string(), z.unknown()),
  slug: z.string().min(2).max(64).optional(),
  baseUrl: z.string().url().optional(),
  maxOperations: z.number().int().positive().max(1000).optional(),
});

/** Body di POST /import/postman. `collection` = Postman Collection v2.x parsata. */
const PostmanImportBodySchema = z.object({
  collection: z.record(z.string(), z.unknown()),
  slug: z.string().min(2).max(64).optional(),
  baseUrl: z.string().url().optional(),
  maxOperations: z.number().int().positive().max(1000).optional(),
});

/** Resolve workspaceId + actor user_id da auth context (JWT-bound). */
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

/**
 * Centralized error mapper: CustomNodeError → { status, body }.
 * Pattern: handler awaits service → catch → throw HTTPException equivalent.
 * Hono c.json(body, status) e\` la via piu\` pulita senza middleware errore.
 */
function errorResponse(err: unknown): {
  status: number;
  body: {
    error: { code: string; message: string; meta?: Record<string, unknown>; status: number };
  };
} {
  if (err instanceof CustomNodeError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(Object.keys(err.meta).length > 0 ? { meta: err.meta } : {}),
          status: err.status,
        },
      },
    };
  }
  // Zod errors → 400
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Input validation failed',
          meta: { issues: err.issues },
          status: 400,
        },
      },
    };
  }
  // Fallback unhandled
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, '[custom-nodes] unhandled error');
  return {
    status: 500,
    body: {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 },
    },
  };
}

// ─── Schemas REST-specific ─────────────────────────────────────────────

const RollbackBodySchema = z.object({
  semverTarget: semverField,
});

const CompileBodySchema = z.object({
  /** Override: compila usando questi source (non-persisted preview).
   *  Se omesso, usa i source attualmente salvati sul DB. */
  sources: z
    .object({
      executor: z.string(),
      definition: z.string(),
      schema: z.string(),
    })
    .optional(),
});

const SourcesSchema = z.object({
  executor: z.string(),
  definition: z.string(),
  schema: z.string(),
});

const AiAssistBodySchema = z.object({
  action: z.enum(['generate', 'explain', 'fix', 'test', 'refactor', 'chat']),
  prompt: z.string().optional(),
  sources: SourcesSchema.optional(),
  selectedText: z.string().optional(),
  diagnostic: z
    .object({
      message: z.string(),
      line: z.number(),
      file: z.enum(['executor', 'definition', 'schema']),
    })
    .optional(),
});

const InlineCompletionBodySchema = z.object({
  contextBefore: z.string(),
  file: z.string(),
  cursorLine: z.number().optional().default(1),
  cursorColumn: z.number().optional().default(1),
});

const TestRunBodySchema = z.object({
  /** Override: compila just-in-time questi source. Se omesso, usa compiledExecutor DB. */
  sources: z
    .object({
      executor: z.string(),
      definition: z.string(),
      schema: z.string(),
    })
    .optional(),
  /** Mock input al nodo (JSON arbitrario). */
  input: z.unknown().default({}),
  /** Mock config passato a executor(config, input, ctx). */
  config: z.record(z.string(), z.unknown()).default({}),
});

// ─── Routes ─────────────────────────────────────────────────────────────

export function createCustomNodesRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/v1/custom-nodes/catalog — definizioni dei custom node RUNNABLE per
   * il pannello dell'editor (configFields). Registrato PRIMA del guard owner →
   * accessibile a QUALSIASI membro del workspace: anche un collaboratore
   * non-owner deve vedere i parametri dei nodi quando apre un workflow.
   * Espone SOLO le definizioni (metadata UI), MAI executor/schema.
   */
  app.get('/catalog', (c) => {
    const auth = c.get('auth') as { tenantId?: string } | undefined;
    if (!auth?.tenantId) return c.json({ error: 'Unauthorized' }, 401);
    try {
      return c.json({ definitions: listCustomNodeDefinitions(auth.tenantId) });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  // Owner-only: questi endpoint creano/eseguono codice arbitrario nel runtime.
  app.use('*', requireRole('owner'));

  /** GET /api/v1/custom-nodes/quota — plan info + counter (UI banner). */
  app.get('/quota', async (c) => {
    try {
      const plan = resolveTenantPlan();
      const cap = PLAN_CAPABILITIES[plan];
      const current = await countActiveCustomNodes(resolveCtx(c).workspaceId);
      return c.json({
        plan,
        current,
        limit: cap.maxCustomNodes,
        canPublishMarketplace: cap.canPublishMarketplace,
        marketplaceAutoPublish: cap.marketplaceAutoPublish,
        aiTokenQuotaMonthly: cap.aiTokenQuotaMonthly,
      });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** GET /api/v1/custom-nodes — list (filter + pagination). */
  app.get('/', async (c) => {
    try {
      const q = c.req.query();
      const rawFilter: Record<string, unknown> = {};
      if (q.status) rawFilter.status = q.status;
      if (q.category) rawFilter.category = q.category;
      if (q.ownerUserId) rawFilter.ownerUserId = q.ownerUserId;
      if (q.limit) rawFilter.limit = parseInt(q.limit, 10);
      if (q.offset) rawFilter.offset = parseInt(q.offset, 10);
      const filter = CustomNodeListFilterSchema.partial().parse(rawFilter);
      // exactOptionalPropertyTypes workaround: il Zod parser puo\` lasciare
      // undefined espliciti che listCustomNodes (Partial<...>) non accetta.
      // Strip undefined keys per type-clean signature.
      const cleanFilter = Object.fromEntries(
        Object.entries(filter).filter(([, v]) => v !== undefined),
      );
      const res = await listCustomNodes({
        workspaceId: resolveCtx(c).workspaceId,
        filter: cleanFilter,
      });
      // Backward-compat alias: UI editor cerca `rows`, backend ritorna `items`.
      // Espongo entrambi finche\` tutte le SPA distribuite non sono ricompilate.
      return c.json({
        items: res.items,
        rows: res.items,
        total: res.total,
        limit: Number(cleanFilter.limit ?? 50),
        offset: Number(cleanFilter.offset ?? 0),
      });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** POST /api/v1/custom-nodes — create draft. */
  app.post('/', zValidator('json', CustomNodeCreateInputSchema), async (c) => {
    try {
      const input = c.req.valid('json');
      const node = await createCustomNode({
        workspaceId: resolveCtx(c).workspaceId,
        ownerUserId: resolveCtx(c).actorUserId,
        input,
      });
      return c.json(node, 201);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /**
   * POST /api/v1/custom-nodes/import/openapi — genera un custom node DRAFT da
   * uno spec OpenAPI 3.x. È la leva anti-n8n: qualunque API con uno spec diventa
   * un nodo FlowForge senza scriverlo a mano. Il draft va poi compilato/pubblicato
   * come ogni altro custom node.
   */
  app.post('/import/openapi', zValidator('json', OpenApiImportBodySchema), async (c) => {
    try {
      const { spec, slug, baseUrl, maxOperations } = c.req.valid('json');
      const opts: OpenApiImportOptions = {};
      if (slug !== undefined) opts.slug = slug;
      if (baseUrl !== undefined) opts.baseUrlOverride = baseUrl;
      if (maxOperations !== undefined) opts.maxOperations = maxOperations;

      const generated = generateNodeFromOpenApi(spec, opts);
      const node = await createCustomNode({
        workspaceId: resolveCtx(c).workspaceId,
        ownerUserId: resolveCtx(c).actorUserId,
        input: {
          slug: generated.slug,
          displayName: generated.displayName,
          description: generated.description,
          category: generated.category,
          sourceExecutor: generated.sourceExecutor,
          sourceDefinition: generated.sourceDefinition,
          sourceSchema: generated.sourceSchema,
        },
      });
      return c.json({ node, stats: generated.stats, warnings: generated.warnings }, 201);
    } catch (err) {
      if (err instanceof OpenApiParseError) {
        return c.json(
          { error: { code: 'OPENAPI_PARSE_ERROR', message: err.message, status: 400 } },
          400,
        );
      }
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /**
   * POST /api/v1/custom-nodes/import/postman — genera un custom node DRAFT da una
   * Postman Collection (v2.x). Converte la collection in OpenAPI e RIUSA lo stesso
   * generatore (stesse proprietà di sicurezza), nessun executor nuovo.
   */
  app.post('/import/postman', zValidator('json', PostmanImportBodySchema), async (c) => {
    try {
      const { collection, slug, baseUrl, maxOperations } = c.req.valid('json');
      const { spec, warnings: convertWarnings } = postmanToOpenApi(collection);
      const opts: OpenApiImportOptions = {};
      if (slug !== undefined) opts.slug = slug;
      if (baseUrl !== undefined) opts.baseUrlOverride = baseUrl;
      if (maxOperations !== undefined) opts.maxOperations = maxOperations;

      const generated = generateNodeFromOpenApi(spec, opts);
      const node = await createCustomNode({
        workspaceId: resolveCtx(c).workspaceId,
        ownerUserId: resolveCtx(c).actorUserId,
        input: {
          slug: generated.slug,
          displayName: generated.displayName,
          description: generated.description,
          category: generated.category,
          sourceExecutor: generated.sourceExecutor,
          sourceDefinition: generated.sourceDefinition,
          sourceSchema: generated.sourceSchema,
        },
      });
      return c.json(
        { node, stats: generated.stats, warnings: [...convertWarnings, ...generated.warnings] },
        201,
      );
    } catch (err) {
      if (err instanceof PostmanParseError || err instanceof OpenApiParseError) {
        return c.json(
          { error: { code: 'POSTMAN_PARSE_ERROR', message: err.message, status: 400 } },
          400,
        );
      }
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** GET /api/v1/custom-nodes/:id — get full. */
  app.get('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const node = await getCustomNode({ workspaceId: resolveCtx(c).workspaceId, id });
      if (!node)
        return c.json(
          { error: { code: 'NOT_FOUND', message: `Custom node ${id} not found`, status: 404 } },
          404,
        );
      return c.json(node);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** PUT /api/v1/custom-nodes/:id — update (source or metadata). */
  app.put('/:id', zValidator('json', CustomNodeUpdateInputSchema), async (c) => {
    try {
      const id = c.req.param('id');
      const input = c.req.valid('json');
      const updated = await updateCustomNode({
        workspaceId: resolveCtx(c).workspaceId,
        id,
        actorUserId: resolveCtx(c).actorUserId,
        input,
      });
      return c.json(updated);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** DELETE /api/v1/custom-nodes/:id — soft archive. */
  app.delete('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const ctx = resolveCtx(c);
      await archiveCustomNode({ workspaceId: ctx.workspaceId, id, actorUserId: ctx.actorUserId });
      return c.json({ archived: true, id });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** GET /api/v1/custom-nodes/:id/versions — list snapshot history. */
  app.get('/:id/versions', async (c) => {
    try {
      const id = c.req.param('id');
      const limitRaw = c.req.query('limit');
      const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
      const versions = await listVersions({
        workspaceId: resolveCtx(c).workspaceId,
        customNodeId: id,
        limit,
      });
      return c.json({ versions });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /**
   * GET /api/v1/custom-nodes/:id/test-runs — ring buffer ultimi run (FIX A3).
   * Prima il buffer era scritto da test-run ma mai esposto: ora la UI mostra
   * la history (timestamp/esito/durata) e permette il replay dell'input.
   */
  app.get('/:id/test-runs', async (c) => {
    try {
      const { listTestRuns } = await import('@/services/custom-nodes/index.js');
      const runs = await listTestRuns({
        workspaceId: resolveCtx(c).workspaceId,
        id: c.req.param('id'),
      });
      return c.json({ runs });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** POST /api/v1/custom-nodes/:id/rollback — load snapshot + bump patch. */
  app.post('/:id/rollback', zValidator('json', RollbackBodySchema), async (c) => {
    try {
      const id = c.req.param('id');
      const { semverTarget } = c.req.valid('json');
      const rolled = await rollbackToVersion({
        workspaceId: resolveCtx(c).workspaceId,
        customNodeId: id,
        actorUserId: resolveCtx(c).actorUserId,
        semverTarget,
      });
      return c.json(rolled);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** POST /api/v1/custom-nodes/:id/test-run — esegue il nodo nel sandbox con mock input/config. */
  app.post('/:id/test-run', zValidator('json', TestRunBodySchema), async (c) => {
    try {
      const id = c.req.param('id');
      const body = c.req.valid('json');
      const { compileCustomNodeSources } =
        await import('@/services/custom-nodes/compile.service.js');
      const { runInSandbox } = await import('@/executors/community-node-sandbox.js');
      const { getCustomNode, appendTestRun } = await import('@/services/custom-nodes/index.js');

      const wsId = resolveCtx(c).workspaceId;
      const node = await getCustomNode({ workspaceId: wsId, id });
      if (!node) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `Custom node ${id} not found`, status: 404 } },
          404,
        );
      }

      // 1. Compila just-in-time se sources passati; altrimenti usa compiledExecutor
      let compiled: string;
      if (body.sources) {
        const result = await compileCustomNodeSources(body.sources);
        compiled = result.compiledExecutor;
      } else if (node.compiledExecutor) {
        compiled = node.compiledExecutor;
      } else {
        const result = await compileCustomNodeSources({
          executor: node.sourceExecutor,
          definition: node.sourceDefinition,
          schema: node.sourceSchema,
        });
        compiled = result.compiledExecutor;
      }

      // 2. Adatta bundle IIFE all'invocation shape CJS attesa dal sandbox
      const adapted = `${compiled}
;module.exports = (typeof __customNode !== 'undefined' && typeof __customNode.executor === 'function')
  ? __customNode.executor
  : null;
`;

      // 3. Esegui con cattura trace
      const trace: SandboxTrace = {
        logs: [],
        network: [],
        durationMs: 0,
      };
      let output: unknown = null;
      let errMsg: string | null = null;
      try {
        output = await runInSandbox(
          adapted,
          {
            config: body.config,
            input: body.input ?? null,
            context: {
              tenantId: wsId,
              runId: `test-${Date.now().toString(36)}`,
              workflowId: 'test-runner',
              nodeId: id,
            },
          },
          trace,
        );
      } catch (err) {
        errMsg = err instanceof Error ? err.message : String(err);
      }

      // 4. Persistilo nel ring buffer dei testRuns (max 20)
      try {
        await appendTestRun({
          workspaceId: wsId,
          id,
          record: {
            at: new Date().toISOString(),
            input: body.input ?? null,
            output: output ?? null,
            durationMs: trace.durationMs,
            ok: errMsg === null,
            ...(errMsg ? { error: errMsg } : {}),
          },
        });
      } catch {
        // ring buffer e\` best-effort, non blocca la risposta
      }

      return c.json({
        success: errMsg === null,
        output,
        error: errMsg,
        trace: {
          logs: trace.logs,
          network: trace.network,
          durationMs: trace.durationMs,
        },
      });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** POST /api/v1/custom-nodes/:id/ai-assist — chiama Liara gateway.
   *  Rate-limit LLM standard (30 req/min tenant, 10 req/min user). */
  app.post(
    '/:id/ai-assist',
    llmRateLimit('custom-nodes.ai-assist'),
    zValidator('json', AiAssistBodySchema),
    async (c) => {
      try {
        const id = c.req.param('id');
        const body = c.req.valid('json');
        const { callAiAssist } = await import('@/services/custom-nodes/ai-assist.js');
        const ctx = resolveCtx(c);
        const wsId = ctx.workspaceId;
        // Se sources non passati, carica dal DB del nodo (per esempio explain/fix di un nodo esistente)
        let sources = body.sources;
        if (!sources) {
          const { getCustomNode } = await import('@/services/custom-nodes/index.js');
          const node = await getCustomNode({ workspaceId: wsId, id });
          if (node) {
            sources = {
              executor: node.sourceExecutor,
              definition: node.sourceDefinition,
              schema: node.sourceSchema,
            };
          }
        }
        const req: Parameters<typeof callAiAssist>[0] = {
          action: body.action,
          workspaceId: wsId,
        };
        if (body.prompt !== undefined) req.prompt = body.prompt;
        if (sources !== undefined) req.sources = sources;
        if (body.selectedText !== undefined) req.selectedText = body.selectedText;
        if (body.diagnostic !== undefined) req.diagnostic = body.diagnostic;
        // Contesto cross-surface: cosa l'utente stava facendo nelle ALTRE schede
        // (es. il workflow editor) → Liara nell'editor nodi "ricorda". Fail-soft.
        const { buildCrossSurfaceContext } =
          await import('@/services/ai-conversations/cross-surface-context.js');
        const cross = buildCrossSurfaceContext(ctx.actorUserId, wsId);
        if (cross) req.crossSurfaceContext = cross;
        const result = await callAiAssist(req);
        // Persisti l'interazione come conversazione 'node_editor' → le ALTRE schede
        // (workflow editor) la vedono via cross-surface context. Accumula sulla
        // conversazione node_editor più recente del workspace. Fail-soft: la
        // persistenza NON deve mai rompere l'ai-assist.
        try {
          const { conversationService } = await import('@/services/ai-conversations/index.js');
          const recent = conversationService.listForUser(ctx.actorUserId, {
            workspaceId: wsId,
            surface: 'node_editor',
            limit: 1,
          });
          const conv =
            recent[0] ??
            conversationService.create({
              userId: ctx.actorUserId,
              workspaceId: wsId,
              surface: 'node_editor',
            });
          conversationService.appendMessage({
            conversationId: conv.id,
            role: 'user',
            content: `[${body.action}] ${(body.prompt ?? id).slice(0, 500)}`,
          });
          if (result.text)
            conversationService.appendMessage({
              conversationId: conv.id,
              role: 'assistant',
              content: result.text.slice(0, 2000),
            });
        } catch {
          /* fail-soft */
        }
        return c.json(result);
      } catch (err) {
        const r = errorResponse(err);
        return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
      }
    },
  );

  /** POST /api/v1/custom-nodes/:id/publish-private — abilita il nodo nel runtime. */
  app.post('/:id/publish-private', async (c) => {
    try {
      const id = c.req.param('id');
      const ctx = resolveCtx(c);
      const published = await publishCustomNodePrivate({
        workspaceId: ctx.workspaceId,
        id,
        actorUserId: ctx.actorUserId,
      });
      return c.json(published);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /**
   * POST /api/v1/custom-nodes/:id/submit-marketplace
   *
   * Submit del nodo per review marketplace (status: published_priv → marketplace_pending).
   * Gates: plan canPublishMarketplace + compile OK + zero security errors.
   */
  app.post('/:id/submit-marketplace', async (c) => {
    try {
      const id = c.req.param('id');
      const ctx = resolveCtx(c);
      const updated = await submitCustomNodeToMarketplace({
        workspaceId: ctx.workspaceId,
        id,
        actorUserId: ctx.actorUserId,
      });
      return c.json(updated);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /**
   * POST /api/v1/custom-nodes/:id/withdraw-marketplace
   *
   * Ritira il nodo dalla coda review (marketplace_pending → candidate).
   */
  app.post('/:id/withdraw-marketplace', async (c) => {
    try {
      const id = c.req.param('id');
      const ctx = resolveCtx(c);
      const updated = await withdrawCustomNodeFromMarketplace({
        workspaceId: ctx.workspaceId,
        id,
        actorUserId: ctx.actorUserId,
      });
      return c.json(updated);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** POST /api/v1/custom-nodes/:id/unpublish — rimuove il nodo dal runtime. */
  app.post('/:id/unpublish', async (c) => {
    try {
      const id = c.req.param('id');
      const ctx = resolveCtx(c);
      const unpublished = await unpublishCustomNode({
        workspaceId: ctx.workspaceId,
        id,
        actorUserId: ctx.actorUserId,
      });
      return c.json(unpublished);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  /** POST /api/v1/custom-nodes/:id/compile — server-side compile + persist. */
  /**
   * POST /:id/inline-completion — ghost text Copilot-style (IDE-pro #217).
   *
   * Differenze rispetto a /ai-assist:
   *  - max_tokens 100 (no monologo)
   *  - temperature 0.15 (deterministic)
   *  - timeout 8s (UX target sub-second per ghost render)
   *  - fallback empty su errore (no exception): IDE perde il ghost ma non si rompe.
   *
   * Rate-limited insieme agli altri AI endpoint per fairness.
   */
  app.post(
    '/:id/inline-completion',
    llmRateLimit('custom-nodes.inline-completion'),
    zValidator('json', InlineCompletionBodySchema),
    async (c) => {
      try {
        const id = c.req.param('id') ?? '';
        // Body invalido → 400 (zValidator, come l'originale). Il fail-soft "mai
        // errore sull'IDE" resta sul catch: un'eccezione della chiamata LLM → 200
        // con completion vuota (sotto), MAI un 500.
        const body = c.req.valid('json');
        const wsId = resolveCtx(c).workspaceId;
        const { callInlineCompletion } = await import('@/services/custom-nodes/ai-inline.js');
        const res = await callInlineCompletion({
          workspaceId: wsId,
          nodeId: id,
          file: body.file.slice(0, 64),
          contextBefore: body.contextBefore.slice(-4_000),
          cursorLine: Math.max(1, Math.floor(body.cursorLine)),
          cursorColumn: Math.max(1, Math.floor(body.cursorColumn)),
        });
        return c.json(res);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          '[custom-nodes.inline-completion] error, fallback empty',
        );
        // MAI 500 sull'IDE — il ghost text è "best effort"
        return c.json({ completion: '', tokensIn: 0, tokensOut: 0, fromCache: false });
      }
    },
  );

  app.post('/:id/compile', zValidator('json', CompileBodySchema), async (c) => {
    try {
      const id = c.req.param('id');
      const body = c.req.valid('json');
      // Se sources non passati → carica dal DB
      let sources = body.sources;
      if (!sources) {
        const node = await getCustomNode({ workspaceId: resolveCtx(c).workspaceId, id });
        if (!node) {
          return c.json(
            { error: { code: 'NOT_FOUND', message: `Custom node ${id} not found`, status: 404 } },
            404,
          );
        }
        sources = {
          executor: node.sourceExecutor,
          definition: node.sourceDefinition,
          schema: node.sourceSchema,
        };
      }
      const result = await compileAndPersist({
        workspaceId: resolveCtx(c).workspaceId,
        id,
        sources,
      });
      return c.json({
        compiled: result.compiledExecutor.length,
        warnings: result.warnings,
      });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
    }
  });

  return app;
}
