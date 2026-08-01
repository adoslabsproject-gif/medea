/**
 * Test 2026-grade — domain/severity.ts (Value Object CorruptionSeverity).
 *
 * 🚨 RANK: critical=2, warning=1 → critical > warning per ordering.
 *
 * 🚨 isSeverity: type guard safe per input untrusted.
 *
 * 🚨 maxSeverity: bug = report header diventa "warning" quando dovrebbe critical.
 *
 * 🚨 Tables freeze: nessuna mutation runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  SEVERITIES,
  isSeverity,
  compareSeverity,
  maxSeverity,
  severityLabel,
  severityColor,
} from './severity.js';

describe('🚨 SEVERITIES — set congelato', () => {
  it('🚨 contiene critical + warning', () => {
    expect(SEVERITIES).toEqual(['critical', 'warning']);
  });

  it('🚨 contiene esattamente 2 valori (no info/debug)', () => {
    expect(SEVERITIES).toHaveLength(2);
  });
});

describe('🚨 isSeverity — type guard', () => {
  it('🚨 "critical" → true', () => {
    expect(isSeverity('critical')).toBe(true);
  });

  it('🚨 "warning" → true', () => {
    expect(isSeverity('warning')).toBe(true);
  });

  it('🚨 "info" → false', () => {
    expect(isSeverity('info')).toBe(false);
  });

  it('🚨 "CRITICAL" uppercase → false (case-sensitive)', () => {
    expect(isSeverity('CRITICAL')).toBe(false);
  });

  it('🚨 SECURITY: non-string → false (no throw)', () => {
    expect(isSeverity(null)).toBe(false);
    expect(isSeverity(undefined)).toBe(false);
    expect(isSeverity(2)).toBe(false);
    expect(isSeverity({})).toBe(false);
    expect(isSeverity([])).toBe(false);
  });

  it('🚨 stringa vuota → false', () => {
    expect(isSeverity('')).toBe(false);
  });
});

describe('🚨 compareSeverity — ordering', () => {
  it('🚨 critical > warning → positivo', () => {
    expect(compareSeverity('critical', 'warning')).toBeGreaterThan(0);
  });

  it('🚨 warning < critical → negativo', () => {
    expect(compareSeverity('warning', 'critical')).toBeLessThan(0);
  });

  it('🚨 stesse → 0', () => {
    expect(compareSeverity('critical', 'critical')).toBe(0);
    expect(compareSeverity('warning', 'warning')).toBe(0);
  });

  it('🚨 sortable con Array.sort (critical first desc)', () => {
    const arr: ('critical' | 'warning')[] = ['warning', 'critical', 'warning'];
    arr.sort((a, b) => compareSeverity(b, a));
    expect(arr).toEqual(['critical', 'warning', 'warning']);
  });
});

describe('🚨 maxSeverity — aggregate header status', () => {
  it('🚨 [critical, warning] → critical', () => {
    expect(maxSeverity(['critical', 'warning'])).toBe('critical');
  });

  it('🚨 [warning, critical, warning] → critical', () => {
    expect(maxSeverity(['warning', 'critical', 'warning'])).toBe('critical');
  });

  it('🚨 solo warning → warning', () => {
    expect(maxSeverity(['warning', 'warning'])).toBe('warning');
  });

  it('🚨 solo critical → critical', () => {
    expect(maxSeverity(['critical', 'critical', 'critical'])).toBe('critical');
  });

  it('🚨 singleton', () => {
    expect(maxSeverity(['critical'])).toBe('critical');
    expect(maxSeverity(['warning'])).toBe('warning');
  });

  it('🚨 array vuoto → null', () => {
    expect(maxSeverity([])).toBeNull();
  });
});

describe('🚨 severityLabel — i18n IT', () => {
  it('🚨 critical → "Critica"', () => {
    expect(severityLabel('critical')).toBe('Critica');
  });

  it('🚨 warning → "Avviso"', () => {
    expect(severityLabel('warning')).toBe('Avviso');
  });
});

describe('🚨 severityColor — Tailwind hex', () => {
  it('🚨 critical → red-600', () => {
    expect(severityColor('critical')).toBe('#dc2626');
  });

  it('🚨 warning → amber-600', () => {
    expect(severityColor('warning')).toBe('#d97706');
  });

  it('🚨 valid CSS hex format (7 char)', () => {
    expect(severityColor('critical')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(severityColor('warning')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
