/**
 * Circuit Breaker — implementazione unificata enterprise 2026.
 *
 * Pattern Resilience4j-inspired con design TypeScript-first:
 *   • Failure detection: discriminated union {mode: 'consecutive' | 'sliding'}
 *     — alternativa a flag booleani sparsi (failureCount vs windowMs).
 *   • HALF_OPEN safety: probe atomic + jitter ±10% + timeout anti-hang
 *     (single probe permesso, altri fail-fast).
 *   • Async fallback opzionale con cause discriminante ('open' | 'half_open_busy').
 *   • Event-driven observability: EventEmitter native, sottoscrivibile da multi.
 *   • Prometheus-compatible metrics snapshot (counter + gauge + uptime).
 *   • Bulkhead opzionale: limita concorrenza per evitare resource exhaustion.
 *   • PM2-safe: `destroy()` cleanup timer, `_resetTimer.unref()` non blocca exit.
 *
 * State machine
 * ──────────────
 *   CLOSED        — tutte le request passano. Failures contate (consecutive o
 *                   sliding window). Threshold superato → OPEN.
 *   OPEN          — fail-fast. Tutte le request rejected con CircuitOpenError
 *                   o fallback. Dopo `resetTimeout` (jitter ±10%) → HALF_OPEN.
 *   HALF_OPEN     — UN solo probe permesso. Successo → CLOSED dopo
 *                   `successThreshold` consecutive successi. Fallimento → OPEN
 *                   con timer fresh. Probe hang oltre `probeTimeout` → OPEN forzato.
 *
 * Design choices
 * ──────────────
 *   • No external dep (no opossum, no cockatiel) — facile audit ~400 LOC.
 *   • Sliding window via timestamp ring (bounded MAX_FAILURE_RING=1024) per
 *     evitare unbounded memory under flooding.
 *   • Anti-thundering-herd: jitter sul reset timer, multipli PM2 worker non
 *     probano simultaneamente lo stesso downstream.
 *   • Bulkhead optional: semaphore concurrency cap — quando saturo, fail-fast
 *     con BulkheadFullError (no queue, no waiting).
 *   • EventEmitter: subscriber multipli per audit log + metrics aggregation
 *     + alert routing — disaccoppiati dal core logic.
 *
 * Esempio
 * ───────
 *   const breaker = new CircuitBreaker('liara', {
 *     failureDetection: { mode: 'sliding', windowMs: 60_000, threshold: 5 },
 *     resetTimeout: 30_000,
 *     successThreshold: 2,
 *     probeTimeout: 10_000,
 *     fallback: () => ({ status: 'degraded' }),
 *     bulkhead: { maxConcurrent: 50 },
 *   });
 *   breaker.on('stateChange', ({ from, to }) => audit.log('cb', from, to));
 *   const result = await breaker.execute(() => liara.chat({ ... }));
 */

import { CircuitBreakerRegistry } from './circuit-breaker-registry.js';

