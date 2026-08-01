/**
 * Test — computeRetryDelay: Retry-After rispettato + equal-jitter sul backoff
 * esponenziale (anti thundering-herd). `rand` iniettato per determinismo.
 */
import { describe, it, expect } from 'vitest';
import { computeRetryDelay } from './node-executor.strategy.js';

describe('computeRetryDelay', () => {
  it('Retry-After presente → rispettato (clamp a max), nessun jitter', () => {
    expect(computeRetryDelay(1000, 1, 30_000, 5000)).toBe(5000);
    expect(computeRetryDelay(1000, 3, 30_000, 120_000)).toBe(30_000); // clamp al max
    expect(computeRetryDelay(1000, 1, 30_000, 0)).toBe(0);
  });

  it('senza Retry-After → equal jitter in [exp/2, exp]', () => {
    // attempt=1 → exp = base*2^0 = 1000 → range [500, 1000]
    expect(computeRetryDelay(1000, 1, 30_000, null, () => 0)).toBe(500); // rand=0 → exp/2
    expect(computeRetryDelay(1000, 1, 30_000, null, () => 1)).toBe(1000); // rand=1 → exp
    expect(computeRetryDelay(1000, 1, 30_000, null, () => 0.5)).toBe(750); // metà
  });

  it('backoff cresce esponenzialmente fino al cap', () => {
    // attempt=4 → exp = 1000*2^3 = 8000 → con rand=1 → 8000
    expect(computeRetryDelay(1000, 4, 30_000, null, () => 1)).toBe(8000);
    // attempt=6 → exp = 1000*2^5 = 32000 → clamp 30000
    expect(computeRetryDelay(1000, 6, 30_000, null, () => 1)).toBe(30_000);
  });

  it('jitter non supera mai exp né scende sotto exp/2', () => {
    for (let i = 0; i < 50; i++) {
      const d = computeRetryDelay(1000, 2, 30_000, null); // exp=2000 → [1000,2000]
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  it('🚨 Retry-After=0 → onorato (delay immediato)', () => {
    expect(computeRetryDelay(1000, 1, 30_000, 0, () => 0.5)).toBe(0);
  });

  it('🚨 Retry-After negative (sentinel -1) → ignorato, usa exponential', () => {
    const r = computeRetryDelay(1000, 1, 30_000, -1, () => 0);
    expect(r).toBe(500); // exp/2 = 1000/2
  });

  it('🚨 base=0 → tutti 0 (degenerate case, NO crash)', () => {
    expect(computeRetryDelay(0, 1, 30_000, null, () => 0.5)).toBe(0);
    expect(computeRetryDelay(0, 5, 30_000, null, () => 1)).toBe(0);
  });

  it('🚨 SECURITY: rand iniettabile (test determinismo, no hidden Math.random)', () => {
    expect(computeRetryDelay(2000, 1, 30_000, null, () => 0)).toBe(1000);
    expect(computeRetryDelay(2000, 1, 30_000, null, () => 0.99)).toBeGreaterThanOrEqual(1980);
  });

  it('🚨 distribuzione antithundering: 100 chiamate spread > 200ms range', () => {
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      samples.push(computeRetryDelay(1000, 1, 30_000, null));
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max - min).toBeGreaterThan(200);
  });

  it('🚨 ritorno sempre intero (Math.floor)', () => {
    for (let i = 0; i < 20; i++) {
      const r = computeRetryDelay(333, 2, 30_000, null, () => Math.random());
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  it('🚨 ritorno >= 0 (no negative delays)', () => {
    for (let i = 0; i < 20; i++) {
      const r = computeRetryDelay(1000, 1, 30_000, null, () => Math.random());
      expect(r).toBeGreaterThanOrEqual(0);
    }
  });

  it('🚨 attempt=20 cap a maxBackoff anche con random alto', () => {
    const r0 = computeRetryDelay(1000, 20, 30_000, null, () => 0);
    expect(r0).toBe(15000); // metà di maxBackoff
    const r1 = computeRetryDelay(1000, 20, 30_000, null, () => 1);
    expect(r1).toBe(30_000);
  });

  it('🚨 base=500ms attempt=4 → exp=4000, jitter [2000, 4000]', () => {
    expect(computeRetryDelay(500, 4, 30_000, null, () => 0.5)).toBe(3000);
    expect(computeRetryDelay(500, 4, 30_000, null, () => 0)).toBe(2000);
    expect(computeRetryDelay(500, 4, 30_000, null, () => 1)).toBe(4000);
  });
});
