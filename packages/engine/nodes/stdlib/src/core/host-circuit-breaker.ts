/**
 * Per-host circuit breaker wrapper — bucket per host esterno.
 *
 * Pattern: ogni host esterno (api.stripe.com, api.openai.com, supplier-X) ha
 * il proprio CircuitBreaker. Se l'host va giu\`, fail-fast SOLO per le chiamate
 * a quell'host — gli altri vendor restano operativi. Senza per-host bucketing,
 * un Single Vendor Down causerebbe trip globale + collateral damage.
 *
 * Implementation: wrappa `CircuitBreaker` di `@zeliai/shared` (canonical, gia\`
 * usato in 4 apps). Singleton in-memory registry per host. La policy default
 * (5 failures → open per 30s, 2 success in half-open → close) e\` conservativa
 * per scenari API esterne; override via opts per host che necessitano tuning.
 *
 * NOTE: in apps/flowforge-runtime/src/lib/circuit-breaker.ts c'e\` una seconda
 * implementazione (sliding window + fallback). Pattern usage: nodemailer.ts
 * e community-node-sandbox.ts. Task #262 traccia il consolidamento.
 */

import { CircuitBreaker, CircuitOpenError as SharedCircuitOpenError, type CircuitBreakerOptions } from '@zeliai/shared';
import { CircuitOpenError as NodeCircuitOpenError } from './node-error.js';

const breakers = new Map<string, CircuitBreaker>();

export interface HostBreakerOptions extends Partial<CircuitBreakerOptions> {
  /** Override del prefix per il name del breaker. Default 'http'. */
  prefix?: string;
}

/** Estrae l'host da un URL. Ritorna 'unknown' se il parse fallisce. */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

/**
 * Get-or-create breaker per host. Cache singleton: chiamate ripetute con lo
 * stesso host ritornano la STESSA istanza (necessario per condividere stato
 * cross-execution dello stesso nodo).
 */
export function getHostBreaker(host: string, opts: HostBreakerOptions = {}): CircuitBreaker {
  const prefix = opts.prefix ?? 'http';
  const name = `${prefix}:${host}`;
  const existing = breakers.get(name);
  if (existing) return existing;

  const breaker = new CircuitBreaker(name, {
    failureThreshold: opts.failureThreshold ?? 5,
    resetTimeout: opts.resetTimeout ?? 30_000,
    successThreshold: opts.successThreshold ?? 2,
    probeTimeout: opts.probeTimeout ?? 10_000,
    ...(opts.onStateChange ? { onStateChange: opts.onStateChange } : {}),
    ...(opts.isFailure ? { isFailure: opts.isFailure } : {}),
  });
  breakers.set(name, breaker);
  return breaker;
}

/**
 * Execute `call` thru the breaker for the given host. Converte
 * `SharedCircuitOpenError` in `NodeCircuitOpenError` (NodeError hierarchy)
 * cosi\` il middleware telemetry/result lo riconosce correttamente.
 */
export async function executeWithHostBreaker<T>(
  url: string,
  call: () => Promise<T>,
  opts?: HostBreakerOptions,
): Promise<T> {
  const host = hostOf(url);
  const breaker = getHostBreaker(host, opts);
  try {
    return await breaker.execute(call);
  } catch (err) {
    if (err instanceof SharedCircuitOpenError) {
      throw new NodeCircuitOpenError({
        breakerName: breaker.name,
        nextProbeAt: Date.now() + (opts?.resetTimeout ?? 30_000),
        cause: err,
      });
    }
    throw err;
  }
}

/** Test helper: clear registry singleton. */
export function clearBreakerRegistry(): void {
  breakers.clear();
}

/** Admin/observability helper: snapshot of all known breakers. */
export function listBreakers(): { name: string; state: string }[] {
  const out: { name: string; state: string }[] = [];
  for (const [name, b] of breakers.entries()) {
    out.push({ name, state: b.getStats().state });
  }
  return out;
}
