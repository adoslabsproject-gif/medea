/**
 * CircuitBreakerRegistry — singleton process-wide per discovery + admin.
 *
 * Pattern: ogni `CircuitBreaker` (auto-register=true by default) si annuncia
 * qui al costruttore. Admin / observability endpoint usano il registry per:
 *   • Listare tutti i breaker attivi (`list()`)
 *   • Report aggregato (`getHealthReport()`)
 *   • Force reset di tutti (`resetAll()`) per maintenance window
 *   • Cleanup timer al shutdown (`destroyAll()`) — PM2 / docker SIGTERM
 *
 * Idempotency: `register(name, breaker)` SOSTITUISCE silenziosamente l'istanza
 * precedente con stesso nome (utile per hot-reload dev). In prod, due breaker
 * con stesso nome e\` un bug del caller — la sostituzione e\` "fail-safe" non
 * "fail-loud" perche\` il throw bloccava ogni request fino al restart.
 */

import type { CircuitBreaker, CircuitBreakerStats, CircuitState } from './circuit-breaker.js';

export class CircuitBreakerRegistry {
  private static _instance: CircuitBreakerRegistry | null = null;
  private readonly _breakers = new Map<string, CircuitBreaker<unknown>>();

  private constructor() {
    /* singleton: istanziare solo via getInstance() */
  }

  static getInstance(): CircuitBreakerRegistry {
    CircuitBreakerRegistry._instance ??= new CircuitBreakerRegistry();
    return CircuitBreakerRegistry._instance;
  }

  register(name: string, breaker: CircuitBreaker<unknown>): void {
    // Idempotente: sostituzione silenziosa. Caso d'uso: hot-reload modulo +
    // re-istanziazione del breaker con stesso nome. Il vecchio viene
    // dismesso (destroy) per non leakare timer.
    const previous = this._breakers.get(name);
    if (previous && previous !== breaker) {
      try {
        previous.destroy();
      } catch {
        /* defensive — non bloccare register */
      }
    }
    this._breakers.set(name, breaker);
  }

  get(name: string): CircuitBreaker<unknown> | null {
    return this._breakers.get(name) ?? null;
  }

  has(name: string): boolean {
    return this._breakers.has(name);
  }

  list(): { name: string; state: CircuitState; stats: CircuitBreakerStats }[] {
    return [...this._breakers.values()]
      .map((b) => ({ name: b.name, state: b.getStats().state, stats: b.getStats() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getHealthReport(): Record<string, { state: CircuitState; stats: CircuitBreakerStats }> {
    const report: Record<string, { state: CircuitState; stats: CircuitBreakerStats }> = {};
    for (const [name, breaker] of this._breakers.entries()) {
      const stats = breaker.getStats();
      report[name] = {
        state: stats.state,
        stats: {
          ...stats,
          lastFailure: stats.lastFailure ? new Date(stats.lastFailure) : null,
          lastSuccess: stats.lastSuccess ? new Date(stats.lastSuccess) : null,
          lastStateChange: new Date(stats.lastStateChange),
        },
      };
    }
    return report;
  }

  /** Force-reset di tutti — admin override per maintenance window. */
  resetAll(): number {
    let n = 0;
    for (const breaker of this._breakers.values()) {
      breaker.reset();
      n += 1;
    }
    return n;
  }

  /** Cleanup timer di tutti — chiamare al SIGTERM / process exit. */
  destroyAll(): void {
    for (const breaker of this._breakers.values()) {
      try {
        breaker.destroy();
      } catch {
        /* swallow — best effort */
      }
    }
    this._breakers.clear();
  }

  /** Test-only: rimuove istanza singleton + cleanup. */
  static resetInstance(): void {
    if (CircuitBreakerRegistry._instance) {
      CircuitBreakerRegistry._instance.destroyAll();
      CircuitBreakerRegistry._instance = null;
    }
  }
}
