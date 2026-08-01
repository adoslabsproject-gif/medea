/**
 * trigger-watchers/breaker — risoluzione condivisa del circuit breaker
 * per-host dei poller (split 2026-06-12). Pattern unico: interroga il registry
 * condiviso, fallback a una nuova istanza con la policy standard dei watcher
 * (5 failure in 30s → cooldown 60s).
 */

import { CircuitBreaker, CircuitBreakerRegistry } from '@zeliai/shared';

/** Superficie minima del circuit breaker usata dai poller — fake-abile nei test. */
export interface TriggerBreaker {
  execute(fn: () => Promise<void>): Promise<void>;
}

export function resolveTriggerBreaker(name: string): TriggerBreaker {
  const existing = CircuitBreakerRegistry.getInstance().get(name);
  return existing ?? new CircuitBreaker<void>(name, {
    failureThreshold: 5,
    windowMs: 30_000,
    cooldownMs: 60_000,
  });
}
