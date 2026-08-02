import { eq, and, desc } from 'drizzle-orm';
import { coerceString } from '@/lib/coerce.js';
import { nanoid } from 'nanoid';
import { getDatabase } from '@/storage/db.js';
import { isWorkspaceReadOnly, WorkspaceReadOnlyError } from './readonly-flag.service.js';
import { assertTenantCanExecute } from './execution-gate.js';
import { getTenantErrorWorkflowId } from './error-workflow-flag.service.js';
import { buildErrorOutboxEvents, enqueueErrorOutbox } from './error-outbox/outbox-writer.js';
import { runs, type NewRunRow } from '@/storage/schema.js';
import { WorkflowEngine, type EngineSnapshot } from '@/engine/workflow-engine.js';
import { isQuotaResumeSignal } from '@/engine/quota-pause.js';
import { WorkflowService } from './workflow.service.js';
import { AuditLogService } from './audit.service.js';
import { PinService } from './pin.service.js';
import { PausedWorkflowsService, type PausedRow } from './paused-workflows.service.js';
import { CheckpointService } from './checkpoint.service.js';
import { LlmProvidersService } from './llm-providers.service.js';
import { GlobalVariablesService } from './global-variables.service.js';
import { getBinaryStore } from './binary-store.service.js';
import { recordRunOutcomeForTemplate } from './ai-scaffold/template-feedback.js';
import { safeParseJson } from '@/lib/safe-parse-json.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';

const audit = new AuditLogService();

// WE-14 rate-limit e fan-out error-workflow: RELOCATI nella pipeline outbox durevole
// (2026-06-19, review on_error). Il cap leaky-bucket vive ora in
// services/error-outbox/fanout-rate-limit.ts e il fan-out è dispatchato dal worker
// dell'outbox (durevole, at-least-once) anziché fire-and-forget qui. La finalizzazione
// del run enqueue gli eventi d'errore ATOMICAMENTE col mark-errored (#3).

/**
 * Map the engine's raw status + errorCount to the user-visible run status.
 * Truth-table:
 *   error           → 'error'    (red badge)
 *   any errorCount>0 → 'partial' (yellow badge: "completato con errori")
 *   partial         → 'partial'  (preserved — never reframed as success)
 *   paused          → 'paused'
 *   success+zero err → 'success' (green badge 🎉 — earned only with zero errors)
 *
 * Background: previously the persistence layer coerced 'partial' → 'success',
 * showing a green 🎉 next to "Primo nodo fallito" — a misleading UX that hid
 * production failures. Truthfulness is non-negotiable for an automation tool.
 */
type RunStatus = 'pending' | 'running' | 'success' | 'partial' | 'error' | 'paused' | 'cancelled';

function truthfulStatus(rawStatus: string, errorCount: number): RunStatus {
  if (rawStatus === 'error') return 'error';
  if (rawStatus === 'paused') return 'paused';
  if (rawStatus === 'partial' || errorCount > 0) return 'partial';
  if (
    rawStatus === 'success' ||
    rawStatus === 'pending' ||
    rawStatus === 'running' ||
    rawStatus === 'cancelled'
  )
    return rawStatus;
  return 'partial';
}

export interface ExecuteRunInput {
  workflowId: string;
  triggerInput?: unknown;
  triggerType?: string;
  triggeredBy?: string;
  tenantId?: string;
  /**
   * Optional externally-supplied runId. Used by `startAsync` to bridge
   * sync→async — il caller HTTP ha bisogno del runId nel response BEFORE
   * il background promise inizi a girare. Se omesso, viene generato un
   * nanoid() dentro executeWithPins (path tradizionale sync).
   */
  runId?: string;
  /**
   * Subworkflow depth — propagated by the `logic_subworkflow` node executor
   * via the X-Subworkflow-Depth header on `POST /workflows/:id/run`. Read
   * by the routes layer and passed through to the engine so each node
   * executor sees the correct depth in its NodeExecutionContext.
   * (N17 audit, anti-recursion-bomb.)
   */
  subworkflowDepth?: number;
  /**
   * GAP 4 (esecuzione parziale): l'engine si ferma DOPO questo nodo.
   * Usato dal replay single-node (`?fromNode=X&toNode=X`) — la run è
   * persistita normalmente (steps, status) ma il grafo a valle non gira.
   */
  stopAfterNodeId?: string;
}

export class RunService {
  private readonly engine: WorkflowEngine;
  private readonly workflows: WorkflowService;
  private readonly pins: PinService;
  private readonly paused: PausedWorkflowsService;
  private readonly checkpoints: CheckpointService;
  private static readonly inflight = new Map<string, number>();
  /**
   * Cancel tokens per runId: AbortController iniettato nell'engine per
   * cooperative cancellation. `cancelRun()` chiama `abort()` qui → ogni
   * loop iteration controlla `signal.aborted` → throw + UPDATE status.
   * Static perché il `RunService` è singleton per processo: tutti i run
   * vivono nella stessa map, indipendentemente da chi li ha lanciati.
   */
  private static readonly cancelTokens = new Map<string, AbortController>();

  /**
   * Numero di run attualmente in esecuzione in questo container. Usato dal
   * portal lifecycle sweeper via `/api/v1/internal/runs-active`: se >0 il
   * sweeper NON pausa il container (`docker pause` = SIGSTOP fermerebbe il
   * run a meta\` step). Pattern enterprise: heartbeat-pull dal portal invece
   * di heartbeat-push dal runtime — single source of truth = `cancelTokens`.
   */
  static getActiveRunCount(): number {
    return RunService.cancelTokens.size;
  }
  private readonly eventBus: IEventBus;

