/**
 * CircuitBreakerIdempotencyStore — decorator che wrappa un IdempotencyStore
 * con un CircuitBreaker per fail-fast su outage prolungate del backend.
 *
 * Problema (audit 2026-06-04): durante outage Redis prolungata, ogni write
 * node aspetta i 5s di `commandTimeout` PRIMA di triggerare fail-open nel
 * middleware. Workflow con 10 nodi write = ~50s cumulativi di attesa.
 *
 * Soluzione: dopo N (5 default) acquire falliti consecutivi, il breaker
 * apre → ogni acquire successivo fail-fast IMMEDIATO (1ms invece di 5s)
 * per `resetTimeout` (30s default). Probe singolo half-open per recovery
 * automatica quando Redis torna up — zero intervento manuale.
 *
 * Risultato: outage 30s con 10 write nodes → ~6s totali (1 probe per node
 * primi 5, poi breaker open + fail-fast) vs ~50s pre-fix.
 *
 * Pattern: standard resilience engineering (Resilience4j, Hystrix legacy,
 * Polly .NET). Riusa il CircuitBreaker enterprise di @zeliai/shared
 * (commit fc7d72e — sliding window + HALF_OPEN atomic probe + jitter).
 */

import { CircuitBreaker, CircuitOpenError } from '@zeliai/shared';
import type { IdempotencyStore, AcquireResult } from '@flowforge/nodes-stdlib';

export interface CircuitBreakerStoreOptions {
  /** N° acquire/complete falliti consecutivi prima di OPEN. Default 5. */
  failureThreshold?: number;
  /** Ms da OPEN a HALF_OPEN (probe). Default 30s. */
  resetTimeout?: number;
  /** N° successi consecutivi in HALF_OPEN per chiudere. Default 2. */
  successThreshold?: number;
  /** Nome breaker per observability (registry singleton). Default 'idempotency-store'. */
  breakerName?: string;
}

const FAST_FAIL_RESULT: AcquireResult = { acquired: true };

export class CircuitBreakerIdempotencyStore implements IdempotencyStore {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: IdempotencyStore,
    opts: CircuitBreakerStoreOptions = {},
  ) {
    this.breaker = new CircuitBreaker(opts.breakerName ?? 'idempotency-store', {
      failureThreshold: opts.failureThreshold ?? 5,
      resetTimeout: opts.resetTimeout ?? 30_000,
      successThreshold: opts.successThreshold ?? 2,
      probeTimeout: 5_000,
    });
  }

  async acquire(key: string, ttlMs: number): Promise<AcquireResult> {
    try {
      return await this.breaker.execute(() => this.inner.acquire(key, ttlMs));
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Breaker OPEN: fail-fast immediato. Ritorniamo `acquired: true`
        // (NO lock applicato) per attivare il fail-open path del middleware
        // withIdempotency senza farlo aspettare un throw → catch → log → next.
        // Semantica: middleware vede acquired=true → procede + complete();
        // poi `complete()` su breaker OPEN e\` no-op (gestito sotto).
        return FAST_FAIL_RESULT;
      }
      throw err;
    }
  }

  async complete(key: string, output: unknown): Promise<void> {
    try {
      await this.breaker.execute(() => this.inner.complete(key, output));
    } catch (err) {
      // OPEN o store-down: no-op silenzioso. Il run e\` gia\` completato,
      // perdere il "save output for replay" e\` accettabile durante outage.
      if (err instanceof CircuitOpenError) return;
      throw err;
    }
  }

  async release(key: string): Promise<void> {
    try {
      await this.breaker.execute(() => this.inner.release(key));
    } catch (err) {
      // OPEN o store-down: no-op. Il TTL del lock decadra\` naturalmente.
      if (err instanceof CircuitOpenError) return;
      throw err;
    }
  }

  async size(): Promise<number> {
    try {
      return await this.breaker.execute(() => this.inner.size());
    } catch (err) {
      if (err instanceof CircuitOpenError) return 0;
      throw err;
    }
  }

  /** Test helper — esposto per assert state machine in CI. */
  getBreakerState(): string {
    return this.breaker.getStats().state;
  }
}
