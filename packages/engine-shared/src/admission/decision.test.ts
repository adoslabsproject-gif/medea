/**
 * Caratterizzazione AVANZATA del reducer di ammissione (il cervello della coda).
 *
 * Ogni test isola un'INVARIANTE e sceglie asserzioni che uccidono mutazioni
 * plausibili: cap di concorrenza, FAIRNESS (no-jump a coda non vuota), multi-
 * admit (rank<freeSlots), reclaim lease scaduti, heartbeat idempotente,
 * backpressure, anti-flood per-tenant, purezza (no mutazione input), posizione.
 *
 * @module admission/decision.test
 */
import { describe, it, expect } from 'vitest';
import { decideAdmission, releaseLease, type PoolState, type AdmissionInput } from './decision';

const BASE: Omit<AdmissionInput, 'requestId' | 'tenantId'> = {
  nowMs: 1_000_000,
  leaseMs: 30_000,
  maxConcurrent: 2,
  maxQueueDepth: 10,
  maxPerTenantQueue: 5,
};
const inp = (over: Partial<AdmissionInput> & { requestId: string; tenantId?: string }): AdmissionInput => ({
  ...BASE, tenantId: over.tenantId ?? 't1', ...over,
});
const empty = (): PoolState => ({ active: [], queue: [] });

describe('fast-path: slot libero + coda vuota → AMMESSO', () => {
  it('ammette e crea un lease con expiry = now + leaseMs', () => {
    const d = decideAdmission(empty(), inp({ requestId: 'r1' }));
    expect(d.outcome).toBe('admitted');
    expect(d.position).toBe(0);
    expect(d.ahead).toBe(0);
    expect(d.state.active).toEqual([{ id: 'r1', expiresAtMs: 1_030_000 }]);
    expect(d.state.queue).toEqual([]);
  });
});

describe('cap di concorrenza', () => {
  it('pool pieno (active=maxConcurrent) + coda vuota → ACCODA (no over-admit)', () => {
    const state: PoolState = { active: [
      { id: 'a', expiresAtMs: 2_000_000 }, { id: 'b', expiresAtMs: 2_000_000 },
    ], queue: [] };
    const d = decideAdmission(state, inp({ requestId: 'r', maxConcurrent: 2 }));
    expect(d.outcome).toBe('queued');
    expect(d.position).toBe(1);
    expect(d.ahead).toBe(0);
    expect(d.state.queue.map((w) => w.id)).toEqual(['r']);
  });

  it('maxConcurrent < 1 trattato come 1 (no divisione per zero logica)', () => {
    const state: PoolState = { active: [{ id: 'a', expiresAtMs: 2_000_000 }], queue: [] };
    const d = decideAdmission(state, inp({ requestId: 'r', maxConcurrent: 0 }));
    expect(d.outcome).toBe('queued'); // 1 attivo, cap effettivo 1 → pieno
  });
});

describe('FAIRNESS — a coda NON vuota un nuovo arrivo NON salta davanti', () => {
  it('slot libero MA coda non vuota → il nuovo arrivo ACCODA in fondo', () => {
    const state: PoolState = {
      active: [], // 2 slot liberi
      queue: [{ id: 'x', enqueuedAtMs: 999_000, tenantId: 't1' }],
    };
    const d = decideAdmission(state, inp({ requestId: 'r' }));
    expect(d.outcome).toBe('queued');
    expect(d.state.queue.map((w) => w.id)).toEqual(['x', 'r']); // in fondo, non davanti
    expect(d.position).toBe(2);
    expect(d.ahead).toBe(1);
  });
});

describe('multi-admit — più waiter in testa ammessi se ci sono più slot', () => {
  const state: PoolState = {
    active: [],
    queue: [
      { id: 'A', enqueuedAtMs: 1, tenantId: 't1' },
      { id: 'B', enqueuedAtMs: 2, tenantId: 't1' },
      { id: 'C', enqueuedAtMs: 3, tenantId: 't1' },
    ],
  };
  it('rank < freeSlots → AMMESSO (A rank0 e B rank1 con 2 slot)', () => {
    expect(decideAdmission(state, inp({ requestId: 'A', maxConcurrent: 2 })).outcome).toBe('admitted');
    expect(decideAdmission(state, inp({ requestId: 'B', maxConcurrent: 2 })).outcome).toBe('admitted');
  });
  it('rank >= freeSlots → resta QUEUED con la sua posizione reale (C rank2 con 2 slot)', () => {
    const d = decideAdmission(state, inp({ requestId: 'C', maxConcurrent: 2 }));
    expect(d.outcome).toBe('queued');
    expect(d.position).toBe(3);
    expect(d.ahead).toBe(2);
  });
  it('ammettendo B (rank1) lo si TOGLIE dalla coda e lo si aggiunge agli attivi', () => {
    const d = decideAdmission(state, inp({ requestId: 'B', maxConcurrent: 2 }));
    expect(d.state.queue.map((w) => w.id)).toEqual(['A', 'C']);
    expect(d.state.active.map((l) => l.id)).toEqual(['B']);
  });
});

