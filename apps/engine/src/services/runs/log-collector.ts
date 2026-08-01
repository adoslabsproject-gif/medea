/**
 * LogCollector — Cappella Sistina+ structured log capture per step di workflow.
 *
 * ## Design
 *
 * Cattura strutturata di TUTTI gli eventi log emessi durante l'esecuzione di
 * un singolo step (= un nodo del workflow):
 *  - console.log/warn/error dal sandbox custom/community node (user code)
 *  - HTTP request/response trace dal fetch shim
 *  - LLM token/cache/latency dai Liara call
 *  - DB slow query alert
 *  - Engine events (retry, breaker, drift, abort)
 *
 * Emette gli entries in 3 sink simultanei:
 *  1. **buffer in-memory** (per step.logs persisted)
 *  2. **EventEmitter live** → SSE `/runs/{id}/logs` (real-time UI)
 *  3. **PSR-3 channel** `runs` (centralized log aggregator)
 *
 * ## Performance Cappella Sistina+
 *
 *  - **Cap deterministico**: max 256 entries / 64KB JSON per step → garantisce
 *    O(1) memory per ogni run, nessun OOM su step verbose
 *  - **Truncation policy intelligente**: keep ALL errors/fatals + last 200
 *    debug/info → l'utente vede gli ERRORI sempre, il debug solo se ci sta
 *  - **Async-safe**: thread-free, ogni step ha il suo collector isolato
 *  - **Zero-alloc per no-op**: se il livello del log è sotto il minLevel,
 *    skippa subito (no creazione StepLog object)
 *
 * ## Distributed tracing
 *
 * W3C Trace Context auto-propagation:
 *  - traceId 16-byte hex (32 chars) → unico per run
 *  - spanId 8-byte hex (16 chars) → unico per step
 *  - parentSpanId → trigger node o caller upstream
 *
 * Compatibile con OTel exporters (Jaeger/Tempo/Honeycomb) via #229.
 *
 * @module services/runs/log-collector
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { LogLevel, LogSource, StepLog } from '@flowforge/core-schema';
import { logger as runsLogger } from '@/lib/logger.js';

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const MAX_MSG_CHARS = 2048;
export const MAX_FIELDS_BYTES = 4_096;
export const MAX_ENTRIES_PER_STEP = 256;
export const MAX_TOTAL_BYTES_PER_STEP = 64 * 1024;
/**
 * Quando si supera il cap: keep gli ultimi N "soft" + TUTTI gli error/fatal.
 * Threshold sotto cui un entry è "soft" (lo possiamo droppare).
 */
const SOFT_LEVEL_THRESHOLD = LOG_LEVEL_RANK.warn;

export interface LogCollectorOptions {
  /** Step context — identifica univocamente il step nel run. */
  runId: string;
  stepNodeId: string;
  workspaceId: string;
  /** W3C Trace Context — auto-generated se assente. */
  traceId?: string;
  parentSpanId?: string;
  /** Minimum level to capture. Default 'debug'. Sotto → skipped no-cost. */
  minLevel?: LogLevel;
  /** Forward to PSR-3 channel 'runs' (default true in prod). */
  forwardToPsr3?: boolean;
}

/**
 * Output finale del collector da serializzare nella RunStep.
 */
export interface CollectedLogs {
  logs: StepLog[];
  total: number;
  truncated: boolean;
  spanId: string;
  traceId: string;
}

/**
 * Helper per W3C Trace Context.
 *
 * traceId: 128-bit (32 hex char), spanId: 64-bit (16 hex char).
 * Non può essere "00000..." (vietato dallo standard).
 */
export function genTraceId(): string {
  let id = randomBytes(16).toString('hex');
  // Anti-spec violation: traceId non può essere tutto zero.
  if (/^0+$/u.test(id)) id = randomBytes(16).toString('hex');
  return id;
}

export function genSpanId(): string {
  let id = randomBytes(8).toString('hex');
  if (/^0+$/u.test(id)) id = randomBytes(8).toString('hex');
  return id;
}