/**
 * Mini EventEmitter isomorfo (zero-dep, browser-safe).
 * Sostituisce `node:events` che NON e\` disponibile nel bundle browser (Vite).
 * Subset minimo dell'API EventEmitter: on / off / emit / removeAllListeners.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (data: any) => void;

class IsoEventEmitter {
  private _listeners: Record<string, AnyListener[]> = {};

  on(event: string, listener: AnyListener): this {
    (this._listeners[event] ??= []).push(listener);
    return this;
  }

  off(event: string, listener: AnyListener): this {
    const arr = this._listeners[event];
    if (!arr) return this;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    return this;
  }

  emit(event: string, data?: unknown): boolean {
    const arr = this._listeners[event];
    if (!arr || arr.length === 0) return false;
    // Copy per evitare mutation durante iteration (un listener puo\` off()).
    for (const l of arr.slice()) {
      try {
        l(data);
      } catch {
        /* swallow — un listener difettoso non blocca gli altri */
      }
    }
    return true;
  }

  removeAllListeners(): this {
    this._listeners = {};
    return this;
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Discriminated union per failure detection — type-safe alternative a flag bool.
 * 'consecutive': N failures consecutivi → OPEN (semplice, no memoria runtime).
 * 'sliding':     N failures dentro windowMs → OPEN (preferred per API esterne
 *                con error rate intermittente — il pattern industry-standard).
 */
export type FailureDetectionConfig =
  | { readonly mode: 'consecutive'; readonly threshold: number }
  | { readonly mode: 'sliding'; readonly threshold: number; readonly windowMs: number };

export type FallbackCause = 'open' | 'half_open_busy' | 'bulkhead_full';

export interface BulkheadConfig {
  /** Max concorrente in flight prima di fail-fast con BulkheadFullError. */
  readonly maxConcurrent: number;
}

export interface CircuitBreakerOptions<T = unknown> {
  /** Configura come contare i fallimenti. Default: consecutive 5. */
  readonly failureDetection?: FailureDetectionConfig;
  /**
   * Back-compat alias per `failureDetection: { mode: 'consecutive', threshold }`.
   * Quando entrambi presenti, `failureDetection` ha precedenza. Util per migrazione
   * graduale da API legacy `{ failureThreshold }`.
   */
  readonly failureThreshold?: number;
  /**
   * Back-compat alias: quando `windowMs` settato senza `failureDetection`, attiva
   * sliding mode usando `failureThreshold` come threshold. Replica behavior delle
   * vecchie callsite (runtime/lib/circuit-breaker `windowMs` + `failureThreshold`).
   */
  readonly windowMs?: number;
  /** Back-compat alias per `resetTimeout` (runtime/lib usava `cooldownMs`). */
  readonly cooldownMs?: number;
  /** Ms da OPEN → HALF_OPEN (jitter ±10% applicato). Default 30_000. */
  readonly resetTimeout?: number;
  /** N° successi consecutivi in HALF_OPEN per chiudere. Default 2. */
  readonly successThreshold?: number;
  /** Timeout ms per il probe in HALF_OPEN. Default 10_000. */
  readonly probeTimeout?: number;
  /** Fallback async opzionale quando OPEN/half_open_busy/bulkhead_full. */
  readonly fallback?: (cause: FallbackCause) => T | Promise<T>;
  /** Filter: quali errori contano come failure. Default `() => true`. */
  readonly isFailure?: (err: unknown) => boolean;
  /** Bulkhead concurrency cap. Default disabilitato (Infinity). */
  readonly bulkhead?: BulkheadConfig;
  /** Auto-register nella registry singleton. Default true. */
  readonly autoRegister?: boolean;
  /**
   * Back-compat callback API — alias per `breaker.on('stateChange', cb)`.
   * Per nuovi code path preferire EventEmitter (`breaker.on('stateChange', ...)`).
   */
  readonly onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void;
  /** Back-compat callback API — alias per `breaker.on('success', cb)`. */
  readonly onSuccess?: (durationMs: number) => void;
  /** Back-compat callback API — alias per `breaker.on('failure', cb)`. */
  readonly onFailure?: (err: unknown, durationMs: number) => void;
}

/** Snapshot metrics — Prometheus-compatible (counter + gauge). */
export interface CircuitBreakerStats {
  readonly name: string;
  readonly state: CircuitState;
  readonly failures: number; // gauge: failures in current window/sequence
  readonly successes: number; // gauge: consecutive successes in half-open
  readonly inFlight: number; // gauge: concurrent in flight (bulkhead)
  readonly totalRequests: number; // counter cumulative
  readonly totalSuccesses: number; // counter cumulative
  readonly totalFailures: number; // counter cumulative
  readonly totalRejected: number; // counter (short-circuit OPEN/HALF_BUSY/BULKHEAD)
  readonly totalTimedOutProbes: number; // counter (probe hang in half-open)
  readonly timesOpened: number; // counter: total OPEN transitions
  readonly lastFailure: Date | null;
  readonly lastSuccess: Date | null;
  readonly lastStateChange: Date;
  readonly uptimePercent: number; // 0..100, time spent in CLOSED state
  readonly recentFailureRate: number; // 0..1 — solo in sliding mode
}

export interface StateChangeEvent {
  readonly name: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly reason: string;
  readonly at: number;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly nextProbeAt?: number,
  ) {
    super(`Circuit breaker [${breakerName}] is OPEN — fail fast`);
    this.name = 'CircuitOpenError';
  }
}

