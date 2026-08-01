/**
 * Test REALI di action_datetime — eseguono l'executor vero (Date + Intl), niente
 * stub. Coprono parsing epoch/ISO, add/subtract con mesi e bisestili, diff,
 * formattazione locale italiana e i guard di errore.
 */
import { describe, it, expect } from 'vitest';
import { datetimeNode } from './datetime.js';

const dt = datetimeNode.executor!;
const ctx = {} as never;

describe('action_datetime', () => {
  it('now → iso + epoch coerenti', async () => {
    const r = await dt({ operation: 'now' }, undefined, ctx);
    const o = r.output as { iso: string; epochMs: number; epochSec: number };
    expect(o.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Math.abs(o.epochMs - Date.now())).toBeLessThan(2000);
    expect(o.epochSec).toBe(Math.floor(o.epochMs / 1000));
  });
  it('add giorni', async () => {
    const r = await dt({ operation: 'add', date: '2026-01-01T00:00:00Z', amount: '30', unit: 'days' }, undefined, ctx);
    expect((r.output as { iso: string }).iso).toBe('2026-01-31T00:00:00.000Z');
  });
  it('🚨 add mesi CLAMPa al giorno valido (no overflow): 31 gen +1 mese → FEBBRAIO, non marzo', async () => {
    const r = await dt({ operation: 'add', date: '2026-01-31T12:00:00Z', amount: '1', unit: 'months' }, undefined, ctx);
    // MUTATION: col vecchio setMonth diretto "31 feb" rotolava a 2026-03 → rosso.
    expect((r.output as { iso: string }).iso.startsWith('2026-02')).toBe(true);
  });
  it('🚨 add mesi su anno bisestile: 31 gen 2024 +1 mese → 29 feb', async () => {
    const r = await dt({ operation: 'add', date: '2024-01-31T12:00:00Z', amount: '1', unit: 'months' }, undefined, ctx);
    expect((r.output as { iso: string }).iso.startsWith('2024-02-29')).toBe(true);
  });
  it('🚨 add anni clampa il 29 feb: 29 feb 2024 +1 anno → 28 feb 2025 (non 1 marzo)', async () => {
    const r = await dt({ operation: 'add', date: '2024-02-29T12:00:00Z', amount: '1', unit: 'years' }, undefined, ctx);
    expect((r.output as { iso: string }).iso.startsWith('2025-02-28')).toBe(true);
  });
  it('add mesi caso normale (giorno valido) → preservato: 15 gen +1 mese → 15 feb', async () => {
    const r = await dt({ operation: 'add', date: '2026-01-15T12:00:00Z', amount: '1', unit: 'months' }, undefined, ctx);
    expect((r.output as { iso: string }).iso.startsWith('2026-02-15')).toBe(true);
  });
  it('subtract sottrae', async () => {
    const r = await dt({ operation: 'subtract', date: '2026-06-10T12:00:00Z', amount: '10', unit: 'days' }, undefined, ctx);
    expect((r.output as { iso: string }).iso).toBe('2026-05-31T12:00:00.000Z');
  });
  it('diff in giorni', async () => {
    const r = await dt({ operation: 'diff', date: '2026-01-01T00:00:00Z', dateB: '2026-01-11T00:00:00Z', unit: 'days' }, undefined, ctx);
    expect((r.output as { value: number; rounded: number }).rounded).toBe(10);
  });
  it('diff in mesi', async () => {
    const r = await dt({ operation: 'diff', date: '2026-01-15T00:00:00Z', dateB: '2026-04-15T00:00:00Z', unit: 'months' }, undefined, ctx);
    expect((r.output as { value: number }).value).toBe(3);
  });
  it('parse epoch secondi (10 cifre)', async () => {
    const r = await dt({ operation: 'format', date: '1735689600', preset: 'iso' }, undefined, ctx);
    expect((r.output as { formatted: string }).formatted).toBe('2025-01-01T00:00:00.000Z');
  });
  it('parse epoch millisecondi (13 cifre)', async () => {
    const r = await dt({ operation: 'format', date: '1735689600000', preset: 'iso' }, undefined, ctx);
    expect((r.output as { formatted: string }).formatted).toBe('2025-01-01T00:00:00.000Z');
  });
  it('format locale italiano → mese in italiano', async () => {
    const r = await dt({ operation: 'format', date: '2026-03-15T10:00:00Z', preset: 'date', locale: 'it-IT', timezone: 'Europe/Rome' }, undefined, ctx);
    expect((r.output as { formatted: string }).formatted).toContain('mar'); // "15 mar 2026"
  });
  it('format weekday in italiano', async () => {
    const r = await dt({ operation: 'format', date: '2026-06-06T10:00:00Z', preset: 'date', locale: 'it-IT' }, undefined, ctx);
    expect((r.output as { weekday: string }).weekday).toBe('sabato'); // 2026-06-06 è sabato
  });
  it('format relative → "fa" per il passato', async () => {
    const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const r = await dt({ operation: 'format', date: past, preset: 'relative', locale: 'it-IT' }, undefined, ctx);
    expect((r.output as { formatted: string }).formatted).toContain('fa');
  });
  it('data non valida → throw', async () => {
    await expect(dt({ operation: 'format', date: 'non-una-data' }, undefined, ctx)).rejects.toThrow(/non valida/);
  });
  it('"now" come stringa data', async () => {
    const r = await dt({ operation: 'format', date: 'now', preset: 'iso' }, undefined, ctx);
    expect(Math.abs(new Date((r.output as { formatted: string }).formatted).getTime() - Date.now())).toBeLessThan(2000);
  });
});