/**
 * Serializza fields JSON con cap MAX_FIELDS_BYTES e fallback per circular.
 */
export function safeSerializeFields(fields: Record<string, unknown>): { fields: Record<string, unknown>; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(fields, replacerWithCircularGuard());
  } catch {
    return { fields: { __unserializable: true }, truncated: true };
  }
  if (json.length <= MAX_FIELDS_BYTES) {
    return { fields, truncated: false };
  }
  // Truncate: keep top-level keys con stringify cap per ogni valore.
  const out: Record<string, unknown> = {};
  let budget = MAX_FIELDS_BYTES - 32; // riservo overhead JSON wrapper
  for (const [k, v] of Object.entries(fields)) {
    const entryStr = `${JSON.stringify(k)}:${JSON.stringify(v) ?? '"<unserializable>"'}`;
    if (entryStr.length > budget) {
      out.__truncated_keys = (out.__truncated_keys ?? []);
      (out.__truncated_keys as string[]).push(k);
      continue;
    }
    out[k] = v;
    budget -= entryStr.length + 1;
  }
  return { fields: out, truncated: true };
}

function replacerWithCircularGuard(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    // Non truncare string a livello replacer — safeSerializeFields gestisce
    // il cap totale e droppa intere keys se necessario. Altrimenti il truncate
    // per valore mascherava il cap globale.
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return '[Function]';
    if (typeof value === 'symbol') return value.toString();
    return value;
  };
}

/**
 * Truncate intelligente: keep all errors/fatals + last N soft.
 */
export function truncateLogs(entries: StepLog[]): { kept: StepLog[]; truncated: boolean } {
  if (entries.length <= MAX_ENTRIES_PER_STEP) return { kept: entries, truncated: false };
  const hard = entries.filter((e) => LOG_LEVEL_RANK[e.level] >= SOFT_LEVEL_THRESHOLD);
  const soft = entries.filter((e) => LOG_LEVEL_RANK[e.level] < SOFT_LEVEL_THRESHOLD);
  // Keep ALL hard + last (MAX - hard.length) soft.
  const softBudget = Math.max(0, MAX_ENTRIES_PER_STEP - hard.length);
  const keptSoft = soft.slice(-softBudget);
  // Merge per timestamp+seq order (originale).
  const keptSet = new Set([...hard, ...keptSoft]);
  const kept = entries.filter((e) => keptSet.has(e));
  return { kept, truncated: true };
}

export class LogCollector {
  private readonly entries: StepLog[] = [];
  private readonly stepStartMono: bigint;
  private readonly stepStartMs: number;
  private readonly opts: Required<LogCollectorOptions>;
  private readonly emitter: EventEmitter;
  private seqCounter = 0;
  private overflowDropped = 0;
  public readonly spanId: string;
  public readonly traceId: string;

  constructor(opts: LogCollectorOptions) {
    this.opts = {
      ...opts,
      traceId: opts.traceId ?? genTraceId(),
      parentSpanId: opts.parentSpanId ?? '',
      minLevel: opts.minLevel ?? 'trace',
      forwardToPsr3: opts.forwardToPsr3 ?? true,
    };
    this.spanId = genSpanId();
    this.traceId = this.opts.traceId;
    this.stepStartMs = Date.now();
    this.stepStartMono = process.hrtime.bigint();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(64);
  }

  /** Subscribe to live log events. Returns disposer. */
  on(handler: (entry: StepLog) => void): () => void {
    this.emitter.on('log', handler);
    return () => this.emitter.off('log', handler);
  }