export class BulkheadFullError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly maxConcurrent: number,
  ) {
    super(`Circuit breaker [${breakerName}] bulkhead saturated (${String(maxConcurrent)})`);
    this.name = 'BulkheadFullError';
  }
}

const DEFAULT_RESET_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_SUCCESS_THRESHOLD = 2;
const DEFAULT_FAILURE_THRESHOLD = 5;
const RESET_JITTER_RATIO = 0.1;
const MAX_FAILURE_RING_SIZE = 1024; // bound memoria sliding window

export class CircuitBreaker<T = unknown> extends IsoEventEmitter {
  readonly name: string;

  // ── State
  private _state: CircuitState = 'closed';
  private _consecutiveFailures = 0;
  private _consecutiveSuccesses = 0;
  private _slidingWindowFailures: number[] = []; // timestamp ring
  private _openedAt: number | null = null;
  private _probeInFlight = false;
  private _resetTimer: ReturnType<typeof setTimeout> | null = null;
  private _probeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Bulkhead
  private _inFlight = 0;

  // ── Counters (Prometheus-compatible)
  private _totalRequests = 0;
  private _totalSuccesses = 0;
  private _totalFailures = 0;
  private _totalRejected = 0;
  private _totalTimedOutProbes = 0;
  private _timesOpened = 0;
  private _lastFailureAt: Date | null = null;
  private _lastSuccessAt: Date | null = null;
  private _lastStateChangeAt = new Date();

  // ── Uptime tracking (time spent in each state)
  private _stateAccumulator: Record<CircuitState, number> = { closed: 0, open: 0, half_open: 0 };
  private _lastStateChangeTimestamp = Date.now();

  // ── Resolved configuration (frozen post-construction)
  private readonly _failureDetection: FailureDetectionConfig;
  private readonly _resetTimeout: number;
  private readonly _successThreshold: number;
  private readonly _probeTimeout: number;
  private readonly _isFailure: (err: unknown) => boolean;
  private readonly _fallback?: (cause: FallbackCause) => T | Promise<T>;
  private readonly _bulkheadMax: number;

  constructor(name: string, options: CircuitBreakerOptions<T> = {}) {
    super();
    if (!name || typeof name !== 'string') {
      throw new TypeError('CircuitBreaker: `name` deve essere stringa non vuota');
    }

    this.name = name;
    // Resolve failureDetection con back-compat alias.
    if (options.failureDetection) {
      this._failureDetection = options.failureDetection;
    } else if (options.windowMs !== undefined) {
      this._failureDetection = {
        mode: 'sliding',
        threshold: options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
        windowMs: options.windowMs,
      };
    } else {
      this._failureDetection = {
        mode: 'consecutive',
        threshold: options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      };
    }
    this._resetTimeout = options.resetTimeout ?? options.cooldownMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this._successThreshold = options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this._probeTimeout = options.probeTimeout ?? DEFAULT_PROBE_TIMEOUT_MS;
    this._isFailure = options.isFailure ?? (() => true);
    if (options.fallback) this._fallback = options.fallback;
    this._bulkheadMax = options.bulkhead?.maxConcurrent ?? Infinity;

    this._validateConfig();

    // Back-compat callback → EventEmitter subscribe.
    if (options.onStateChange) {
      this.on('stateChange', (e: StateChangeEvent) => options.onStateChange!(e.from, e.to, e.name));
    }
    if (options.onSuccess) {
      this.on('success', (e: { durationMs: number }) => options.onSuccess!(e.durationMs));
    }
    if (options.onFailure) {
      this.on('failure', (e: { error: unknown; durationMs: number }) =>
        options.onFailure!(e.error, e.durationMs),
      );
    }

    // Auto-register di default — disattivabile per test deterministici.
    // Static import safe: registry usa SOLO `import type` di CircuitBreaker,
    // nessun cycle a runtime. Il pattern dynamic-import precedente causava
    // TS1323 con il default `module` setting del Docker builder + race
    // condition (register avveniva async dopo che il caller pensava fosse
    // gia\` registrato).
    if (options.autoRegister !== false) {
      CircuitBreakerRegistry.getInstance().register(name, this);
    }
  }

