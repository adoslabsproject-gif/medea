/**
 * withIdempotency + withConditionalIdempotency — anti duplicate side-effect.
 *
 * TTL run-aware: se ctx.runDeadline e\` settato dall'engine, il lock vive
 * fino al deadline + 60s slack — mai decade pre-run-end.
 *
 * Conditional: RFC 7231 — GET/HEAD/OPTIONS sono safe-to-retry, skip lock.
 * POST/PUT/PATCH/DELETE side-effect → lock.
 */

import type { NodeExecutor } from '../../types.js';
import {
  defaultIdempotencyStore,
  makeIdempotencyKey,
  type AcquireResult,
  type IdempotencyStore,
} from '../idempotency.js';
import type { Middleware } from './compose.js';

/** Attesa massima in-flight di default (ms): oltre, l'esecuzione concorrente è
 *  considerata bloccata/morta e si solleva {@link IdempotencyInFlightError}. */
const DEFAULT_INFLIGHT_WAIT_MS = 30_000;
/** Intervallo di poll dell'attesa in-flight (ms). */
const DEFAULT_INFLIGHT_POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sollevata quando un'esecuzione CONCORRENTE della stessa (tenant,run,node[,sub])
 * tiene il lock e non completa entro l'attesa: NON si esegue (eviterebbe il doppio
 * side-effect, es. doppio charge) → l'engine ritenta (al retry l'altra è completata
 * → replay, oppure il lock è scaduto → si esegue).
 */
export class IdempotencyInFlightError extends Error {
  constructor(
    public readonly key: string,
    public readonly waitedMs: number,
  ) {
    super(
      `idempotency: esecuzione concorrente in corso per "${key}" (atteso ${String(waitedMs)}ms senza completamento)`,
    );
    this.name = 'IdempotencyInFlightError';
  }
}

const DEFAULT_IDEMPOTENCY_TTL_MS = (() => {
  // Isomorfico: nel bundle browser dell'editor questo modulo è dead-code (mai
  // eseguito) ma viene comunque *importato* → il top-level gira a load. `process`
  // non esiste lì → guard. Sul runtime server `process` c'è: valore identico.
  const env = Number(
    typeof process !== 'undefined' ? process.env.MEDEA_IDEMPOTENCY_TTL_MS : undefined,
  );
  return Number.isFinite(env) && env > 0 ? env : 24 * 60 * 60 * 1000; // 24h
})();

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface IdempotencyMiddlewareOptions {
  store?: IdempotencyStore;
  ttlMs?: number;
  subKey?: (config: unknown, input: unknown) => string | undefined;
  /**
   * Behavior quando lo store e\` down (Redis offline). Default 'fail-open'.
   * Per write nodes critici dove doppio side-effect = PEGGIO di fallimento
   * (Stripe charge, bank transfer), settare 'fail-closed'.
   */
  resilience?: IdempotencyResilience;
  /** Attesa massima (ms) per un'esecuzione concorrente in-flight prima di sollevare
   *  {@link IdempotencyInFlightError}. Default {@link DEFAULT_INFLIGHT_WAIT_MS}. */
  inFlightWaitMs?: number;
  /** Intervallo di poll (ms) dell'attesa in-flight. Default {@link DEFAULT_INFLIGHT_POLL_MS}. */
  inFlightPollMs?: number;
}

/**
 * Resilience policy quando lo store backend (Redis) e\` down:
 *
 *   • 'fail-open' (default): proseguire con next() come se acquire avesse
 *     succeeded. Lock NON applicato → rischio doppio side-effect su retry MA
 *     il workflow non si blocca per resilience-tax. Best per write nodes dove
 *     downtime parziale e\` preferibile a uptime zero. Warning loggato.
 *   • 'fail-closed': throw l'errore Redis → engine retry policy lo gestisce.
 *     Best per side-effect critici dove doppia esecuzione e\` PEGGIO di
 *     fallimento (transazioni finanziarie, mandato bancario).
 */
export type IdempotencyResilience = 'fail-open' | 'fail-closed';

