/**
 * Admission decision — reducer PURO della coda di ammissione LLM.
 *
 * È il cervello: dato lo stato di un pool (lease in-flight + coda FIFO) e una
 * richiesta, decide se AMMETTERLA, ACCODARLA o RIFIUTARLA (backpressure), e
 * ritorna il nuovo stato + la posizione. Nessun I/O, nessun Redis: lo strato
 * Redis (Lua atomico) rispecchia QUESTA logica passo-passo.
 *
 * Invarianti chiave (verificate dai test):
 *  - mai più di `maxConcurrent` lease vivi contemporaneamente;
 *  - FAIRNESS: a coda NON vuota un nuovo arrivo NON salta davanti, accoda;
 *  - i lease SCADUTI (expiry ≤ now) liberano slot (anti-zombie su crash);
 *  - re-entry idempotente: ri-chiamare con un requestId già in-flight rinnova
 *    il lease (= heartbeat) senza consumare un nuovo slot;
 *  - più waiter in testa vengono ammessi insieme se ci sono più slot liberi
 *    (rank < slot liberi) → niente head-of-line underutilization;
 *  - backpressure: coda piena → reject; flood per-tenant → reject.
 *
 * @module admission/decision
 */

export interface Lease {
  id: string;
  /** Epoch ms oltre cui il lease è considerato scaduto (reclaim). */
  expiresAtMs: number;
}

export interface Waiter {
  id: string;
  /** Epoch ms di accodamento — ordine FIFO. */
  enqueuedAtMs: number;
  tenantId: string;
}

export interface PoolState {
  active: Lease[];
  /** Ordinata per enqueuedAtMs crescente (FIFO). */
  queue: Waiter[];
}

export interface AdmissionInput {
  requestId: string;
  tenantId: string;
  nowMs: number;
  /** Durata del lease prima del reclaim (rinnovata da heartbeat). */
  leaseMs: number;
  /** Slot concorrenti del pool (GPU-bound per vLLM). <1 → trattato come 1. */
  maxConcurrent: number;
  /** Profondità massima coda → oltre = reject (sovraccarico). */
  maxQueueDepth: number;
  /** Max richieste in coda per singolo tenant (anti-flood). */
  maxPerTenantQueue: number;
}

export type AdmissionOutcome = 'admitted' | 'queued' | 'rejected';
export type RejectReason = 'queue_full' | 'tenant_flood';

export interface AdmissionDecision {
  outcome: AdmissionOutcome;
  /** Posizione 1-based in coda (solo se queued). */
  position: number;
  /** Persone davanti (= position-1; 0 se ammesso). */
  ahead: number;
  /** Motivo del reject (solo se rejected). */
  rejectReason?: RejectReason;
  /** Nuovo stato del pool dopo la decisione. */
  state: PoolState;
}

/** Decide l'ammissione (pura). Non muta gli input. */
export function decideAdmission(state: PoolState, input: AdmissionInput): AdmissionDecision {
  const { requestId, tenantId, nowMs, leaseMs, maxQueueDepth, maxPerTenantQueue } = input;
  const maxConcurrent = Math.max(1, input.maxConcurrent);

  // 1. Reclaim dei lease scaduti (anti-zombie).
  const activeLive = state.active.filter((l) => l.expiresAtMs > nowMs);
  // Coda preservata in ordine FIFO (assumiamo input ordinato; non riordiniamo).
  const queue = state.queue;

  // 2. Re-entry idempotente / heartbeat: già in-flight → rinnova il lease.
  if (activeLive.some((l) => l.id === requestId)) {
    const renewed = activeLive.map((l) => (l.id === requestId ? { ...l, expiresAtMs: nowMs + leaseMs } : l));
    return { outcome: 'admitted', position: 0, ahead: 0, state: { active: renewed, queue } };
  }

  const freeSlots = maxConcurrent - activeLive.length;
  const newLease: Lease = { id: requestId, expiresAtMs: nowMs + leaseMs };
  const rank = queue.findIndex((w) => w.id === requestId);

  if (rank >= 0) {
    // Già in coda: ammetti se rientra negli slot liberi (rank 0-based < freeSlots).
    if (rank < freeSlots) {
      return {
        outcome: 'admitted', position: 0, ahead: 0,
        state: { active: [...activeLive, newLease], queue: queue.filter((w) => w.id !== requestId) },
      };
    }
    return { outcome: 'queued', position: rank + 1, ahead: rank, state: { active: activeLive, queue } };
  }

  // Primo arrivo: fast-path SOLO se ci sono slot E la coda è vuota (fairness:
  // a coda non vuota non si salta davanti, si accoda).
  if (freeSlots > 0 && queue.length === 0) {
    return { outcome: 'admitted', position: 0, ahead: 0, state: { active: [...activeLive, newLease], queue } };
  }

  // Backpressure prima di accodare.
  if (queue.length >= maxQueueDepth) {
    return { outcome: 'rejected', position: 0, ahead: 0, rejectReason: 'queue_full', state: { active: activeLive, queue } };
  }
  const tenantInQueue = queue.reduce((n, w) => (w.tenantId === tenantId ? n + 1 : n), 0);
  if (tenantInQueue >= maxPerTenantQueue) {
    return { outcome: 'rejected', position: 0, ahead: 0, rejectReason: 'tenant_flood', state: { active: activeLive, queue } };
  }

  const enqueued: Waiter = { id: requestId, enqueuedAtMs: nowMs, tenantId };
  const newQueue = [...queue, enqueued];
  const newRank = newQueue.length - 1;
  return { outcome: 'queued', position: newRank + 1, ahead: newRank, state: { active: activeLive, queue: newQueue } };
}

/** Rilascia uno slot (release esplicito a fine inferenza). Puro. */
export function releaseLease(state: PoolState, requestId: string, nowMs: number): PoolState {
  return {
    active: state.active.filter((l) => l.id !== requestId && l.expiresAtMs > nowMs),
    queue: state.queue,
  };
}
