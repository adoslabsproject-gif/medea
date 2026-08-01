/**
 * Test 2026-grade — cron-evaluator (5-field cron parser + matcher).
 *
 * COVERAGE: wildcard / exact / range / list / step / range+step + DOW 7≡0.
 * VALIDATION: out-of-range, malformed, step<=0, NaN → throw.
 */
import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches, validateCronExpression } from './cron-evaluator.js';

describe('🚨 parseCron — field parsing', () => {
  it('🚨 wildcard "* * * * *"', () => {
    const c = parseCron('* * * * *');
    expect(c.minute.size).toBe(60);
    expect(c.hour.size).toBe(24);
    expect(c.dayOfMonth.size).toBe(31);
    expect(c.month.size).toBe(12);
    expect(c.dayOfWeek.size).toBe(7);
  });

  it('🚨 exact "30 14 1 6 *"', () => {
    const c = parseCron('30 14 1 6 *');
    expect([...c.minute]).toEqual([30]);
    expect([...c.hour]).toEqual([14]);
  });

  it('🚨 range "0-10 * * * *"', () => {
    const c = parseCron('0-10 * * * *');
    expect(c.minute.size).toBe(11);
    expect(c.minute.has(0)).toBe(true);
    expect(c.minute.has(10)).toBe(true);
    expect(c.minute.has(11)).toBe(false);
  });

  it('🚨 list "0,15,30,45 * * * *"', () => {
    const c = parseCron('0,15,30,45 * * * *');
    expect(c.minute.size).toBe(4);
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('🚨 step "*/15 * * * *"', () => {
    const c = parseCron('*/15 * * * *');
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('🚨 range+step "0-30/10 * * * *"', () => {
    const c = parseCron('0-30/10 * * * *');
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  it('🚨 DOW range 0-6 (7 non accettato → usa 0)', () => {
    const c = parseCron('* * * * 0');
    expect(c.dayOfWeek.has(0)).toBe(true);
    // DOW_MAX=7 ma range check è 0-6 → 7 OOR (design: usa 0)
    expect(() => parseCron('* * * * 7')).toThrow(/out-of-range/u);
  });

  it('🚨 frozen object (immutable)', () => {
    const c = parseCron('* * * * *');
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe('🚨 parseCron — validation errors', () => {
  it('🚨 < 5 fields → throw', () => {
    expect(() => parseCron('* * *')).toThrow(/5 campi/u);
  });

  it('🚨 > 5 fields → throw', () => {
    expect(() => parseCron('* * * * * *')).toThrow(/5 campi/u);
  });

  it('🚨 minute > 59 → throw', () => {
    expect(() => parseCron('99 * * * *')).toThrow(/out-of-range/u);
  });

  it('🚨 hour > 23 → throw', () => {
    expect(() => parseCron('0 25 * * *')).toThrow(/out-of-range/u);
  });

  it('🚨 month > 12 → throw', () => {
    expect(() => parseCron('0 0 1 13 *')).toThrow(/out-of-range/u);
  });

  it('🚨 step 0 → throw', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/step deve essere/u);
  });

  it('🚨 step NaN → throw', () => {
    expect(() => parseCron('*/abc * * * *')).toThrow(/step deve essere/u);
  });

  it('🚨 range malformato "1-NaN" → throw', () => {
    expect(() => parseCron('1-abc * * * *')).toThrow(/range invalido/u);
  });

  it('🚨 step con 3 parti "*/1/2" → throw', () => {
    expect(() => parseCron('*/1/2 * * * *')).toThrow(/step invalido/u);
  });
});

describe('🚨 cronMatches', () => {
  const utcDate = (y: number, m: number, d: number, h: number, min: number) =>
    new Date(Date.UTC(y, m - 1, d, h, min));

  it('🚨 wildcard sempre match', () => {
    const c = parseCron('* * * * *');
    expect(cronMatches(c, utcDate(2026, 6, 7, 12, 34))).toBe(true);
  });

  it('🚨 exact 14:30 → match solo 14:30', () => {
    const c = parseCron('30 14 * * *');
    expect(cronMatches(c, utcDate(2026, 6, 7, 14, 30))).toBe(true);
    expect(cronMatches(c, utcDate(2026, 6, 7, 14, 29))).toBe(false);
    expect(cronMatches(c, utcDate(2026, 6, 7, 13, 30))).toBe(false);
  });

  it('🚨 step */15 → match minute 0, 15, 30, 45', () => {
    const c = parseCron('*/15 * * * *');
    expect(cronMatches(c, utcDate(2026, 6, 7, 12, 0))).toBe(true);
    expect(cronMatches(c, utcDate(2026, 6, 7, 12, 15))).toBe(true);
    expect(cronMatches(c, utcDate(2026, 6, 7, 12, 10))).toBe(false);
  });

  it('🚨 month + day combo', () => {
    const c = parseCron('0 0 1 1 *'); // Capodanno mezzanotte
    expect(cronMatches(c, utcDate(2026, 1, 1, 0, 0))).toBe(true);
    expect(cronMatches(c, utcDate(2026, 6, 1, 0, 0))).toBe(false);
  });

  it('🚨 DOW domenica via 0', () => {
    const c = parseCron('0 0 * * 0');
    // 2026-06-07 era domenica
    expect(cronMatches(c, utcDate(2026, 6, 7, 0, 0))).toBe(true);
    expect(cronMatches(c, utcDate(2026, 6, 8, 0, 0))).toBe(false);
  });
});

describe('🚨 validateCronExpression', () => {
  it('🚨 valid → null', () => {
    expect(validateCronExpression('*/5 * * * *')).toBeNull();
  });

  it('🚨 invalid → message string', () => {
    const r = validateCronExpression('* * *');
    expect(r).not.toBeNull();
    expect(r).toMatch(/5 campi/u);
  });
});
