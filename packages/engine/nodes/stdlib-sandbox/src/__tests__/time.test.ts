/**
 * Test time helpers.
 *
 * @module sandbox/__tests__/time
 */
import { describe, it, expect } from 'vitest';
import {
  nowIso, fromIso, toIso,
  addDays, addHours, addMinutes, addSeconds,
  diffSeconds, diffDays,
  toDateString, toTimeString,
  startOfDay, endOfDay,
} from '../time.js';

describe('nowIso', () => {
  it('ritorna ISO 8601 valido parsabile', () => {
    const s = nowIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(s).toISOString()).toBe(s);
  });
});

describe('fromIso', () => {
  it('happy', () => {
    const d = fromIso('2026-06-08T12:30:00Z');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(5); // June (0-indexed)
    expect(d.getUTCDate()).toBe(8);
  });

  it('🚨 invalid throw', () => {
    expect(() => fromIso('not a date')).toThrow(/Invalid/);
  });
});

describe('add helpers', () => {
  const base = new Date('2026-06-08T12:00:00Z');

  it('addDays: +1 day', () => {
    expect(toIso(addDays(base, 1))).toBe('2026-06-09T12:00:00.000Z');
  });

  it('🚨 addDays cross month', () => {
    expect(toIso(addDays(new Date('2026-06-30T12:00:00Z'), 1))).toBe('2026-07-01T12:00:00.000Z');
  });

  it('🚨 addDays cross year', () => {
    expect(toIso(addDays(new Date('2026-12-31T12:00:00Z'), 1))).toBe('2027-01-01T12:00:00.000Z');
  });

  it('addHours: +5h', () => {
    expect(toIso(addHours(base, 5))).toBe('2026-06-08T17:00:00.000Z');
  });

  it('addMinutes: +90', () => {
    expect(toIso(addMinutes(base, 90))).toBe('2026-06-08T13:30:00.000Z');
  });

  it('addSeconds: +3600', () => {
    expect(toIso(addSeconds(base, 3600))).toBe('2026-06-08T13:00:00.000Z');
  });

  it('🚨 negative valid', () => {
    expect(toIso(addDays(base, -1))).toBe('2026-06-07T12:00:00.000Z');
  });
});

describe('diff helpers', () => {
  it('diffSeconds', () => {
    expect(diffSeconds(
      new Date('2026-06-08T12:01:30Z'),
      new Date('2026-06-08T12:00:00Z'),
    )).toBe(90);
  });

  it('diffDays', () => {
    expect(diffDays(
      new Date('2026-06-15T12:00:00Z'),
      new Date('2026-06-08T12:00:00Z'),
    )).toBe(7);
  });

  it('🚨 diff negative se a < b', () => {
    expect(diffSeconds(new Date('2026-06-08T12:00:00Z'), new Date('2026-06-08T12:01:00Z'))).toBe(-60);
  });
});

describe('format helpers', () => {
  it('toDateString', () => {
    expect(toDateString(new Date('2026-06-08T23:30:00Z'))).toBe('2026-06-08');
  });

  it('toTimeString', () => {
    expect(toTimeString(new Date('2026-06-08T13:45:09Z'))).toBe('13:45:09');
  });

  it('🚨 pad-left zero', () => {
    expect(toDateString(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});

describe('boundary', () => {
  it('startOfDay → 00:00:00.000Z', () => {
    const r = startOfDay(new Date('2026-06-08T15:30:42Z'));
    expect(toIso(r)).toBe('2026-06-08T00:00:00.000Z');
  });

  it('endOfDay → 23:59:59.999Z', () => {
    const r = endOfDay(new Date('2026-06-08T05:30:00Z'));
    expect(toIso(r)).toBe('2026-06-08T23:59:59.999Z');
  });
});
