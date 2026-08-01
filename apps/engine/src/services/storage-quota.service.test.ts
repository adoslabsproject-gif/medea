/**
 * Test 2026-grade — StorageQuotaService.
 *
 * Pure function coverage: split tier-aware deterministico.
 */
import { describe, it, expect } from 'vitest';
import { computeQuotas, canPersistRunTrace, STORAGE_QUOTA_RATIOS } from './storage-quota.service.js';

describe('computeQuotas — Free tier (100% data, 0% log)', () => {
  it('Free 1GB → 1GB workflow + 0 log', () => {
    const q = computeQuotas('free', 1);
    expect(q.freeTier).toBe(true);
    expect(q.totalBytes).toBe(1024 * 1024 * 1024);
    expect(q.workflowDataBytes).toBe(1024 * 1024 * 1024);
    expect(q.logRetentionBytes).toBe(0);
  });

  it('Free 0GB (edge) → 0 workflow + 0 log', () => {
    const q = computeQuotas('free', 0);
    expect(q.workflowDataBytes).toBe(0);
    expect(q.logRetentionBytes).toBe(0);
  });
});

describe('computeQuotas — Paid tier (70% data, 30% log)', () => {
  it.each([
    ['starter', 10, 7.0 * 1024 ** 3, 3.0 * 1024 ** 3],
    ['pro', 20, 14.0 * 1024 ** 3, 6.0 * 1024 ** 3],
    ['team', 50, 35.0 * 1024 ** 3, 15.0 * 1024 ** 3],
    ['business', 50, 35.0 * 1024 ** 3, 15.0 * 1024 ** 3],
    ['enterprise', 200, 140.0 * 1024 ** 3, 60.0 * 1024 ** 3],
  ])('%s %iGB → split 70/30', (plan, gb, expectedData, expectedLog) => {
    const q = computeQuotas(plan, gb);
    expect(q.freeTier).toBe(false);
    expect(q.workflowDataBytes).toBe(Math.floor(expectedData));
    expect(q.logRetentionBytes).toBe(Math.floor(expectedLog));
    // Somma uguale al totale (sotto il rounding floor)
    expect(q.workflowDataBytes + q.logRetentionBytes).toBeLessThanOrEqual(q.totalBytes);
  });

  it('plan sconosciuto trattato come paid (70/30)', () => {
    const q = computeQuotas('custom-tier-x', 10);
    expect(q.freeTier).toBe(false);
    expect(q.workflowDataBytes).toBeGreaterThan(0);
    expect(q.logRetentionBytes).toBeGreaterThan(0);
  });
});

describe('canPersistRunTrace — tier gating', () => {
  it('free → false', () => {
    expect(canPersistRunTrace('free')).toBe(false);
  });

  it.each(['starter', 'pro', 'team', 'business', 'enterprise', 'custom'])(
    '%s → true (paid)',
    (plan) => {
      expect(canPersistRunTrace(plan)).toBe(true);
    },
  );
});

describe('STORAGE_QUOTA_RATIOS — costanti shared', () => {
  it('paid data + log = 100%', () => {
    expect(STORAGE_QUOTA_RATIOS.paidTierData + STORAGE_QUOTA_RATIOS.paidTierLog).toBe(1);
  });

  it('free data 100%, log 0%', () => {
    expect(STORAGE_QUOTA_RATIOS.freeData).toBe(1);
    expect(STORAGE_QUOTA_RATIOS.freeLog).toBe(0);
  });
});
