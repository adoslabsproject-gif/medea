import { describe, it, expect } from 'vitest';
import { SchedulerService } from './scheduler.service.js';

describe('SchedulerService.matchesCron', () => {
  const matches = SchedulerService.matchesCron;

  // matchesCron valuta i campi nella timezone passata (default 'UTC', AUDIT WE-5).
  // I test usano date UTC ESPLICITE (suffisso Z) → deterministici in QUALSIASI
  // fuso della macchina di CI/dev. Senza Z, `new Date('...09:00')` è ora locale
  // e in un fuso ≠ UTC non coincide con l'ora valutata in UTC.

  it('every-minute wildcard', () => {
    expect(matches('* * * * *', new Date('2026-05-19T10:30:00Z'))).toBe(true);
  });

  it('exact minute', () => {
    expect(matches('30 * * * *', new Date('2026-05-19T10:30:00Z'))).toBe(true);
    expect(matches('30 * * * *', new Date('2026-05-19T10:31:00Z'))).toBe(false);
  });

  it('exact hour', () => {
    expect(matches('0 9 * * *', new Date('2026-05-19T09:00:00Z'))).toBe(true);
    expect(matches('0 9 * * *', new Date('2026-05-19T10:00:00Z'))).toBe(false);
  });

  it('step every 15 minutes', () => {
    expect(matches('*/15 * * * *', new Date('2026-05-19T10:00:00Z'))).toBe(true);
    expect(matches('*/15 * * * *', new Date('2026-05-19T10:15:00Z'))).toBe(true);
    expect(matches('*/15 * * * *', new Date('2026-05-19T10:30:00Z'))).toBe(true);
    expect(matches('*/15 * * * *', new Date('2026-05-19T10:14:00Z'))).toBe(false);
  });

  it('list of minutes', () => {
    expect(matches('0,30 * * * *', new Date('2026-05-19T10:00:00Z'))).toBe(true);
    expect(matches('0,30 * * * *', new Date('2026-05-19T10:30:00Z'))).toBe(true);
    expect(matches('0,30 * * * *', new Date('2026-05-19T10:15:00Z'))).toBe(false);
  });

  it('invalid expression', () => {
    expect(matches('not a cron', new Date())).toBe(false);
    expect(matches('* * *', new Date())).toBe(false);
  });

  // ── Copertura della feature timezone-aware (WE-5) — prima non testata ──────
  describe('timezone-aware (WE-5)', () => {
    it('🚨 stesso istante UTC, ora diversa per timezone diversa', () => {
      // 07:00 UTC = 09:00 a Roma (CEST, +2 a maggio).
      const instant = new Date('2026-05-19T07:00:00Z');
      expect(matches('0 9 * * *', instant, 'Europe/Rome')).toBe(true); // 09:00 locale Roma
      expect(matches('0 9 * * *', instant, 'UTC')).toBe(false); // 07:00 UTC
      expect(matches('0 7 * * *', instant, 'UTC')).toBe(true);
    });

    it('🚨 timezone sfasa anche il giorno (cron giornaliero a cavallo di mezzanotte)', () => {
      // 23:30 UTC del 19 = 01:30 del 20 a Roma.
      const lateNight = new Date('2026-05-19T23:30:00Z');
      // "30 1 * * 3" = mercoledì 01:30. Il 20 maggio 2026 è mercoledì.
      expect(matches('30 1 * * 3', lateNight, 'Europe/Rome')).toBe(true);
      // In UTC è ancora martedì 19 (giorno 2) alle 23:30 → non match.
      expect(matches('30 1 * * 3', lateNight, 'UTC')).toBe(false);
    });

    it('default timezone è UTC quando non specificata', () => {
      const instant = new Date('2026-05-19T07:00:00Z');
      expect(matches('0 7 * * *', instant)).toBe(true);
    });
  });
});
