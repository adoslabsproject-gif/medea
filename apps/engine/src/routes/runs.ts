import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { RunService } from '@/services/run.service.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { tenantService, QuotaExceededError } from '@/services/tenant.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { rateLimit } from '@/middleware/rate-limit.js';
import { debugRunFailureExecutor } from '@/executors/debug-run-failure.js';

const ExecuteRunSchema = z.object({
  triggerInput: z.unknown().optional(),
  triggerType: z.string().optional(),
});

export function createRunRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const service = new RunService(eventBus);
  const workflows = new WorkflowService(eventBus);

  app.post('/workflows/:id/run', zValidator('json', ExecuteRunSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const workflowId = c.req.param('id');
    const body = c.req.valid('json');

    // AUDIT FIX WE-1 (2026-06-09 CRITICAL): X-Subworkflow-Depth è "internal-
    // only". Solo i caller autenticati via X-Internal-Token (subworkflow
    // executor → runtime HTTP loopback, vedi packages/.../logic/subworkflow.ts:50)
    // hanno il diritto di settare depth. Senza questo gate il client esterno
    // poteva mandare `X-Subworkflow-Depth: 0` → isInternalTrigger=true → skip
    // del quota check → bypass tier Free al cap workflow (esegue workflow
    // disabilitati senza pagare la quota slot).
    //
    // Il middleware auth (middleware/auth.ts:101) setta auth.userId='internal'
    // ESCLUSIVAMENTE dopo timing-safe match del MEDEA_INTERNAL_TOKEN. Quindi
    // questo è il segnale fidato sicuro per accettare il depth header.
    const auth = c.get('auth') as { userId?: string; role?: string } | null;
    const isInternalCaller = auth?.userId === 'internal';

    const depthHeader = c.req.header('x-subworkflow-depth');
    const depthParsed = depthHeader !== undefined ? Number(depthHeader) : NaN;
    // Accept il depth header SOLO se chiamata interna. Per caller esterni
    // → depth ignorato (= undefined) → trattato come depth 0 = run user-triggered.
    const subworkflowDepth =
      isInternalCaller && Number.isFinite(depthParsed)
        ? Math.max(0, Math.min(1_000_000, Math.floor(depthParsed)))
        : undefined;

    // Log esplicito quando un caller esterno tenta di iniettare depth (potenziale
    // exploit attempt → security signal per Sentinel). Nessun reject (silent
    // strip) — non vogliamo dare hint all'attacker della politica di gate.
    if (depthHeader !== undefined && !isInternalCaller) {
      logger.warn(
        { tenantId, workflowId, depthHeader, callerUserId: auth?.userId ?? 'anonymous' },
        '[SECURITY WE-1] external caller attempted X-Subworkflow-Depth injection — header stripped',
      );
    }

    try {
      // Quota gate (2026-06-06): testare un workflow DISABILITATO mentre il
      // tenant e\` gia\` al cap di workflow attivi equivale ad attivarlo
      // temporaneamente — bypass del piano. Blocca con messaggio chiaro.
      //
      // - Test via UI: triggerType e\` 'manual' o omesso (default UI button)
      // - Webhook trigger: triggerType e\` 'webhook' → il workflow e\` ENABLED
      //   per definizione (webhook su disabled return 404 prima di qui), skip
      // - Subworkflow nested: skip check (e\` gia\` parte di un run autorizzato
      //   del workflow padre, quel workflow ha gia\` pagato la quota di slot)
      const isInternalTrigger =
        body.triggerType === 'subworkflow' || subworkflowDepth !== undefined;
      if (!isInternalTrigger) {
        const wf = await workflows.get(workflowId, tenantId);
        if (wf && !wf.enabled) {
          try {
            // Un test di workflow DISABILITATO consuma 1 slot quota — verifica
            // SE c'e\` capacita\` aggiuntiva, altrimenti blocca con 402.
            tenantService.checkQuota(tenantId, 'workflows', 1);
          } catch (err) {
            if (err instanceof QuotaExceededError) {
              return c.json(
                {
                  error:
                    `Hai raggiunto il limite di ${String(err.limit)} workflow attivi del tuo piano. ` +
                    `Disattiva un workflow attivo per poter testare questo, oppure passa a un piano superiore.`,
                  code: 'QUOTA_TEST_BLOCKED',
                  limit: err.limit,
                  current: err.current,
                },
                402,
              );
            }
            throw err;
          }
        }
      }

      const input: Parameters<RunService['startAsync']>[0] = {
        workflowId,
        tenantId,
      };
      if (body.triggerInput !== undefined) input.triggerInput = body.triggerInput;
      if (body.triggerType !== undefined) input.triggerType = body.triggerType;
      if (actorId !== undefined) input.triggeredBy = actorId;
      if (subworkflowDepth !== undefined) input.subworkflowDepth = subworkflowDepth;

      // ASYNC fire-and-forget: ritorna subito con runId, l'engine gira in
      // background. Il client si iscrive a SSE `/dashboard/stream` per
      // vedere progresso live, e/o polla `GET /runs/:id` per terminale.
      // Risolve l'incident HTTP 504 su workflow > 60s (nginx timeout).
      const result = await service.startAsync(input);
      return c.json({ run: result, runId: result.runId }, 202);
    } catch (error) {
      logger.error({ err: error }, 'Run start failed');
      const message = error instanceof Error ? error.message : 'execution failed';
      const status = message.includes('not found') ? 404 : 500;
      return c.json({ error: message }, status);
    }
  });

  app.get('/workflows/:id/runs', async (c) => {
    const tenantId = getTenantId(c);
    const workflowId = c.req.param('id');
    const list = await service.list(workflowId, tenantId);
    return c.json({ runs: list, total: list.length });
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /runs/:id/replay — re-execute a historical run.
  //   ?fromStep=N → pin steps 0..N-1 to their original output and
  //                  re-execute from step N. Defaults to full re-run.
  //
  // N18 audit (2026-05-29): rate-limit per (tenant, user). Replay is
  // CPU-bound (re-runs every step of the historical run). Without a cap,
  // 1000 concurrent replays from a single session drive container CPU
  // to 100% and DoS the tenant. Tighter than llmRateLimit because replay
  // is purely compute (no LLM spend, no Liara queue) — 20/min/user gives
  // headroom for legitimate iterative debugging while still capping abuse.
  // ─────────────────────────────────────────────────────────────────
  app.post(
    '/runs/:id/replay',
    rateLimit({
      windowMs: 60_000,
      perTenant: 60,
      perUser: 20,
      label: 'run-replay',
    }),
    async (c) => {
      const tenantId = getTenantId(c);
      const runId = c.req.param('id') ?? '';
      if (runId === '') {
        return c.json({ error: 'missing run id' }, 400);
      }
      const fromStepRaw = c.req.query('fromStep');
      const fromStep = fromStepRaw !== undefined ? Number(fromStepRaw) : undefined;
      // D2 (2026-06-06): replay UX-friendly per nodeId. Risolto a fromStep
      // dal service. Permette al canvas editor di "Re-esegui da questo nodo"
      // senza dover sapere l'indice numerico nello steps array (instabile dopo refactor).
      // Accetta sia `fromNodeId` (canonico) sia `fromNode` (alias compat editor SPA).
      const fromNodeId = c.req.query('fromNodeId') ?? c.req.query('fromNode');
      try {
        const opts: { fromStep?: number; fromNodeId?: string; tenantId?: string } = { tenantId };
        if (fromStep !== undefined && Number.isFinite(fromStep) && fromStep >= 0) {
          opts.fromStep = fromStep;
        }
        if (fromNodeId && fromNodeId.length > 0 && fromNodeId.length <= 128) {
          opts.fromNodeId = fromNodeId;
        }
        const result = await service.replay(runId, opts);
        return c.json({ run: result }, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'replay failed';
        const status = message.includes('not found') ? 404 : 500;
        return c.json({ error: message }, status);
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // POST /runs/:id/cancel — cooperative cancel of an in-flight run.
  //
  //   200 → cancel signal accepted. The run will terminate at the next
  //         yield point (typically <1s for I/O-bound nodes). The final
  //         status is 'cancelled' (NOT 'error').
  //   404 → run not in-flight (already finished, never existed, or
  //         lives in another process — see clustering note below).
  //   409 → already cancelling/cancelled (idempotent — safe to retry).
  //
  // Clustering note: AbortController is per-process. In a multi-instance
  // deployment, the cancel request must reach the SAME process that holds
  // the run. Today FlowForge runs as a single Node process (single PM2
  // instance) so this is a non-issue. If we ever move to clustered mode,
  // this endpoint must broadcast via Redis pub/sub instead of in-process
  // map lookup. Documented for future-us.
  // ─────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────
  // POST /runs/:id/ai-debug — D3 AI moat one-click invoker.
  //
  // Esegue l'executor `agent_debug_run_failure` per il run specificato.
  // Use case: utente clicca "🤖 AI debug" nel RunInspector quando un run
  // termina in error. Restituisce diagnosis + suggestedFixes + replayCommand.
  //
  // Rate limit STRETTO: chiama Liara (5-15s + token spend). 5/min/user +
  // 20/min/tenant impediscono LLM spam su click-frenzy del frontend.
  // ─────────────────────────────────────────────────────────────────
  app.post(
    '/runs/:id/ai-debug',
    rateLimit({
      windowMs: 60_000,
      perTenant: 20,
      perUser: 5,
      label: 'run-ai-debug',
    }),
    async (c) => {
      const tenantId = getTenantId(c);
      const runId = c.req.param('id') ?? '';
      if (runId === '') {
        return c.json({ error: 'missing run id' }, 400);
      }
      const failedNodeId = c.req.query('failedNodeId');
      try {
        const result = await debugRunFailureExecutor(
          {
            runId,
            ...(failedNodeId !== undefined && failedNodeId !== '' ? { failedNodeId } : {}),
            includeTests: true,
            maxFixes: 3,
            autoReplay: false,
          },
          null,
          {
            tenantId,
            workflowId: '',
            runId: `ai-debug-${runId}`,
            nodeId: 'ai-debug-button',
            secrets: {},
          },
        );
        return c.json({ debug: result.output, durationMs: result.durationMs }, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ai-debug failed';
        const status = message.toLowerCase().includes('non trovato') ? 404 : 500;
        return c.json({ error: message }, status);
      }
    },
  );

  app.post('/runs/:id/cancel', async (c) => {
    const tenantId = getTenantId(c);
    const runId = c.req.param('id');
    const result = await service.cancel(runId, tenantId);
    if (!result.found) {
      return c.json({ error: 'Run unknown' }, 404);
    }
    // Idempotent: sia "cancel just sent" che "already cancelled" rispondono
    // 200 per evitare error-toast lato client su click ripetuti. Il client
    // distingue via `status` se serve.
    return c.json({ status: result.status, runId, alreadyDone: result.alreadyDone ?? false }, 200);
  });

  return app;
}
