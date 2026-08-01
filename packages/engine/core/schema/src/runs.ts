import { z } from 'zod';

export const RunStepStatusSchema = z.enum(['pending', 'running', 'success', 'error', 'skipped', 'paused']);
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>;

/**
 * Log level — RFC 5424 syslog severity adattato a Pino + custom 'fatal'.
 * Ordinati per severità crescente: trace < debug < info < warn < error < fatal.
 */
export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Log source — chi ha emesso l'entry.
 *
 *  - user     : console.log/warn/error chiamato esplicitamente dall'utente
 *               dentro un Custom Node Editor (codice loro)
 *  - sandbox  : sandbox internals (fetch proxy, security guard, abort)
 *  - engine   : workflow engine (retry, breaker, drift, schedule)
 *  - network  : HTTP request/response trace (auto-capture in safeOutboundFetch)
 *  - system   : container/process events (cron, memory, restart)
 *  - llm      : Liara/LLM calls + tokens/cache
 *  - db       : SQLite tenant queries + slow query alerts
 */
export const LogSourceSchema = z.enum(['user', 'sandbox', 'engine', 'network', 'system', 'llm', 'db']);
export type LogSource = z.infer<typeof LogSourceSchema>;

/**
 * StepLog — entry strutturato Cappella Sistina+ per step di run.
 *
 * Design enterprise+:
 *  - timestamp wall-clock (`ts`) ISO 8601 millisecond per ordinamento globale
 *    + monotonic offset (`mono`) per ordering preciso intra-step (Date.now()
 *    può andare indietro su NTP sync — mono no)
 *  - level + source per filtering rapido
 *  - fields strutturati per query (NON solo string blob → indicizzabile)
 *  - W3C Trace Context: `traceId`/`spanId`/`parentSpanId` per distributed
 *    tracing OTel-compatible (16+8 hex chars)
 *  - `seq` monotonic counter per step → garantisce ordering deterministico
 *    quando ts ha resolution ms e arrivano 100+ log nello stesso ms
 *
 * Performance:
 *  - msg cap 2048 chars (oltre → truncate con suffix "[+N chars]")
 *  - fields cap 4KB JSON serialized
 *  - per-step cap (gestito da LogCollector): 256 entries / 64KB totale
 */
export const StepLogSchema = z.object({
  /** ISO 8601 millisecond timestamp (Date.now() → toISOString). */
  ts: z.string().datetime({ offset: true }),
  /** Monotonic offset from step start, in ns. Per ordering precision. */
  mono: z.number().int().nonnegative().optional(),
  /** Sequence number monotonic crescente nello step (anti tie-break). */
  seq: z.number().int().nonnegative(),
  level: LogLevelSchema,
  source: LogSourceSchema,
  /** Human-readable message, cap 2048 chars. */
  msg: z.string().max(2048),
  /** Structured fields per query (es. { url, status, durationMs }). */
  fields: z.record(z.string(), z.unknown()).optional(),
  /** W3C Trace Context — propagated cross-step/cross-tenant for OTel. */
  traceId: z.string().regex(/^[0-9a-f]{32}$/u).optional(),
  spanId: z.string().regex(/^[0-9a-f]{16}$/u).optional(),
  parentSpanId: z.string().regex(/^[0-9a-f]{16}$/u).optional(),
  /** Marker truncation: 'msg' o 'fields' tagliati per evitare OOM. */
  truncated: z.boolean().optional(),
});
export type StepLog = z.infer<typeof StepLogSchema>;

