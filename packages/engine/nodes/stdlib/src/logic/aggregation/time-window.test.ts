/**
 * Test bug-bounty — bucketing temporale di calendario timezone-aware.
 * Cuore: i confini civili (giorno/settimana/mese) calcolati nella timezone scelta,
 * con correttezza ATTRAVERSO le transizioni DST. Mutation-verify: se il bucketing
 * tornasse a UTC-only, i casi Europe/Rome (offset +1/+2) diventano rossi.
 */
import { describe, it, expect } from 'vitest';
import { bucketStart, normalizeTimeZone } from './time-window.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('bucketStart — UTC', () => {
  it('day → mezzanotte UTC', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T12:30:00Z'), 'day', 'UTC'))).toBe('2026-05-20T00:00:00.000Z');
  });
  it('hour → inizio ora UTC', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T12:45:30Z'), 'hour', 'UTC'))).toBe('2026-05-20T12:00:00.000Z');
  });
  it('minute → inizio minuto UTC', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T12:45:30Z'), 'minute', 'UTC'))).toBe('2026-05-20T12:45:00.000Z');
  });
  it('month → primo del mese UTC', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T12:30:00Z'), 'month', 'UTC'))).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('bucketStart — Europe/Rome (timezone-aware)', () => {
  it('🚨 day: mezzanotte LOCALE, non UTC (estate CEST = UTC+2)', () => {
    // 01:30Z del 20/5 = 03:30 locale → giorno locale = 20/5 → mezzanotte locale = 19/5 22:00Z
    expect(iso(bucketStart(Date.parse('2026-05-20T01:30:00Z'), 'day', 'Europe/Rome'))).toBe('2026-05-19T22:00:00.000Z');
  });
  it('🚨 day: due istanti dello STESSO giorno locale → stesso bucket (anche se UTC li separa)', () => {
    const a = bucketStart(Date.parse('2026-05-19T23:30:00Z'), 'day', 'Europe/Rome'); // 01:30 locale 20/5
    const b = bucketStart(Date.parse('2026-05-20T20:00:00Z'), 'day', 'Europe/Rome'); // 22:00 locale 20/5
    expect(iso(a)).toBe('2026-05-19T22:00:00.000Z');
    expect(a).toBe(b);
  });
  it('🚨 day in INVERNO (CET = UTC+1) → offset diverso dall\'estate', () => {
    // gennaio: CET = UTC+1 → mezzanotte locale 15/1 = 14/1 23:00Z
    expect(iso(bucketStart(Date.parse('2026-01-15T10:00:00Z'), 'day', 'Europe/Rome'))).toBe('2026-01-14T23:00:00.000Z');
  });
  it('🚨 DST: il giorno della transizione marzo (CET→CEST) resta un confine di mezzanotte valido', () => {
    // 2026-03-29 l'Italia passa a CEST. Un evento del 30/3 → mezzanotte locale 30/3 = 29/3 22:00Z (già CEST)
    expect(iso(bucketStart(Date.parse('2026-03-30T12:00:00Z'), 'day', 'Europe/Rome'))).toBe('2026-03-29T22:00:00.000Z');
  });
  it('month: primo del mese locale', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T01:30:00Z'), 'month', 'Europe/Rome'))).toBe('2026-04-30T22:00:00.000Z');
  });
});

describe('bucketStart — week (lunedì ISO vs domenica)', () => {
  // 2026-05-20 è un MERCOLEDÌ.
  it('week monday → lunedì 18/5 (UTC)', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T12:00:00Z'), 'week', 'UTC', true))).toBe('2026-05-18T00:00:00.000Z');
  });
  it('week sunday → domenica 17/5 (UTC)', () => {
    expect(iso(bucketStart(Date.parse('2026-05-20T12:00:00Z'), 'week', 'UTC', false))).toBe('2026-05-17T00:00:00.000Z');
  });
  it('tutti i giorni della stessa settimana cadono nello stesso bucket lunedì', () => {
    const mon = bucketStart(Date.parse('2026-05-18T08:00:00Z'), 'week', 'UTC', true);
    const sun = bucketStart(Date.parse('2026-05-24T23:00:00Z'), 'week', 'UTC', true);
    expect(iso(mon)).toBe('2026-05-18T00:00:00.000Z');
    expect(mon).toBe(sun);
  });
});

describe('normalizeTimeZone', () => {
  it('IANA valida → invariata', () => {
    expect(normalizeTimeZone('Europe/Rome')).toBe('Europe/Rome');
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
  });
  it('🛡️ timezone ignota / vuota / non-stringa → UTC (fail-soft, no throw)', () => {
    expect(normalizeTimeZone('Bogus/Nowhere')).toBe('UTC');
    expect(normalizeTimeZone('')).toBe('UTC');
    expect(normalizeTimeZone(undefined)).toBe('UTC');
    expect(normalizeTimeZone(42)).toBe('UTC');
  });
});