  private _validateConfig(): void {
    if (this._failureDetection.threshold < 1) {
      throw new RangeError('failureDetection.threshold deve essere >= 1');
    }
    if (this._failureDetection.mode === 'sliding' && this._failureDetection.windowMs < 10) {
      throw new RangeError('failureDetection.windowMs deve essere >= 10ms');
    }
    if (this._resetTimeout < 10) throw new RangeError('resetTimeout deve essere >= 10ms');
    if (this._successThreshold < 1) throw new RangeError('successThreshold deve essere >= 1');
    if (this._probeTimeout < 10) throw new RangeError('probeTimeout deve essere >= 10ms');
    if (this._bulkheadMax !== Infinity && this._bulkheadMax < 1) {
      throw new RangeError('bulkhead.maxConcurrent deve essere >= 1');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────

  getState(): CircuitState {
    this._maybeTransitionOpenToHalfOpen();
    return this._state;
  }

  getStats(): CircuitBreakerStats {
    this._pruneSlidingWindow();
    this._maybeTransitionOpenToHalfOpen();
    const now = Date.now();
    const currentDuration = now - this._lastStateChangeTimestamp;
    const closedTotal =
      this._stateAccumulator.closed + (this._state === 'closed' ? currentDuration : 0);
    const allTotal =
      closedTotal +
      this._stateAccumulator.open +
      (this._state === 'open' ? currentDuration : 0) +
      this._stateAccumulator.half_open +
      (this._state === 'half_open' ? currentDuration : 0);

    return {
      name: this.name,
      state: this._state,
      failures: this._currentFailureCount(),
      successes: this._consecutiveSuccesses,
      inFlight: this._inFlight,
      totalRequests: this._totalRequests,
      totalSuccesses: this._totalSuccesses,
      totalFailures: this._totalFailures,
      totalRejected: this._totalRejected,
      totalTimedOutProbes: this._totalTimedOutProbes,
      timesOpened: this._timesOpened,
      lastFailure: this._lastFailureAt,
      lastSuccess: this._lastSuccessAt,
      lastStateChange: this._lastStateChangeAt,
      uptimePercent: allTotal > 0 ? Math.round((closedTotal / allTotal) * 10_000) / 100 : 100,
      recentFailureRate: this._recentFailureRate(),
    };
  }

  /** Execute fn through the breaker — type-safe generic per ogni call. */
  async execute<R>(fn: () => Promise<R>): Promise<R> {
    this._totalRequests += 1;
    this._maybeTransitionOpenToHalfOpen();

    if (this._state === 'open') {
      this._totalRejected += 1;
      if (this._fallback) return this._fallback('open') as Promise<R>;
      throw new CircuitOpenError(this.name, (this._openedAt ?? Date.now()) + this._resetTimeout);
    }

    if (this._state === 'half_open') {
      if (this._probeInFlight) {
        this._totalRejected += 1;
        if (this._fallback) return this._fallback('half_open_busy') as Promise<R>;
        throw new CircuitOpenError(this.name);
      }
      this._probeInFlight = true;
    }

    if (this._inFlight >= this._bulkheadMax) {
      this._totalRejected += 1;
      if (this._state === 'half_open') this._probeInFlight = false;
      if (this._fallback) return this._fallback('bulkhead_full') as Promise<R>;
      throw new BulkheadFullError(this.name, this._bulkheadMax);
    }

    this._inFlight += 1;
    const probeTimerHandle = this._state === 'half_open' ? this._armProbeTimer() : null;
    const startedAt = Date.now();

    try {
      const value = await fn();
      if (probeTimerHandle && !probeTimerHandle.firedRef.fired) this._clearProbeTimer();
      if (this._state === 'half_open' && probeTimerHandle?.firedRef.fired) return value;
      this._onSuccess(Date.now() - startedAt);
      return value;
    } catch (err) {
      if (probeTimerHandle && !probeTimerHandle.firedRef.fired) this._clearProbeTimer();
      if (this._state === 'half_open' && probeTimerHandle?.firedRef.fired) throw err;
      if (this._isFailure(err)) this._onFailure(err, Date.now() - startedAt);
      throw err;
    } finally {
      this._inFlight -= 1;
      if (this._state === 'half_open') this._probeInFlight = false;
    }
  }

  /**
   * Admin: inietta N failures sintetiche per testare la state machine in prod.
   * Il messaggio opzionale finisce in lastFailureMessage + event 'failure'
   * (utile per audit log di chi ha lanciato il test).
   */
  simulateFailures(count: number, syntheticMessage = 'synthetic test failure'): void {
    for (let i = 0; i < count; i += 1) {
      this._onFailure(new Error(syntheticMessage), 0);
    }
  }

  /** Back-compat alias: `getStats()` esposto come `getMetrics()` per le route admin legacy. */
  getMetrics(): CircuitBreakerStats {
    return this.getStats();
  }

  /** Admin: forza lo state. Audit emesso via event. */
  forceState(target: CircuitState, reason = 'manual'): void {
    this._transitionTo(target, `manual: ${reason}`);
    if (target === 'closed') {
      this._consecutiveFailures = 0;
      this._slidingWindowFailures = [];
      this._openedAt = null;
      this._probeInFlight = false;
    } else if (target === 'open') {
      this._openedAt = Date.now();
    }
  }

  reset(): void {
    this.forceState('closed', 'reset');
  }

  /** Cleanup timer — chiamare al shutdown PM2 per evitare timer zombie. */
  destroy(): void {
    this._clearResetTimer();
    this._clearProbeTimer();
    this._probeInFlight = false;
    this.removeAllListeners();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────

  private _currentFailureCount(): number {
    if (this._failureDetection.mode === 'consecutive') return this._consecutiveFailures;
    return this._slidingWindowFailures.length;
  }

  private _recentFailureRate(): number {
    if (this._failureDetection.mode !== 'sliding') return 0;
    if (this._totalRequests === 0) return 0;
    const window = this._slidingWindowFailures.length;
    return Math.min(1, window / Math.max(window, this._totalRequests));
  }

  private _onSuccess(_durationMs: number): void {
    this._totalSuccesses += 1;
    this._lastSuccessAt = new Date();
    this._consecutiveFailures = 0;
    this.emit('success', { name: this.name, durationMs: _durationMs });

    if (this._state === 'half_open') {
      this._consecutiveSuccesses += 1;
      if (this._consecutiveSuccesses >= this._successThreshold) {
        this._transitionTo(
          'closed',
          `half-open ${String(this._consecutiveSuccesses)} probe successi`,
        );
      }
    }
  }

  private _onFailure(err: unknown, durationMs: number): void {
    this._totalFailures += 1;
    this._lastFailureAt = new Date();
    this.emit('failure', { name: this.name, error: err, durationMs });

    if (this._failureDetection.mode === 'consecutive') {
      this._consecutiveFailures += 1;
    } else {
      const now = Date.now();
      this._slidingWindowFailures.push(now);
      if (this._slidingWindowFailures.length > MAX_FAILURE_RING_SIZE) {
        this._slidingWindowFailures = this._slidingWindowFailures.slice(-MAX_FAILURE_RING_SIZE);
      }
      this._pruneSlidingWindow();
    }

    if (this._state === 'half_open') {
      // Single failure in HALF_OPEN → restart OPEN cycle
      this._openedAt = Date.now();
      this._timesOpened += 1;
      this._transitionTo('open', `probe half-open fallita: ${this._brief(err)}`);
      return;
    }

    if (
      this._state === 'closed' &&
      this._currentFailureCount() >= this._failureDetection.threshold
    ) {
      this._openedAt = Date.now();
      this._timesOpened += 1;
      this._transitionTo(
        'open',
        `${String(this._currentFailureCount())} fallimenti ${
          this._failureDetection.mode === 'sliding'
            ? `in ${String(this._failureDetection.windowMs)}ms`
            : 'consecutivi'
        } — ultimo: ${this._brief(err)}`,
      );
    }
  }

  private _pruneSlidingWindow(): void {
    if (this._failureDetection.mode !== 'sliding') return;
    const cutoff = Date.now() - this._failureDetection.windowMs;
    while (this._slidingWindowFailures.length > 0 && this._slidingWindowFailures[0]! < cutoff) {
      this._slidingWindowFailures.shift();
    }
  }

  private _maybeTransitionOpenToHalfOpen(): void {
    if (this._state !== 'open' || this._openedAt === null) return;
    if (Date.now() - this._openedAt >= this._resetTimeout) {
      this._transitionTo('half_open', `cooldown ${String(this._resetTimeout)}ms scaduto`);
      this._probeInFlight = false;
    }
  }

  private _transitionTo(to: CircuitState, reason: string): void {
    if (to === this._state) return;
    const from = this._state;
    const now = Date.now();
    this._stateAccumulator[from] += now - this._lastStateChangeTimestamp;
    this._lastStateChangeTimestamp = now;
    this._state = to;
    this._lastStateChangeAt = new Date(now);

    if (to === 'closed') {
      this._consecutiveFailures = 0;
      this._consecutiveSuccesses = 0;
      this._slidingWindowFailures = [];
      this._probeInFlight = false;
      this._openedAt = null;
      this._clearResetTimer();
      this._clearProbeTimer();
    } else if (to === 'open') {
      this._consecutiveSuccesses = 0;
      this._probeInFlight = false;
      this._clearProbeTimer();
      this._scheduleResetTimer();
    } else {
      // half_open
      this._consecutiveSuccesses = 0;
      this._probeInFlight = false;
    }

    const event: StateChangeEvent = { name: this.name, from, to, reason, at: now };
    this.emit('stateChange', event);
  }

  private _scheduleResetTimer(): void {
    this._clearResetTimer();
    const base = this._resetTimeout;
    const jitterRange = base * RESET_JITTER_RATIO;
    const jittered = base + (Math.random() * 2 * jitterRange - jitterRange);
    const delay = Math.max(10, Math.round(jittered));
    this._resetTimer = setTimeout(
      () => this._transitionTo('half_open', 'reset timer (jitter)'),
      delay,
    );
    this._resetTimer.unref?.();
  }

  private _clearResetTimer(): void {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
  }

  /**
   * Arma il probe timer per HALF_OPEN. Ritorna `firedRef` object cosi\` il
   * caller (`execute`) sa se il timer e\` scattato (probe hang) o no.
   */
  private _armProbeTimer(): { firedRef: { fired: boolean } } {
    const firedRef = { fired: false };
    this._clearProbeTimer();
    this._probeTimeoutTimer = setTimeout(() => {
      firedRef.fired = true;
      this._totalTimedOutProbes += 1;
      this._probeInFlight = false;
      this._openedAt = Date.now();
      this._timesOpened += 1;
      this._transitionTo('open', `probe timeout ${String(this._probeTimeout)}ms scaduto`);
    }, this._probeTimeout);
    this._probeTimeoutTimer.unref?.();
    return { firedRef };
  }

  private _clearProbeTimer(): void {
    if (this._probeTimeoutTimer) {
      clearTimeout(this._probeTimeoutTimer);
      this._probeTimeoutTimer = null;
    }
  }

  private _brief(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
  }
}
