/**
 * Test 2026-grade — domain/janitor-report.ts (severity aggregator).
 *
 * 🚨 emptyBySeverity: oggetto frozen baseline per init counter.
 *    Bug = mutation accidentale corrompe successivi aggregati.
 *
 * 🚨 aggregateBySeverity: count immutable per ogni severity.
 *    Bug = report header conta sbagliato → SLA report falso.
 */
import { describe, it, expect } from 'vitest';
import { emptyBySeverity, aggregateBySeverity } from './janitor-report.js';

describe('🚨 emptyBySeverity — baseline counter', () => {
  it('🚨 entrambi a 0', () => {
    expect(emptyBySeverity()).toEqual({ critical: 0, warning: 0 });
  });

  it('🚨 oggetto frozen (no mutation)', () => {
    const empty = emptyBySeverity();
    expect(Object.isFrozen(empty)).toBe(true);
  });

  it('🚨 SECURITY: mutation strict mode → throw', () => {
    'use strict';
    const empty = emptyBySeverity();
    expect(() => {
      (empty as { critical: number }).critical = 999;
    }).toThrow();
  });
});

describe('🚨 aggregateBySeverity — count per severity', () => {
  it('🚨 array vuoto → {critical:0, warning:0}', () => {
    expect(aggregateBySeverity([])).toEqual({ critical: 0, warning: 0 });
  });

  it('🚨 3 critical + 2 warning → counter corretto', () => {
    const r = aggregateBySeverity([
      { severity: 'critical' },
      { severity: 'warning' },
      { severity: 'critical' },
      { severity: 'warning' },
      { severity: 'critical' },
    ]);
    expect(r).toEqual({ critical: 3, warning: 2 });
  });

  it('🚨 solo critical → warning=0', () => {
    const r = aggregateBySeverity([{ severity: 'critical' }, { severity: 'critical' }]);
    expect(r).toEqual({ critical: 2, warning: 0 });
  });

  it('🚨 solo warning → critical=0', () => {
    const r = aggregateBySeverity([{ severity: 'warning' }]);
    expect(r).toEqual({ critical: 0, warning: 1 });
  });

  it('🚨 output frozen', () => {
    const r = aggregateBySeverity([{ severity: 'critical' }]);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('🚨 1000 elementi performance', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      severity: i % 3 === 0 ? ('critical' as const) : ('warning' as const),
    }));
    const r = aggregateBySeverity(rows);
    expect(r.critical + r.warning).toBe(1000);
  });

  it('🚨 funziona con extra keys ignorate (structural)', () => {
    const r = aggregateBySeverity([
      { severity: 'critical', extra: 'ignored' } as { severity: 'critical' },
    ]);
    expect(r.critical).toBe(1);
  });
});