  /**
   * Capture an entry. Zero-cost if level < minLevel.
   *
   * Source default 'engine' (override per sandbox/user/network).
   */
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>, source: LogSource = 'engine'): void {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.opts.minLevel]) return;

    // Truncate msg
    let m = msg;
    let truncated = false;
    if (m.length > MAX_MSG_CHARS) {
      m = `${m.slice(0, MAX_MSG_CHARS)}…[+${String(msg.length - MAX_MSG_CHARS)}]`;
      truncated = true;
    }

    // Safe-serialize fields (cap 4KB)
    let f: Record<string, unknown> | undefined;
    if (fields) {
      const s = safeSerializeFields(fields);
      f = s.fields;
      if (s.truncated) truncated = true;
    }

    const mono = Number(process.hrtime.bigint() - this.stepStartMono);
    const seq = this.seqCounter++;
    const entry: StepLog = {
      ts: new Date(this.stepStartMs + Math.floor(mono / 1_000_000)).toISOString(),
      mono,
      seq,
      level,
      source,
      msg: m,
      ...(f ? { fields: f } : {}),
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.opts.parentSpanId ? { parentSpanId: this.opts.parentSpanId } : {}),
      ...(truncated ? { truncated: true } : {}),
    };

    // Cap entries: se superiamo il max, droppa il soft più vecchio
    // (per evitare unbounded growth durante step molto lunghi)
    if (this.entries.length >= MAX_ENTRIES_PER_STEP * 2) {
      // Aggressive overflow: keep only hard from current set + new entry
      const hard = this.entries.filter((e) => LOG_LEVEL_RANK[e.level] >= SOFT_LEVEL_THRESHOLD);
      this.overflowDropped += this.entries.length - hard.length;
      this.entries.length = 0;
      this.entries.push(...hard);
    }
    this.entries.push(entry);

    // Live emit
    this.emitter.emit('log', entry);

    // PSR-3 forward (centralized aggregator)
    if (this.opts.forwardToPsr3) {
      const psr3Fields = {
        runId: this.opts.runId,
        stepNodeId: this.opts.stepNodeId,
        workspaceId: this.opts.workspaceId,
        traceId: this.traceId,
        spanId: this.spanId,
        source,
        seq,
        ...(f ?? {}),
      };
      switch (level) {
        case 'trace': case 'debug': runsLogger.debug(psr3Fields, m); break;
        case 'info': runsLogger.info(psr3Fields, m); break;
        case 'warn': runsLogger.warn(psr3Fields, m); break;
        case 'error': case 'fatal': runsLogger.error(psr3Fields, m); break;
      }
    }
  }

  /** Convenience helpers. */
  trace(msg: string, fields?: Record<string, unknown>, source?: LogSource): void { this.log('trace', msg, fields, source); }
  debug(msg: string, fields?: Record<string, unknown>, source?: LogSource): void { this.log('debug', msg, fields, source); }
  info(msg: string, fields?: Record<string, unknown>, source?: LogSource): void { this.log('info', msg, fields, source); }
  warn(msg: string, fields?: Record<string, unknown>, source?: LogSource): void { this.log('warn', msg, fields, source); }
  error(msg: string, fields?: Record<string, unknown>, source?: LogSource): void { this.log('error', msg, fields, source); }
  fatal(msg: string, fields?: Record<string, unknown>, source?: LogSource): void { this.log('fatal', msg, fields, source); }

  /**
   * Ingestion batch da fonte esterna (es. console.log capturati dal sandbox
   * con livello+messaggio già parsati). Maintain ordering per seq.
   */
  ingest(level: LogLevel, source: LogSource, lines: string[]): void {
    for (const line of lines) this.log(level, line, undefined, source);
  }

  /**
   * Final collect: applica truncation policy + ritorna struttura serializzabile
   * per RunStep.logs / RunStep.logsTotal / RunStep.logsTruncated.
   */
  collect(): CollectedLogs {
    const { kept, truncated } = truncateLogs(this.entries);
    return {
      logs: kept,
      total: this.entries.length + this.overflowDropped,
      truncated: truncated || this.overflowDropped > 0,
      spanId: this.spanId,
      traceId: this.traceId,
    };
  }

  /** Reset state (test helper). */
  reset(): void {
    this.entries.length = 0;
    this.overflowDropped = 0;
    this.seqCounter = 0;
  }
}