  constructor(eventBus: IEventBus) {
    this.eventBus = eventBus;
    this.workflows = new WorkflowService(eventBus);
    this.pins = new PinService();
    this.paused = new PausedWorkflowsService();
    this.checkpoints = new CheckpointService();
    // Engine receives its dependencies via constructor — clean DI, no
    // hidden globals, multiple RunService instances are perfectly safe.
    this.engine = new WorkflowEngine(eventBus, {
      pauseHandler: this.paused,
      checkpointHandler: this.checkpoints,
      llmProviders: new LlmProvidersService(),
      globalVariables: new GlobalVariablesService(),
      binaryStore: getBinaryStore(),
    });
  }

  async execute(input: ExecuteRunInput): Promise<{
    runId: string;
    status: string;
    steps: unknown[];
    totalDurationMs: number;
    errorCount: number;
  }> {
    const tenantId = input.tenantId ?? 'default';
    // Gate billing/lifecycle alla radice: trial scaduto/suspended → blocca.
    assertTenantCanExecute(tenantId);
    const pins = this.pins.getEnabledMap(input.workflowId, tenantId);
    return this.executeWithPins(input, pins);
  }

  /**
   * Async entry point — usato dalla route HTTP `POST /workflows/:id/run`.
   *
   * Lo run BLOCCANTE (`execute`) aspetta il completamento dell'engine.run
   * prima di rispondere al client. Per workflow lunghi (loop, wait_throttle,
   * agent_extractor, ...) la richiesta HTTP tiene aperta la connessione per
   * minuti → nginx proxy_read_timeout (default 60s) abbatte la richiesta →
   * il browser vede `HTTP 504 dal servizio chiamato da Run failed` anche
   * se il run sul backend è andato a buon fine.
   *
   * `startAsync` invece:
   *   1. Esegue il setup sincrono (validation, INSERT row con status='running',
   *      registra cancel token, sottoscrive event bus)
   *   2. Kicka l'engine.run in background (no await)
   *   3. Ritorna SUBITO `{ runId, status: 'running', steps: [] }`
   *   4. Il client si iscrive ad SSE `/dashboard/stream` o polla
   *      `GET /runs/:id` per vedere lo stato terminale.
   *
   * NB: replay/internal callers continuano a usare `execute` (sync) perché
   * vogliono il risultato finale nello stesso scope (es. webhook → return
   * payload nell'HTTP response).
   */
  async startAsync(input: ExecuteRunInput): Promise<{
    runId: string;
    status: string;
    steps: unknown[];
    totalDurationMs: number;
    errorCount: number;
  }> {
    const tenantId = input.tenantId ?? 'default';
    // Gate billing/lifecycle alla radice — copre anche queue mode, cron,
    // webhook e watcher (che NON passano dal middleware HTTP).
    assertTenantCanExecute(tenantId);
    const runIdEarly = nanoid();

    // QUEUE MODE (MEDEA_QUEUE_MODE=redis): invece di eseguire in-process,
    // delega a un worker BullMQ. Il check env è inline per NON trascinare
    // queue.service (e quindi bullmq/ioredis) nel module graph del path
    // inline-default — l'import è dinamico solo dentro il branch.
    if ((process.env.MEDEA_QUEUE_MODE ?? '').toLowerCase() === 'redis') {
      return this.dispatchToQueue(runIdEarly, input, tenantId);
    }

    const pins = this.pins.getEnabledMap(input.workflowId, tenantId);

    // Setup sincrono — abbiamo bisogno del runId PRIMA di rispondere.
    // executeWithPins fa già tutto questo, ma awaita anche l'engine.run.
    // Soluzione minima-invasiva: chiamiamo executeWithPins SENZA awaitarlo
    // e lo lasciamo runnare in background; per ottenere il runId early,
    // peek-iamo i `cancelTokens` (che vengono popolati appena la
    // INSERT row è committed). Bridge sync→async tramite una Promise
    // di "first event": runId è disponibile quando il primo 'run.step'
    // event è emesso. Per evitare race su workflow vuoti, fallback a
    // un nanoid generato qui e passato esplicitamente all'engine.
    //
    // Tradeoff: ridotta complessità (riusiamo executeWithPins as-is) vs
    // un piccolo delay nell'ottenere il runId. In pratica, l'INSERT è <5ms.
    const inputWithId: ExecuteRunInput = { ...input, runId: runIdEarly };
    void this.executeWithPins(inputWithId, pins).catch((err: unknown) => {
      logger.error(
        { err, runId: runIdEarly, workflowId: input.workflowId },
        'Async run failed in background',
      );
    });
    return {
      runId: runIdEarly,
      status: 'running',
      steps: [],
      totalDurationMs: 0,
      errorCount: 0,
    };
  }