describe('reclaim lease scaduti (anti-zombie su crash)', () => {
  it('un lease con expiry ≤ now NON conta: libera lo slot per il nuovo arrivo', () => {
    const state: PoolState = { active: [{ id: 'dead', expiresAtMs: BASE.nowMs - 1 }], queue: [] };
    const d = decideAdmission(state, inp({ requestId: 'r', maxConcurrent: 1 }));
    expect(d.outcome).toBe('admitted');
    expect(d.state.active.map((l) => l.id)).toEqual(['r']); // 'dead' reclaimato
  });
  it('expiry ESATTAMENTE = now è scaduto (> stretto, non >=)', () => {
    const state: PoolState = { active: [{ id: 'edge', expiresAtMs: BASE.nowMs }], queue: [] };
    const d = decideAdmission(state, inp({ requestId: 'r', maxConcurrent: 1 }));
    expect(d.outcome).toBe('admitted');
    expect(d.state.active.map((l) => l.id)).toEqual(['r']);
  });
});

describe('heartbeat / re-entry idempotente', () => {
  it('requestId GIÀ attivo → admitted + lease RINNOVATO (no nuovo slot)', () => {
    const state: PoolState = { active: [
      { id: 'r', expiresAtMs: BASE.nowMs + 1 }, { id: 'other', expiresAtMs: 2_000_000 },
    ], queue: [{ id: 'w', enqueuedAtMs: 1, tenantId: 't1' }] };
    const d = decideAdmission(state, inp({ requestId: 'r' }));
    expect(d.outcome).toBe('admitted');
    expect(d.state.active).toContainEqual({ id: 'r', expiresAtMs: BASE.nowMs + BASE.leaseMs }); // rinnovato
    expect(d.state.active).toContainEqual({ id: 'other', expiresAtMs: 2_000_000 }); // invariato
    expect(d.state.active.filter((l) => l.id === 'r')).toHaveLength(1); // non duplicato
    expect(d.state.queue.map((w) => w.id)).toEqual(['w']); // coda intatta
  });
});

describe('backpressure', () => {
  it('coda piena (length = maxQueueDepth) → REJECTED queue_full, coda invariata', () => {
    const queue = Array.from({ length: 3 }, (_, i) => ({ id: `q${i}`, enqueuedAtMs: i, tenantId: 't1' }));
    const state: PoolState = { active: [{ id: 'a', expiresAtMs: 2_000_000 }, { id: 'b', expiresAtMs: 2_000_000 }], queue };
    const d = decideAdmission(state, inp({ requestId: 'r', maxQueueDepth: 3 }));
    expect(d.outcome).toBe('rejected');
    expect(d.rejectReason).toBe('queue_full');
    expect(d.state.queue).toHaveLength(3); // NON cresciuta
  });
});

describe('anti-flood per-tenant', () => {
  it('tenant con maxPerTenantQueue richieste in coda → REJECTED tenant_flood', () => {
    const queue = [
      { id: 'q1', enqueuedAtMs: 1, tenantId: 'T' },
      { id: 'q2', enqueuedAtMs: 2, tenantId: 'T' },
      { id: 'q3', enqueuedAtMs: 3, tenantId: 'OTHER' },
    ];
    const state: PoolState = { active: [{ id: 'a', expiresAtMs: 2e6 }, { id: 'b', expiresAtMs: 2e6 }], queue };
    const d = decideAdmission(state, inp({ requestId: 'r', tenantId: 'T', maxPerTenantQueue: 2 }));
    expect(d.outcome).toBe('rejected');
    expect(d.rejectReason).toBe('tenant_flood');
  });
  it('un ALTRO tenant NON è bloccato dal flood di T (cap è per-tenant, non globale)', () => {
    const queue = [
      { id: 'q1', enqueuedAtMs: 1, tenantId: 'T' },
      { id: 'q2', enqueuedAtMs: 2, tenantId: 'T' },
    ];
    const state: PoolState = { active: [{ id: 'a', expiresAtMs: 2e6 }, { id: 'b', expiresAtMs: 2e6 }], queue };
    const d = decideAdmission(state, inp({ requestId: 'r', tenantId: 'FRESH', maxPerTenantQueue: 2 }));
    expect(d.outcome).toBe('queued');
    expect(d.state.queue.map((w) => w.id)).toEqual(['q1', 'q2', 'r']);
  });
});

describe('purezza — input non mutati', () => {
  it('lo stato di input resta identico (no side-effect sull\'oggetto passato)', () => {
    const state: PoolState = { active: [], queue: [{ id: 'x', enqueuedAtMs: 1, tenantId: 't1' }] };
    const snapshot = JSON.stringify(state);
    decideAdmission(state, inp({ requestId: 'r' }));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('releaseLease', () => {
  it('rimuove il lease del requestId E reclaima gli scaduti, coda intatta', () => {
    const state: PoolState = {
      active: [
        { id: 'r', expiresAtMs: 2e6 },
        { id: 'keep', expiresAtMs: 2e6 },
        { id: 'dead', expiresAtMs: BASE.nowMs - 5 },
      ],
      queue: [{ id: 'w', enqueuedAtMs: 1, tenantId: 't1' }],
    };
    const next = releaseLease(state, 'r', BASE.nowMs);
    expect(next.active.map((l) => l.id)).toEqual(['keep']); // 'r' rilasciato, 'dead' reclaimato
    expect(next.queue.map((w) => w.id)).toEqual(['w']);
  });
});
