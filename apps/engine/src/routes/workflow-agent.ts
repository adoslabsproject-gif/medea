/**
 * Route SSE dell'agente di workflow (#3) — CREAZIONE (`/build`) e MODIFICA
 * (`/modify`) tramite lo STESSO loop a strumenti (search_nodes → get_node_schema →
 * add_node → connect/disconnect → set_config → delete_node → validate_workflow →
 * finish). Il modello cerca il nodo giusto invece di indovinarlo tra ~200.
 *
 * - `/build`: costruisce un workflow NUOVO; il done assembla il Workflow canonico
 *   (import = singleshot wizard).
 * - `/modify`: MODIFICA un workflow esistente (parità chatter↔creazione, GAP #1):
 *   seed del builder col workflow corrente (read-before-edit) → loop → pending-
 *   secrets → diff→`patch` che l'editor già renderizza (Accept/Reject).
 *
 * Provider risolto per il tenant (resolveToolEndpoint → makeOpenAiLlmTurn);
 * license-key per Liara; LlmTurn/catalog/loaders INIETTABILI per i test in-process
 * (niente modello reale → no greensmoke).
 *
 * @module routes/workflow-agent
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getTenantId } from '@/lib/tenant.js';
import { logger } from '@/lib/logger.js';
import { runWorkflowAgent } from '@/services/workflow-agent/loop.js';
import { modifyWorkflow } from '@/services/workflow-agent/modify.js';
import type { WorkflowSnapshot } from '@/services/workflow-agent/state.js';
import { assembleWorkflow } from '@/services/ai-scaffold/assemble-workflow.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { resolveToolEndpoint } from '@/services/llm/provider-registry.js';
import { liaraBaseUrl } from '@/config.js';
import { makeOpenAiLlmTurn } from '@/services/db-agent/chat/openai-tool-adapter.js';
import type { LlmTurn } from '@/services/db-agent/chat/types.js';

const BuildBodySchema = z
  .object({
    goal: z.string().min(5).max(4000),
    extraContext: z.string().max(20_000).optional(),
    maxIterations: z.number().int().min(1).max(24).optional(),
  })
  .strict();

const ModifyBodySchema = z
  .object({
    workflowId: z.string().min(1).max(200),
    request: z.string().min(3).max(4000),
    extraContext: z.string().max(20_000).optional(),
    maxIterations: z.number().int().min(1).max(24).optional(),
  })
  .strict();

export interface WorkflowAgentRouteOptions {
  /** Iniezione test: LlmTurn stubbato (niente LLM reale). */
  llmTurnFor?: (tenantId: string) => LlmTurn;
  /** Iniezione test: catalog ridotto (default = buildNodeCatalog reale). */
  catalog?: NodeCatalogEntry[];
  /** Iniezione test: loader del workflow esistente (default = DB tenant). */
  loadWorkflowSnapshot?: (workflowId: string) => WorkflowSnapshot | null;
  /** Iniezione test: segreti configurati (default = GlobalVariablesService). */
  configuredSecretsFor?: (tenantId: string) => ReadonlySet<string>;
}

type TurnResolution =
  | { ok: true; llmTurn: LlmTurn }
  | { ok: false; status: 400 | 401 | 402 | 403; error: string };

/** Risolve l'LlmTurn per il tenant (DRY tra /build e /modify). Mai lancia su
 *  NoLlmProviderError → lo converte in errore strutturato. */
function resolveTurn(tenantId: string, opts: WorkflowAgentRouteOptions): TurnResolution {
  if (opts.llmTurnFor) return { ok: true, llmTurn: opts.llmTurnFor(tenantId) };
  try {
    const r = llmResolver.resolve(tenantId);
    if (r.provider !== 'liara' && r.provider !== 'ollama' && !r.apiKey) {
      return { ok: false, status: 401, error: `Nessuna API key per ${r.provider}.` };
    }
    const baseUrl = r.baseUrl ?? (r.provider === 'liara' ? liaraBaseUrl() : undefined);
    const target = resolveToolEndpoint(r.provider, r.model, baseUrl);
    if (!target) {
      return {
        ok: false,
        status: 400,
        error: `Il provider "${r.provider}" non supporta il tool-calling richiesto dall'agente. Usa OpenAI, Gemini, Grok, DeepSeek, OpenRouter, Groq, Mistral, Liara o Ollama.`,
      };
    }
    // AUTH: Liara (gateway portal) ESIGE la LICENSE KEY come Bearer; i BYOK usano
    // la loro apiKey; Ollama locale nessuna. (Identico a db-agent-chat.)
    const authKey = r.provider === 'liara' ? (process.env.MEDEA_LICENSE_KEY ?? '') : r.apiKey;
    return {
      ok: true,
      llmTurn: makeOpenAiLlmTurn({
        endpoint: target.url,
        apiKey: authKey,
        model: target.model,
        ...(target.extraHeaders ? { extraHeaders: target.extraHeaders } : {}),
      }),
    };
  } catch (err) {
    if (err instanceof NoLlmProviderError)
      return { ok: false, status: err.httpStatus, error: err.message };
    throw err;
  }
}