  /**
   * Queue-mode dispatch (MEDEA_QUEUE_MODE=redis). Eseguito nel MAIN process:
   *   1. Valida che il workflow esista → 404 sincrono invece di un fallimento
   *      silenzioso nel worker.
   *   2. Inserisce una row `pending` (rispettando la verbosity: i run `silent`
   *      non persistono) così `GET /runs/:id` è pollabile SUBITO, prima che il
   *      worker prenda il job (niente 404-race per la dashboard).
   *   3. Accoda il job; il worker lo consuma e chiama `execute()` → la row
   *      transiziona `pending → running → terminale` sullo stesso runId.
   *
   * Su fallimento dell'enqueue (es. Redis down) elimina la row `pending`
   * orfana e rilancia, così il caller HTTP riceve un errore esplicito.
   */
  private async dispatchToQueue(
    runId: string,
    input: ExecuteRunInput,
    tenantId: string,
  ): Promise<{
    runId: string;
    status: string;
    steps: unknown[];
    totalDurationMs: number;
    errorCount: number;
  }> {
    if (isWorkspaceReadOnly()) {
      throw new WorkspaceReadOnlyError();
    }
    const workflow = await this.workflows.get(input.workflowId, tenantId);
    if (!workflow) {
      throw new Error(`Workflow ${input.workflowId} not found`);
    }

    const verbosity: 'silent' | 'summary' | 'full' =
      workflow.runVerbosity ?? (workflow.ephemeralRuns ? 'silent' : 'full');
    const trackRun = verbosity !== 'silent';

    const { db } = getDatabase();
    const startedAt = new Date().toISOString();
    if (trackRun) {
      const pendingRow: NewRunRow = {
        id: runId,
        workflowId: workflow.id,
        tenantId,
        status: 'pending',
        input:
          typeof input.triggerInput === 'string'
            ? input.triggerInput
            : JSON.stringify(input.triggerInput ?? null),
        stepsJson: '[]',
        errorCount: 0,
        totalDurationMs: 0,
        startedAt,
        endedAt: null,
      };
      if (input.triggerType !== undefined) pendingRow.triggerType = input.triggerType;
      if (input.triggeredBy !== undefined) pendingRow.triggeredBy = input.triggeredBy;
      if (input.triggerInput !== undefined)
        pendingRow.triggerPayloadJson = JSON.stringify(input.triggerInput);
      await db.insert(runs).values(pendingRow).onConflictDoNothing();
    }

    try {
      const { enqueueRun } = await import('./queue.service.js');
      await enqueueRun({
        workflowId: input.workflowId,
        tenantId,
        runId,
        ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {}),
        ...(input.triggerInput !== undefined ? { triggerInput: input.triggerInput } : {}),
        ...(input.triggeredBy !== undefined ? { triggeredBy: input.triggeredBy } : {}),
      });
    } catch (err) {
      // Enqueue fallito → la row `pending` resterebbe orfana. Puliscila e
      // rilancia così il caller HTTP riceve un 5xx esplicito.
      if (trackRun) {
        await db
          .delete(runs)
          .where(eq(runs.id, runId))
          .catch(() => undefined);
      }
      logger.error(
        { err, runId, workflowId: workflow.id },
        '[QUEUE] enqueue fallito — row pending rimossa',
      );
      throw err;
    }

