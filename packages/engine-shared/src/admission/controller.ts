/**
 * Admission controller — il loop async che porta una richiesta DALL'arrivo
 * fino allo slot LLM, con feedback di posizione.
 *
 * Flusso: tenta l'ammissione → se in coda emette `onQueue({position, ahead})`
 * e ripolla finché si libera uno slot → quando ammesso, avvia l'heartbeat
 * (rinnova il lease durante lo streaming) e ritorna un handle con `release()`.
 *
 * Backpressure: coda piena / flood-tenant → `AdmissionOverloadError` (→ 503).
 * Attesa massima superata → `AdmissionTimeoutError`. Abort del client (SSE
 * chiuso) → esce dalla coda e lancia `AdmissionAbortError` (niente slot zombie).
 *
 * Clock e sleep sono iniettabili (test deterministici, no timer reali nel loop).
 *
 * @module admission/controller
 */
import { tryAdmit, release as releaseSlot, heartbeat, type RedisLike } from './redis-queue.js';
import type { RejectReason } from './decision.js';

export class AdmissionOverloadError extends Error {
  constructor(public readonly reason: RejectReason) {
    super(`admission overloaded: ${reason}`);
    this.name = 'AdmissionOverloadError';
  }
}
export class AdmissionTimeoutError extends Error {
  constructor() {
    super('admission wait timeout');
    this.name = 'AdmissionTimeoutError';
  }
}
export class AdmissionAbortError extends Error {
  constructor() {
    super('admission aborted by client');
    this.name = 'AdmissionAbortError';
  }
}

export interface AdmitOptions {
  redis: RedisLike;
  pool: string;
  requestId: string;
  tenantId: string;
  maxConcurrent: number;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  maxQueueDepth: number;
  maxPerTenantQueue: number;
  maxWaitMs: number;
  signal?: AbortSignal;
  /** Emesso a OGNI cambio di posizione mentre si è in coda. */
  onQueue?: (p: { position: number; ahead: number }) => void;
  /** Iniettabili per i test (default: Date.now / setTimeout / setInterval). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => { clear: () => void };
}

export interface AdmissionHandle {
  /** Rilascia lo slot e ferma l'heartbeat. Idempotente. */
  release: () => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const defaultSchedule = (fn: () => void, ms: number): { clear: () => void } => {
  const id = setInterval(fn, ms);
  return {
    clear: () => {
      clearInterval(id);
    },
  };
};

export async function admit(opts: AdmitOptions): Promise<AdmissionHandle> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const schedule = opts.schedule ?? defaultSchedule;
  const { redis, pool, requestId, tenantId } = opts;
  const startedAt = now();
  let lastEmitted = -1;

  const decisionInput = (): Parameters<typeof tryAdmit>[2] => ({
    requestId,
    tenantId,
    nowMs: now(),
    leaseMs: opts.leaseMs,
    maxConcurrent: opts.maxConcurrent,
    maxQueueDepth: opts.maxQueueDepth,
    maxPerTenantQueue: opts.maxPerTenantQueue,
  });

  for (;;) {
    if (opts.signal?.aborted) {
      await releaseSlot(redis, pool, requestId);
      throw new AdmissionAbortError();
    }

    const d = await tryAdmit(redis, pool, decisionInput());

    if (d.outcome === 'admitted') {
      const hb = schedule(() => {
        void heartbeat(redis, pool, requestId, now() + opts.leaseMs).catch(() => {
          /* best-effort */
        });
      }, opts.heartbeatMs);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          hb.clear();
          await releaseSlot(redis, pool, requestId);
        },
      };
    }

    if (d.outcome === 'rejected') {
      await releaseSlot(redis, pool, requestId);
      throw new AdmissionOverloadError(d.rejectReason ?? 'queue_full');
    }

    // queued → emetti la posizione (solo sui cambi) e controlla l'attesa massima.
    if (d.position !== lastEmitted) {
      lastEmitted = d.position;
      opts.onQueue?.({ position: d.position, ahead: d.ahead });
    }
    if (now() - startedAt > opts.maxWaitMs) {
      await releaseSlot(redis, pool, requestId);
      throw new AdmissionTimeoutError();
    }
    await sleep(opts.pollMs);
  }
}