export function withIdempotency(opts: IdempotencyMiddlewareOptions = {}): Middleware {
  const store = opts.store ?? defaultIdempotencyStore;
  const baseTtlMs = opts.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const resilience: IdempotencyResilience = opts.resilience ?? 'fail-open';
  const inFlightWaitMs = opts.inFlightWaitMs ?? DEFAULT_INFLIGHT_WAIT_MS;
  const inFlightPollMs = opts.inFlightPollMs ?? DEFAULT_INFLIGHT_POLL_MS;
  return (next: NodeExecutor) => async (config, input, ctx) => {
    const sub = opts.subKey ? opts.subKey(config, input) : undefined;
    const key =
      sub !== undefined
        ? makeIdempotencyKey(ctx.tenantId, ctx.runId, ctx.nodeId, sub)
        : makeIdempotencyKey(ctx.tenantId, ctx.runId, ctx.nodeId);
    const ttlMs =
      ctx.runDeadline !== undefined
        ? Math.min(baseTtlMs, Math.max(60_000, ctx.runDeadline - Date.now() + 60_000))
        : baseTtlMs;

    // Resilience-aware acquire: store down (Redis offline) NON deve bloccare
    // il workflow di default — il rischio doppio-POST e\` preferibile al
    // 100% downtime su tutti i write nodes. Ritorna `null` (= store-down,
    // procedi senza lock) quando l'acquire fallisce in modalità fail-open.
    const tryAcquire = async (): Promise<AcquireResult | null> => {
      try {
        return await store.acquire(key, ttlMs);
      } catch (err) {
        if (resilience === 'fail-closed') throw err;
        ctx.logger?.warn('idempotency:store-down — fail-open proseguo (no lock applicato)', {
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };

    let acquire = await tryAcquire();
    if (acquire === null) return next(config, input, ctx);

    // ── IN-FLIGHT WAIT (#race) ───────────────────────────────────────────────
    // Stato in-flight = `acquired=false` E `previousOutput===undefined`: un'ALTRA
    // esecuzione concorrente della STESSA chiave tiene il lock e NON ha ancora
    // completato. Pre-fix qui si cadeva nel `next()` → DOPPIO side-effect (es. doppio
    // charge). Ora si ATTENDE (poll) che l'altra completi (→ replay), oppure che il
    // suo lock scada e lo si acquisisca (l'altra è morta → si esegue), oppure timeout
    // → IdempotencyInFlightError (l'engine ritenta). Mai eseguire mentre un'altra è viva.
    let waited = 0;
    while (acquire !== null && !acquire.acquired && acquire.previousOutput === undefined) {
      if (waited >= inFlightWaitMs) {
        throw new IdempotencyInFlightError(key, waited);
      }
      await sleep(inFlightPollMs);
      waited += inFlightPollMs;
      acquire = await tryAcquire();
    }
    if (acquire === null) return next(config, input, ctx); // store caduto durante l'attesa

    if (!acquire.acquired) {
      // Completata da un'altra esecuzione (previousOutput definito) → replay.
      return { output: acquire.previousOutput, durationMs: 0, warnings: ['idempotency:cached'] };
    }
    try {
      const result = await next(config, input, ctx);
      // Store.complete fail = log warn, NON propagate — il risultato e\` gia\`
      // pronto, perdere il "save output for replay" non rompe il run corrente.
      try {
        await store.complete(key, result.output);
      } catch (e) {
        ctx.logger?.warn('idempotency:complete-failed (store down post-exec)', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      return result;
    } catch (err) {
      // Store.release fail e\` benign (lock TTL decay) — log + propagate origin err.
      try {
        await store.release(key);
      } catch {
        /* swallow — origin error e\` quello importante */
      }
      throw err;
    }
  };
}

/**
 * Skip lock per metodi RFC 7231 safe (GET/HEAD/OPTIONS), apply per side-effect.
 */
export function withConditionalIdempotency(opts: {
  methodFrom: (config: Record<string, unknown>) => string;
  store?: IdempotencyStore;
  ttlMs?: number;
}): Middleware {
  const inner = withIdempotency({
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return (next: NodeExecutor) => async (config, input, ctx) => {
    const method = opts.methodFrom(config).toUpperCase();
    if (SAFE_HTTP_METHODS.has(method)) return next(config, input, ctx);
    return inner(next)(config, input, ctx);
  };
}