    logger.info(
      { runId, workflowId: workflow.id, tenantId },
      '[QUEUE] run accodato (modalità distribuita)',
    );
    return { runId, status: 'pending', steps: [], totalDurationMs: 0, errorCount: 0 };
  }

  /**
   * Replay variant — caller supplies a pin map (e.g. for resume-from-step).
   * Same lifecycle as execute() but bypasses the persistent PinService.
   */
  async executeWithPins(
    input: ExecuteRunInput,
    pinnedOutputs: Map<string, unknown>,
  ): Promise<{
    runId: string;
    status: string;
    steps: unknown[];
    totalDurationMs: number;
    errorCount: number;
  }> {
    // Layer 2 read-only: workspace in disk over-quota grace → blocca OGNI
    // esecuzione (manual/scheduled/triggered/resume/subworkflow passano tutti da
    // qui), il vettore di crescita del disco. Edit/delete/read restano consentiti
    // (gestiti dalle altre route) così l'utente può rientrare sotto il limite.
    if (isWorkspaceReadOnly()) {
      throw new WorkspaceReadOnlyError();
    }
    const tenantId = input.tenantId ?? 'default';
    const workflow = await this.workflows.get(input.workflowId, tenantId);
    if (!workflow) {
      throw new Error(`Workflow ${input.workflowId} not found`);
    }

    // Concurrent-run limit per workflow.
    // Race fix DD audit (2026-06-01) — check-then-increment atomico.
    // Pre-fix: 2 request entrate simultanee leggevano entrambe current=4
    // (limit=5), entrambe passavano la guard, entrambe set(5) → 6 effective
    // inflight (1 oltre il limite).
    // Fix: lock-free CAS via Map.get + immediate Map.set guard riconfermando
    // il valore. Node.js single-thread garantisce che set+get sono atomic
    // RISPETTO al SAME tick — ma più request HTTP arrivano nel SAME tick
    // event loop? No, Node.js queue-and-execute, ogni handler tick separato.
    // Tuttavia la `await` PRIMA di questa sezione (workflow load) cede
    // controllo → ALTRE request ne approfittano. Quindi il pattern sicuro è:
    // increment OPTIMISTICALLY prima del check, e rollback su limit reached.
    const limit = workflow.concurrencyLimit ?? 0;
    const inflightKey = `${tenantId}:${workflow.id}`;
    const newCount = (RunService.inflight.get(inflightKey) ?? 0) + 1;
    RunService.inflight.set(inflightKey, newCount);
    if (limit > 0 && newCount > limit) {
      // Rollback increment
      const rollback = (RunService.inflight.get(inflightKey) ?? 1) - 1;
      if (rollback <= 0) RunService.inflight.delete(inflightKey);
      else RunService.inflight.set(inflightKey, rollback);
      throw new Error(
        `Workflow ${workflow.id} concurrent-run limit reached (${limit.toString()}); ${(newCount - 1).toString()} already in-flight`,
      );
    }

    const { db, sqlite } = getDatabase();
    const startedAt = new Date().toISOString();

    // 2026-06-07 sera (tier-aware logging): tri-state run verbosity.
    //   'silent'  → niente persistence, niente subscribe, niente audit.
    //   'summary' → row persistito ma steps_json trimmed (no input/output).
    //   'full'    → comportamento storico (steps completi).
    //
    // Back-compat: NULL → legge ephemeralRuns (true=silent, false=full).
    const verbosity: 'silent' | 'summary' | 'full' =
      workflow.runVerbosity ?? (workflow.ephemeralRuns ? 'silent' : 'full');
    const trackRun = verbosity !== 'silent';
    const trimSteps = verbosity === 'summary';

    // Standard 2026: INSERT row con status='running' SUBITO, prima di
    // engine.run(). Così:
    //   • GET /runs/:id ritorna 200 anche durante l'esecuzione
    //   • La cronologia mostra il run "in corso" in tempo reale
    //   • Dashboard live hydration funziona (era 404 prima → animazione muore)
    //   • Crash recovery: se il processo muore, il sweeper trova run orfani
    //     in stato 'running' e li marca 'error' (no zombie).
    // L'ID viene generato qui (nanoid) e passato all'engine via opts.runId
    // così engine usa lo stesso ID per gli SSE events.
    const runIdEarly = input.runId ?? nanoid();
    if (trackRun) {
      const earlyRow: NewRunRow = {
        id: runIdEarly,
        workflowId: workflow.id,
        tenantId,
        status: 'running',
        input:
          typeof input.triggerInput === 'string'
            ? input.triggerInput
            : JSON.stringify(input.triggerInput ?? null),
        stepsJson: '[]',
        errorCount: 0,
        totalDurationMs: 0,
        startedAt,
        endedAt: null,
      };
      if (input.triggerType !== undefined) earlyRow.triggerType = input.triggerType;
      if (input.triggeredBy !== undefined) earlyRow.triggeredBy = input.triggeredBy;
      if (input.triggerInput !== undefined)
        earlyRow.triggerPayloadJson = JSON.stringify(input.triggerInput);
      // Upsert (non plain insert): in QUEUE MODE il main process ha già
      // inserito una row `pending` con questo runId (vedi `dispatchToQueue`).
      // Quando il worker esegue, qui la transizioniamo `pending → running`
      // invece di crashare su conflitto PK. Per i run inline (runId nuovo via
      // nanoid) non c'è mai conflitto → si comporta come un insert normale.
      await db
        .insert(runs)
        .values(earlyRow)
        .onConflictDoUpdate({
          target: runs.id,
          set: { status: 'running', startedAt, endedAt: null },
        });
    }

    // ── UPDATE incrementale steps_json ─────────────────────────────────
    // Subscribe agli step events dell'engine e flush su DB ogni 2s.
    // Senza questo, GET /runs/:id durante un run di 20 min ritorna steps=[]
    // → Dashboard hydration vede 0 step → animazione muore. Con questo,
    // il run è sempre query-abile real-time.
    const accumulatedSteps: unknown[] = [];
    let stepsDirty = false;
    let flushTimer: NodeJS.Timeout | null = null;
    /**
     * Trim a step record to summary fields only: { nodeId, status,
     * durationMs, errorCount }. Drops input/output binaries (saves
     * ~99% storage per row on workflow webhook proxy paths).
     */
    const trimStep = (step: unknown): unknown => {
      if (!step || typeof step !== 'object') return step;
      const s = step as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      if (typeof s.nodeId === 'string') out.nodeId = s.nodeId;
      if (typeof s.status === 'string') out.status = s.status;
      if (typeof s.durationMs === 'number') out.durationMs = s.durationMs;
      if (typeof s.errorCount === 'number') out.errorCount = s.errorCount;
      // Conservare il messaggio d'errore (corto) — utile per cronologia
      // anche in modalità summary; clamp a 500 char per sicurezza.
      if (typeof s.error === 'string') out.error = s.error.slice(0, 500);
      return out;
    };
    const serializeSteps = (steps: readonly unknown[]): string =>
      JSON.stringify(trimSteps ? steps.map(trimStep) : steps);
    const scheduleFlush = (): void => {
      if (!trackRun) return; // silent: niente flush incrementale
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!stepsDirty) return;
        stepsDirty = false;
        const json = serializeSteps(accumulatedSteps);
        db.update(runs)
          .set({ stepsJson: json })
          .where(eq(runs.id, runIdEarly))
          .catch((e: unknown) => {
            logger.warn({ err: e, runId: runIdEarly }, 'Incremental steps_json update failed');
          });
      }, 2000);
    };
    // Cooperative cancellation: registra AbortController per questo run.
    // L'engine controllerà signal.aborted nei punti di yield (loop body,
    // wait_throttle, fetch contact_discovery, ecc.). cancelRun(runId) chiama
    // abort() → engine throws → finally pulisce + UPDATE status='cancelled'.
    const cancelCtrl = new AbortController();
    RunService.cancelTokens.set(runIdEarly, cancelCtrl);

    // Ephemeral runs: niente subscribe agli step events → niente
    // accumulatedSteps in memoria → niente flush DB.
    const unsubscribeStep = trackRun
      ? this.eventBus.subscribeTo('run.step', (evt) => {
          const data = (evt as { data?: { runId?: string; step?: unknown } }).data;
          if (data?.runId !== runIdEarly || !data.step) return;
          accumulatedSteps.push(data.step);
          stepsDirty = true;
          scheduleFlush();
        })
      : () => {
          /* no-op unsubscribe */
        };

    let result;
    try {
      result = await this.engine.run({
        workflow,
        triggerInput: input.triggerInput,
        ...(input.triggeredBy !== undefined ? { triggeredBy: input.triggeredBy } : {}),
        tenantId,
        ...(pinnedOutputs.size > 0 ? { pinnedOutputs } : {}),
        runId: runIdEarly,
        cancelSignal: cancelCtrl.signal,
        ...(input.subworkflowDepth !== undefined
          ? { subworkflowDepth: input.subworkflowDepth }
          : {}),
        ...(input.stopAfterNodeId !== undefined ? { stopAfterNodeId: input.stopAfterNodeId } : {}),
      });
    } catch (err) {
      // Cancel intenzionale → 'cancelled' (NON 'error'). L'utente ha
      // premuto Stop, è dietro front consapevole, non un crash. La UX
      // distingue: cancelled = grigio "interrotto dall'utente",
      // error = rosso "esecuzione fallita".
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted|cancelled/i.test(err.message));
      if (trackRun) {
        await db
          .update(runs)
          .set({
            status: isAbort ? 'cancelled' : 'error',
            stepsJson: serializeSteps(accumulatedSteps),
            endedAt: new Date().toISOString(),
            totalDurationMs: Date.now() - new Date(startedAt).getTime(),
          })
          .where(eq(runs.id, runIdEarly));
      }
      if (isAbort) {
        // L'abort è la via terminale "voluta" — emettere un evento dedicato
        // così SSE notifica subito la dashboard senza aspettare un poll.
        this.eventBus.emit({
          name: 'run.cancelled',
          tenantId,
          data: { runId: runIdEarly, workflowId: workflow.id },
          ts: new Date().toISOString(),
        });
        return {
          runId: runIdEarly,
          status: 'cancelled',
          steps: accumulatedSteps,
          totalDurationMs: Date.now() - new Date(startedAt).getTime(),
          errorCount: 0,
        };
      }
      throw err;
    } finally {
      // Cleanup listener + cancella timer pending (l'UPDATE finale sotto
      // sovrascrive steps_json comunque, no race condition).
      unsubscribeStep();
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Rimuovi il cancel token: il run è terminato (success/error/cancelled),
      // niente più bisogno di mantenere l'AbortController in memoria.
      RunService.cancelTokens.delete(runIdEarly);
      const after = (RunService.inflight.get(inflightKey) ?? 1) - 1;
      if (after <= 0) RunService.inflight.delete(inflightKey);
      else RunService.inflight.set(inflightKey, after);
    }

    // Paused runs keep ended_at NULL so the recovery sweeper can find them
    // e la UI può renderizzare lo stato "⏸ in attesa del signal X".
    const endedAt = result.status === 'paused' ? null : new Date().toISOString();
    // UPDATE: il row esiste già (insert early), arricchiamo con dati finali.
    // Skipped on ephemeral: row non era stato inserito, niente da aggiornare.
    if (trackRun) {
      // #3 ATOMICITÀ (review on_error): la finalizzazione del run (mark-errored) e
      // l'enqueue delle notifiche d'errore vivono nella STESSA transazione SQLite
      // (stessa connessione per-tenant) → o entrambe o nessuna. Se l'enqueue
      // fallisse, il run resta non-finalizzato e il CheckpointRecoveryService lo
      // ri-finalizza al riavvio (at-least-once, niente notifica persa su crash).
      const isErrored = result.status === 'error' || result.errorCount > 0;
      const failedStep = isErrored ? result.steps.find((s) => s.status === 'error') : undefined;

      // errorWorkflowId risolto PRIMA della tx (lookup async): decide se creare la
      // riga 'fanout'. Anti-loop (#4) e anti-self restano nel builder + dispatcher.
      let resolvedErrWfId: string | null = null;
      if (result.status === 'error' && input.triggerType !== 'error-handler') {
        try {
          resolvedErrWfId =
            (await this.workflows.getErrorWorkflowId(workflow.id, tenantId)) ??
            getTenantErrorWorkflowId();
        } catch (e) {
          logger.warn(
            { err: e instanceof Error ? e.message : String(e), workflowId: workflow.id },
            'Error workflow lookup failed (nessun fanout enqueued)',
          );
        }
      }

      const triggerInputJson =
        typeof input.triggerInput === 'string'
          ? input.triggerInput
          : JSON.stringify(input.triggerInput ?? null);
      const outboxEvents = isErrored
        ? buildErrorOutboxEvents({
            runId: result.runId,
            workflowId: workflow.id,
            tenantId,
            errorNodeId: failedStep?.nodeId ?? null,
            errorMessage: failedStep?.error ?? null,
            durationMs: result.totalDurationMs,
            startedAt,
            triggerType: input.triggerType ?? null,
            triggerInputJson,
            onError: workflow.onError ?? null,
            errorWorkflowId: resolvedErrWfId,
            nextAttemptAt: new Date().toISOString(),
            // id deterministico (runId:channel) → enqueue idempotente anche se il
            // recovery ri-finalizza lo stesso run (#6 dedup, oltre a UNIQUE(run,channel)).
            idFor: (channel) => `${result.runId}:${channel}`,
          })
        : [];

      const finalize = sqlite.transaction(() => {
        db.update(runs)
          .set({
            status: truthfulStatus(result.status, result.errorCount),
            stepsJson: serializeSteps(result.steps),
            errorCount: result.errorCount,
            totalDurationMs: result.totalDurationMs,
            endedAt,
          })
          .where(eq(runs.id, runIdEarly))
          .run();
        if (outboxEvents.length > 0) enqueueErrorOutbox(sqlite, outboxEvents);
      });
      finalize();

      await audit.append({
        tenantId,
        action: 'workflow.run',
        resourceType: 'workflow',
        resourceId: workflow.id,
        ...(input.triggeredBy !== undefined ? { actorId: input.triggeredBy } : {}),
        metadata: {
          runId: result.runId,
          status: result.status,
          durationMs: result.totalDurationMs,
        },
      });
    }

    logger.info(
      {
        runId: result.runId,
        workflowId: workflow.id,
        status: result.status,
        durationMs: result.totalDurationMs,
      },
      'Run completed',
    );

    // Feedback loop AI scaffold (gap #1 audit RAG): se il workflow eseguito
    // combacia strutturalmente con un template della cache, l'ESITO REALE
    // del run alimenta success_count/fail_count → il ranking dei template
    // impara dai run, non solo dai match testuali. 'partial' conta come
    // fallimento (severità onesta: il template ha prodotto errori). Le pause
    // non sono un esito. Fail-soft by-design (vedi template-feedback.ts).
    if (result.status !== 'paused') {
      recordRunOutcomeForTemplate(
        { nodes: workflow.nodes, edges: workflow.edges },
        result.status === 'success',
      );
    }

    // Successful, non-paused runs no longer need their checkpoints.
    // We keep checkpoints for 'partial'/'error' so a manual replay can use them.
    if (result.status === 'success') {
      this.checkpoints.purge(result.runId);
    }

    // GAP 5 (b): evento errore STRUTTURATO nell'audit log immutabile — la "scatola
    // nera" del run fallito sopravvive anche all'archiviazione di runs. Fail-soft.
    // NB: la NOTIFICA d'errore (fan-out error-workflow + onError webhook/email) NON
    // è più fire-and-forget qui: è stata enqueued ATOMICAMENTE col mark-errored
    // (sopra, #3) e viene dispatchata in modo DUREVOLE dall'outbox scheduler
    // (at-least-once, retry/backoff, dead-letter, per-canale, SSRF-safe, email via
    // portal 587). Anti-loop/anti-self/rate-limit/AI-triage preservati nel dispatcher.
    if (result.status === 'error') {
      const failed = result.steps.find((s) => s.status === 'error');
      try {
        await new AuditLogService().append({
          tenantId,
          actorId: input.triggeredBy ?? 'system',
          action: 'workflow.run.errored',
          resourceType: 'run',
          resourceId: result.runId,
          metadata: {
            workflowId: workflow.id,
            workflowName: workflow.name,
            triggerType: input.triggerType ?? null,
            errorCount: result.errorCount,
            failedNodeId: failed?.nodeId ?? null,
            error: (failed?.error ?? '').slice(0, 500),
          },
        });
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), runId: result.runId },
          'Audit run-errored append failed (fail-soft)',
        );
      }
    }

    return result;
  }

  /**
   * Replay a historical run. Three modes:
   *   - fromStart (default): re-run con lo stesso triggerInput.
   *   - fromStep N: pin steps 0..N-1 originali, re-esegui da step N.
   *   - fromNodeId: pin TUTTI gli step PRIMA del nodeId target, re-esegui
   *     da quel nodo. UX-friendly per "Re-esegui da questo nodo" sull'editor.
   *     Se nodeId appare più volte (es. dentro un loop), pinna fino al
   *     PRIMO occorrenza (replay riesegue da quella in poi).
   */
  async replay(
    runId: string,
    opts: { fromStep?: number; fromNodeId?: string; tenantId?: string },
  ): Promise<unknown> {
    const { db } = getDatabase();
    const existing = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    const prior = existing[0];
    if (!prior) throw new Error(`Run ${runId} not found`);
    const tenantId = opts.tenantId ?? prior.tenantId ?? 'default';
    const stepsRaw = safeParseJson(prior.stepsJson);
    const priorSteps: { nodeId: string; output: string; status: string }[] = Array.isArray(stepsRaw)
      ? (stepsRaw as { nodeId: string; output: string; status: string }[])
      : [];

    const triggerInput: unknown = prior.input ? safeParseJson(prior.input) : null;

    // Resolve fromNodeId → fromStep (UX-friendly handle per editor button)
    let resolvedFromStep = opts.fromStep;
    if (opts.fromNodeId && resolvedFromStep === undefined) {
      const idx = priorSteps.findIndex((s) => s.nodeId === opts.fromNodeId);
      if (idx < 0) {
        throw new Error(`Node ${opts.fromNodeId} not found in run ${runId} history`);
      }
      resolvedFromStep = idx;
    }

    // Build pin map: every step before `fromStep` is pinned to its
    // original output (parsed from string). The engine then skips
    // executors and uses the pinned value as the node's output.
    const pins = new Map<string, unknown>();
    if (resolvedFromStep !== undefined && resolvedFromStep > 0) {
      const upTo = Math.min(resolvedFromStep, priorSteps.length);
      for (let i = 0; i < upTo; i += 1) {
        const s = priorSteps[i];
        if (s?.status !== 'success') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(s.output);
        } catch {
          parsed = s.output;
        }
        pins.set(s.nodeId, parsed);
      }
    }

    return this.executeWithPins(
      {
        workflowId: prior.workflowId,
        triggerInput,
        tenantId,
        triggeredBy: opts.fromNodeId
          ? `replay-from-node:${runId}:${opts.fromNodeId}`
          : `replay:${runId}`,
      },
      pins,
    );
  }

  /**
   * Resume a run from its latest checkpoint after a process crash.
   * Called by CheckpointRecoveryService at boot.
   */
  async resumeFromCheckpoint(runId: string): Promise<unknown> {
    const cp = this.checkpoints.latest(runId);
    if (!cp) throw new Error(`No checkpoint found for run ${runId}`);
    const workflow = await this.workflows.get(cp.workflowId, cp.tenantId);
    if (!workflow) throw new Error(`Workflow ${cp.workflowId} not found`);
    // AUDIT FIX WE-3 (2026-06-09): il CheckpointRecoveryService claim atomico
    // ha settato status='recovering'. Ora che siamo effettivamente in esecuzione,
    // ripristiniamo status='running' per visibilità esterna (dashboard, route
    // GET /runs/active) → atomic single-claim garantito by claim phase.
    const { db: dbResume } = getDatabase();
    await dbResume.update(runs).set({ status: 'running' }).where(eq(runs.id, runId));
    const snapshot: EngineSnapshot = {
      runId: cp.runId,
      workflowId: cp.workflowId,
      tenantId: cp.tenantId,
      outputsById: new Map(Object.entries(cp.outputsById)),
      visited: new Set(cp.visited),
      pendingQueue: cp.pendingQueue,
      // GAP #2: il lineage sopravvive al crash — i nodi post-recovery
      // risolvono .item/itemMatching contro i nodi pre-crash.
      itemGraph: new Map(Object.entries(cp.itemGraph)),
      stepsSoFar: [],
      errorCount: 0,
      startedAt: Date.now(),
    };
    const result = await this.engine.resume(snapshot, workflow);
    // Mark the run row as finished
    const { db } = getDatabase();
    await db
      .update(runs)
      .set({
        status: truthfulStatus(result.status, result.errorCount),
        endedAt: new Date().toISOString(),
      })
      .where(eq(runs.id, runId));
    if (result.status === 'success') this.checkpoints.purge(runId);
    return result;
  }

  /**
   * Resume a workflow that was suspended on a wait_signal node. Called by
   * the SignalService when the matching POST /signals/:name arrives.
   *
   * Rebuilds the EngineSnapshot, walks the post-pause downstream edges
   * with the signal payload as carriedInput, and re-enters the engine.
   */
  async resumeFromPause(row: PausedRow): Promise<unknown> {
    const workflow = await this.workflows.get(row.workflowId, row.tenantId);
    if (!workflow) {
      throw new Error(
        `Workflow ${row.workflowId} not found — cannot resume paused run ${row.runId}`,
      );
    }
    // Seeding della coda di resume, diverso per TIPO di pausa:
    //  • wait_signal (utente): semina il DOWNSTREAM del nodo wait col payload
    //    del signal (il nodo wait NON si ri-esegue, è già "completato").
    //  • quota (quota:renewed:*): il nodo LLM è già stato de-visitato +
    //    ri-accodato in pendingQueue dall'engine → si RI-ESEGUE (quota rinnovata).
    //    NIENTE seeding downstream, altrimenti salteremmo la ri-esecuzione.
    const seededQueue = isQuotaResumeSignal(row.signalName)
      ? row.pendingQueue.slice()
      : [
          ...row.pendingQueue,
          ...workflow.edges
            .filter((e) => e.from === row.atNodeId)
            .map((e) => ({ nodeId: e.to, carriedInput: row.defaultPayload })),
        ];
    const snapshot: EngineSnapshot = {
      runId: row.runId,
      workflowId: row.workflowId,
      tenantId: row.tenantId,
      outputsById: new Map(Object.entries(row.outputsById)),
      visited: new Set(row.visited),
      pendingQueue: seededQueue,
      // GAP #2: il lineage sopravvive alla pausa — i rami residui in
      // pendingQueue (sourceNodeId pre-pausa) risolvono il paired al resume.
      itemGraph: new Map(Object.entries(row.itemGraph)),
      stepsSoFar: [],
      errorCount: 0,
      startedAt: Date.now(),
    };
    const result = await this.engine.resume(snapshot, workflow);
    // Update the runs row to reflect the resume — append steps, update status
    const { db } = getDatabase();
    const existing = await db.select().from(runs).where(eq(runs.id, row.runId)).limit(1);
    const prior = existing[0];
    if (prior) {
      const priorParsed = safeParseJson(prior.stepsJson);
      const priorSteps: unknown[] = Array.isArray(priorParsed) ? priorParsed : [];
      const combined = [...priorSteps, ...result.steps];
      await db
        .update(runs)
        .set({
          status: truthfulStatus(result.status, result.errorCount),
          stepsJson: JSON.stringify(combined),
          errorCount: prior.errorCount + result.errorCount,
          endedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, row.runId));
    }
    return result;
  }

  /**
   * Cooperative cancel: abort the in-flight engine run for this id.
   *
   * Returns an object describing what happened so the HTTP layer can map
   * it to 200 / 404 / 409 without a try/catch. We DELIBERATELY do not
   * touch the DB row here — the engine's catch+finally will UPDATE the
   * row to status='cancelled' once it observes signal.aborted at the
   * next yield point. Doing the UPDATE here in addition would race with
   * the engine's own status write.
   *
   * Note: cancellation is COOPERATIVE. A node executor that is busy in a
   * synchronous CPU-bound loop will not honor abort until it next awaits.
   * Long-running awaits (fetch, db query, setTimeout in retry, signal
   * loops) all respect AbortController natively — this is the 99% case.
   */
  async cancel(
    runId: string,
    tenantId = 'default',
  ): Promise<{ found: boolean; alreadyDone?: boolean; status?: string }> {
    const ctrl = RunService.cancelTokens.get(runId);
    if (ctrl) {
      if (ctrl.signal.aborted) {
        return { found: true, alreadyDone: true, status: 'cancelled' };
      }
      // Trigger abort: ogni awaiter che tiene il `signal` risolve/rejects
      // secondo il proprio contratto. Il BFS dell'engine controlla
      // `signal.aborted` tra i nodi e throw DOMException('AbortError') che
      // il catch in run() converte in status='cancelled'.
      ctrl.abort(new DOMException(`Run ${runId} cancelled by user`, 'AbortError'));
      // #208 P0-9: await — audit durable (per non perdere l'evento se crash dopo return).
      await audit.append({
        tenantId,
        action: 'run.cancel',
        resourceType: 'run',
        resourceId: runId,
        metadata: { source: 'api' },
      });
      return { found: true, alreadyDone: false, status: 'cancelling' };
    }

    // ── ORPHAN run handling ────────────────────────────────────────────
    //
    // Se non c'è cancelToken in memoria, il run è in uno di 3 stati:
    //   A) Già completato (success/error/cancelled) → idempotente, 200 OK
    //   B) Orphan (status='running' ma il processo che lo eseguiva è morto
    //      — restart, crash, deploy). Il sweeper avrebbe marcato 'error',
    //      ma se siamo veloci a chiamare cancel prima dello sweeper, NON
    //      possiamo abortire un controller che non esiste. Però possiamo
    //      MARCARE il row come 'cancelled' direttamente in DB — l'UI vede
    //      lo stato terminale e l'utente non resta bloccato.
    //   C) runId bogus / di un altro tenant → 404 dopo la lookup
    //
    // Pattern: prima query DB, poi decidi.
    const { db } = getDatabase();
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
      .limit(1);

    if (!row) {
      return { found: false };
    }

    if (row.status !== 'running' && row.status !== 'pending') {
      // Già terminale — operazione idempotente.
      return { found: true, alreadyDone: true, status: row.status };
    }

    // Orphan run: force-mark cancelled in DB. Niente engine da fermare
    // (il processo che lo runava è morto), ma il row va aggiornato.
    const now = new Date().toISOString();
    await db
      .update(runs)
      .set({
        status: 'cancelled',
        endedAt: now,
        totalDurationMs: Date.now() - new Date(row.startedAt).getTime(),
      })
      .where(eq(runs.id, runId));

    // #208 P0-9: await — audit durable.
    await audit.append({
      tenantId,
      action: 'run.cancel',
      resourceType: 'run',
      resourceId: runId,
      metadata: { source: 'api', orphan: true },
    });

    this.eventBus.emit({
      name: 'run.cancelled',
      tenantId,
      data: { runId, workflowId: row.workflowId, orphan: true },
      ts: now,
    });

    return { found: true, alreadyDone: false, status: 'cancelled' };
  }

  /**
   * Singolo run by id, tenant-scoped. Ritorna null se non esiste o se
   * appartiene a un altro tenant (defense in depth contro id leak).
   * Usato dal Client Portal per il dettaglio gated by visibility.
   */
  async getById(
    runId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    workflowId: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    totalDurationMs: number | null;
    errorCount: number | null;
    steps: {
      nodeId: string;
      nodeLabel: string;
      status: string;
      startedAt?: string | null;
      finishedAt?: string | null;
      durationMs?: number | null;
    }[];
  } | null> {
    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let steps: {
      nodeId: string;
      nodeLabel: string;
      status: string;
      startedAt?: string | null;
      finishedAt?: string | null;
      durationMs?: number | null;
    }[] = [];
    const parsed = safeParseJson(row.stepsJson);
    if (Array.isArray(parsed)) {
      steps = parsed
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({
          nodeId: coerceString(s.nodeId ?? ''),
          nodeLabel: coerceString(s.nodeLabel ?? s.nodeId ?? ''),
          status: coerceString(s.status ?? 'unknown'),
          startedAt: (s.startedAt as string | null | undefined) ?? null,
          finishedAt: (s.finishedAt as string | null | undefined) ?? null,
          durationMs: typeof s.durationMs === 'number' ? s.durationMs : null,
        }));
    }
    return {
      id: row.id,
      workflowId: row.workflowId,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.endedAt,
      totalDurationMs: row.totalDurationMs,
      errorCount: row.errorCount,
      steps,
    };
  }

  async list(workflowId: string, tenantId = 'default'): Promise<unknown[]> {
    const { db } = getDatabase();
    const rows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.workflowId, workflowId), eq(runs.tenantId, tenantId)))
      .orderBy(desc(runs.startedAt))
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflowId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      totalDurationMs: row.totalDurationMs,
      errorCount: row.errorCount,
      steps: safeParseJson(row.stepsJson),
    }));
  }

  /**
   * Recent runs per tenant (cross-workflow). Usato dal Client Portal per
   * la cronologia "ultimi N" filtrata applicativamente per workflow
   * visibili al token. Sostituisce il loop N+1 di {@link list}.
   */
  async listRecent(
    tenantId: string,
    limit = 20,
  ): Promise<
    {
      id: string;
      workflowId: string;
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
      totalDurationMs: number | null;
    }[]
  > {
    const { db } = getDatabase();
    const capped = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = await db
      .select({
        id: runs.id,
        workflowId: runs.workflowId,
        status: runs.status,
        startedAt: runs.startedAt,
        endedAt: runs.endedAt,
        totalDurationMs: runs.totalDurationMs,
      })
      .from(runs)
      .where(eq(runs.tenantId, tenantId))
      .orderBy(desc(runs.startedAt))
      .limit(capped);
    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflowId,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.endedAt,
      totalDurationMs: row.totalDurationMs,
    }));
  }
}
