/**
 * Bug-bounty test — vector quota engine.
 *
 * Il test PIÙ importante (vincolo reviewer): l'aggregazione per-tenant impedisce il
 * bypass del limite creando N database piccoli.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateTenantVectors,
  estimateVectorDiskMb,
  checkVectorQuota,
  type VectorPlanLimits,
} from './vector-quota.js';

describe('aggregateTenantVectors — anti-bypass via N database', () => {
  it('somma i conteggi di TUTTI i vector DB del tenant', () => {
    expect(aggregateTenantVectors([40, 40, 40])).toBe(120);
    expect(aggregateTenantVectors([])).toBe(0);
    expect(aggregateTenantVectors([100])).toBe(100);
  });

  it('ignora valori negativi/NaN (robustezza)', () => {
    expect(aggregateTenantVectors([50, -5, NaN, 10])).toBe(60);
  });
});

describe('checkVectorQuota — vincolo aggregato (BUG-BOUNTY)', () => {
  const plan: VectorPlanLimits = { maxVectors: 100, maxDiskMb: null };

  it('BYPASS BLOCCATO: 3 database da 40 (=120 aggregati) > limite 100, anche se nessun DB singolo lo supera', () => {
    const total = aggregateTenantVectors([40, 40, 40]); // 120
    const d = checkVectorQuota({ totalVectors: total, diskMb: 0 }, 0, 0, plan);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('VECTOR_COUNT_EXCEEDED');
  });

  it('addVectors che spinge OLTRE il limite → bloccato', () => {
    const d = checkVectorQuota({ totalVectors: 95, diskMb: 0 }, 10, 0, plan); // 95+10=105>100
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Quota vettori.*superata/);
  });

  it('esattamente AL limite → consentito', () => {
    expect(checkVectorQuota({ totalVectors: 90, diskMb: 0 }, 10, 0, plan).allowed).toBe(true); // 100 = 100
  });

  it('uno oltre il limite → bloccato', () => {
    expect(checkVectorQuota({ totalVectors: 90, diskMb: 0 }, 11, 0, plan).allowed).toBe(false); // 101
  });

  it('limite NULL = illimitato (Enterprise/BYOK) → sempre consentito', () => {
    const unlimited: VectorPlanLimits = { maxVectors: null, maxDiskMb: null };
    expect(
      checkVectorQuota({ totalVectors: 1_000_000, diskMb: 999_999 }, 50_000, 9999, unlimited)
        .allowed,
    ).toBe(true);
  });
});

describe('checkVectorQuota — quota disco PROIETTIVA', () => {
  it('disco già oltre il limite → bloccato col codice giusto', () => {
    const d = checkVectorQuota({ totalVectors: 0, diskMb: 600 }, 0, 0, {
      maxVectors: null,
      maxDiskMb: 500,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('VECTOR_DISK_EXCEEDED');
  });

  it('PROIEZIONE: uso sotto soglia ma il batch aggiunto sfora → bloccato (coerente col count)', () => {
    // 400MB attuali + 150MB del batch = 550 > 500. Senza proiezione passerebbe (bug reviewer).
    const d = checkVectorQuota({ totalVectors: 0, diskMb: 400 }, 100000, 150, {
      maxVectors: null,
      maxDiskMb: 500,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('VECTOR_DISK_EXCEEDED');
  });

  it('disco + batch entro il limite → consentito', () => {
    expect(
      checkVectorQuota({ totalVectors: 0, diskMb: 400 }, 100, 50, {
        maxVectors: null,
        maxDiskMb: 500,
      }).allowed,
    ).toBe(true);
  });
});

describe('estimateVectorDiskMb', () => {
  it('stima MB da count×dim×4byte +30% overhead', () => {
    // 10000 vettori × 1024 dim × 4 byte = ~39MB raw → ~51MB con overhead
    const mb = estimateVectorDiskMb(10_000, 1024);
    expect(mb).toBeGreaterThan(40);
    expect(mb).toBeLessThan(60);
  });

  it('zero/negativi → 0', () => {
    expect(estimateVectorDiskMb(0, 1024)).toBe(0);
    expect(estimateVectorDiskMb(100, 0)).toBe(0);
  });
});