/** Catalog reale (lazy: tira il registry runtime). Iniettabile nei test. */
async function resolveCatalog(opts: WorkflowAgentRouteOptions): Promise<NodeCatalogEntry[]> {
  return (
    opts.catalog ?? (await import('@/services/ai-scaffold/node-catalog.js')).buildNodeCatalog()
  );
}

/** Carica il workflow esistente dal DB tenant come snapshot per il seed.
 *  Import dinamico: workflow-control tira getDatabase (DB del container). */
async function loadSnapshot(
  opts: WorkflowAgentRouteOptions,
  workflowId: string,
): Promise<WorkflowSnapshot | null> {
  if (opts.loadWorkflowSnapshot) return opts.loadWorkflowSnapshot(workflowId);
  const { getWorkflow } = await import('@/services/workflow-control-tools.service.js');
  const wf = getWorkflow(workflowId);
  if (!wf) return null;
  return {
    nodes: wf.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    edges: wf.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.fromPort ? { fromPort: e.fromPort } : {}),
    })),
  };
}

async function loadConfiguredSecrets(
  opts: WorkflowAgentRouteOptions,
  tenantId: string,
): Promise<ReadonlySet<string>> {
  if (opts.configuredSecretsFor) return opts.configuredSecretsFor(tenantId);
  const { GlobalVariablesService } = await import('@/services/global-variables.service.js');
  return new Set<string>(new GlobalVariablesService().list(tenantId).map((v) => v.name));
}

function requireAuth(c: Context): boolean {
  const auth = c.get('auth') as { userId?: string } | null;
  return !!auth?.userId;
}

export function createWorkflowAgentRoutes(opts: WorkflowAgentRouteOptions = {}): Hono {
  const app = new Hono();

  app.post('/build', zValidator('json', BuildBodySchema), async (c) => {
    if (!requireAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');

    const turn = resolveTurn(tenantId, opts);
    if (!turn.ok) return c.json({ error: turn.error }, turn.status);
    const catalog = await resolveCatalog(opts);

    return streamSSE(c, async (stream) => {
      try {
        const result = await runWorkflowAgent({
          catalog,
          prompt: {
            goal: body.goal,
            ...(body.extraContext ? { extraContext: body.extraContext } : {}),
          },
          llmTurn: turn.llmTurn,
          ...(body.maxIterations ? { maxIterations: body.maxIterations } : {}),
          onStep: (step) => {
            void stream.writeSSE({ event: 'step', data: JSON.stringify(step) });
          },
        });
        // Assembla il Workflow canonico dallo snapshot (default x/y, schema-validato)
        // → il frontend lo importa con la STESSA logica del wizard singleshot.
        // Fail-soft: assemblaggio non conforme → workflow null, snapshot resta.
        let workflow: ReturnType<typeof assembleWorkflow> | null = null;
        try {
          workflow = assembleWorkflow({
            name: body.goal.slice(0, 80),
            nodes: result.snapshot.nodes.map((n) => ({
              id: n.id,
              defId: n.defId,
              config: n.config,
            })),
            edges: result.snapshot.edges,
          });
        } catch (asmErr) {
          logger.warn(
            { err: asmErr instanceof Error ? asmErr.message : String(asmErr), tenantId },
            '[workflow-agent] assemble-workflow failed (snapshot resta disponibile)',
          );
        }
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ ...result, workflow }) });
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), tenantId },
          '[workflow-agent] build failed',
        );
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Generazione interrotta da un errore interno.' }),
        });
      }
    });
  });

  app.post('/modify', zValidator('json', ModifyBodySchema), async (c) => {
    if (!requireAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');

    const current = await loadSnapshot(opts, body.workflowId);
    if (!current) return c.json({ error: `Workflow "${body.workflowId}" non trovato.` }, 404);

    const turn = resolveTurn(tenantId, opts);
    if (!turn.ok) return c.json({ error: turn.error }, turn.status);
    const catalog = await resolveCatalog(opts);
    const configuredSecrets = await loadConfiguredSecrets(opts, tenantId);

    return streamSSE(c, async (stream) => {
      try {
        const result = await modifyWorkflow({
          catalog,
          currentWorkflow: current,
          request: body.request,
          llmTurn: turn.llmTurn,
          configuredSecrets,
          ...(body.extraContext ? { extraContext: body.extraContext } : {}),
          ...(body.maxIterations ? { maxIterations: body.maxIterations } : {}),
          onStep: (step) => {
            void stream.writeSSE({ event: 'step', data: JSON.stringify(step) });
          },
        });
        await stream.writeSSE({ event: 'done', data: JSON.stringify(result) });
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), tenantId },
          '[workflow-agent] modify failed',
        );
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Modifica interrotta da un errore interno.' }),
        });
      }
    });
  });

  return app;
}