export const RunStepSchema = z.object({
  nodeId: z.string().min(1),
  /** Node def ID (e.g. trigger_imap, action_pdf_parse) — used by the
   *  dashboard live view to look up the human-readable label and icon
   *  via nodeMeta without having to re-fetch the workflow definition. */
  defId: z.string().optional(),
  nodeLabel: z.string(),
  nodeIcon: z.string().optional(),
  status: RunStepStatusSchema,
  input: z.string().optional(),
  output: z.string(),
  error: z.string().nullable().optional(),
  /**
   * NodeError.code machine-readable (es. 'HTTP_ERROR', 'AUTH_ERROR', 'TIMEOUT')
   * quando l'errore è un NodeError tipizzato. La UI lo mappa su categoria +
   * azione suggerita (categoryOf/actionHintFor). Assente per errori legacy.
   */
  errorCode: z.string().optional(),
  /**
   * Categoria semantica dell'errore (NodeErrorCategory), calcolata dall'engine
   * con l'istanza NodeError completa (include `retryable` → HTTP 5xx=network,
   * 4xx=business). Propagata per il continue-on-fail per-categoria e per la UI.
   */
  errorCategory: z.enum(['validation', 'auth', 'network', 'rate_limit', 'business', 'aborted', 'internal']).optional(),
  /**
   * True quando status='error' MA il nodo aveva `continueOnFail` → il run NON
   * si è fermato: l'errore è diventato un error-item e il flusso è proseguito.
   * Distingue il "soft fail" (giallo, gestito) dal "fatal" (rosso) per il
   * RunInspector e per il contatore della Dashboard Live.
   */
  continued: z.boolean().optional(),
  /**
   * Versioned Node API: drift rilevato dall'engine tra la versione del def
   * PINNATA sull'istanza (`CanvasNode.defVersion`) e quella corrente. Presente
   * SOLO quando c'è un drift rilevante ('major'/'minor'/'patch'/'ahead'); assente
   * = allineato o legacy. Backward-compat: è pura osservabilità, non blocca il run.
   */
  versionDrift: z.enum(['major', 'minor', 'patch', 'ahead']).optional(),
  paused: z.boolean().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  nodeConfig: z.record(z.string(), z.string()).optional(),
  retry: z.number().int().nonnegative().optional(),
  loopIteration: z.number().int().nonnegative().optional(),
  /** Loop body iteration metadata (set by IterationCoordinator). */
  iterationIndex: z.number().int().nonnegative().optional(),
  iterationTotal: z.number().int().positive().optional(),
  /** ID of the logic_loop node that owns this step (when run inside a body). */
  loopId: z.string().optional(),
  /** When status='skipped', the human-readable reason (e.g. aggregate strategy). */
  skippedReason: z.string().optional(),
  spanId: z.string().optional(),
  traceId: z.string().optional(),
  /**
   * Cappella Sistina+ logging (#226): array di StepLog catturati durante
   * l'esecuzione del nodo (console.log da sandbox + engine events + network
   * trace + LLM/db). Cap 256 entries / 64KB JSON, deterministicamente
   * truncato dal LogCollector (vedi services/runs/log-collector). Assente
   * per step legacy / no-emit.
   *
   * UI: RunInspector tab "Logs" virtual-scroll + filtri level/source/regex.
   * SSE live: /runs/{id}/logs canale dedicato push entry-by-entry.
   */
  logs: z.array(StepLogSchema).optional(),
  /** Contatore logs runtime (pre-truncation) — visibile nella Dashboard Live
   *  come badge "N log" sul nodo. Permette di sapere "ci sono altri log oltre
   *  ai 256 mostrati" senza scrollare. */
  logsTotal: z.number().int().nonnegative().optional(),
  /** True se LogCollector ha truncato per cap. Markato in UI come ⚠ truncated. */
  logsTruncated: z.boolean().optional(),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunSummarySchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string().uuid(),
  ts: z.string().datetime(),
  input: z.string(),
  stepsCount: z.number().int().nonnegative(),
  hasError: z.boolean(),
  errorNode: z.string().optional(),
  env: z.string().optional(),
  triggeredBy: z.string().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunSnapshotSchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string().uuid(),
  ts: z.string().datetime(),
  input: z.string(),
  triggerPayload: z.unknown().optional(),
  triggerType: z.string().optional(),
  steps: z.array(RunStepSchema),
  paused: z
    .object({
      atNodeId: z.string().min(1),
      pendingNodes: z.array(z.string()),
    })
    .nullable()
    .optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  errorCount: z.number().int().nonnegative().optional(),
  env: z.string().optional(),
  triggeredBy: z.string().optional(),
  tenantId: z.string().uuid().optional(),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
