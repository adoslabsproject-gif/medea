/**
 * Bucketing temporale per `logic_window` — finestre di CALENDARIO timezone-aware
 * (tumbling window), senza dipendenze: solo `Intl.DateTimeFormat` (Node 22).
 *
 * A differenza delle finestre a durata fissa (windowSeconds, gestite nel nodo),
 * le granularità di calendario rispettano i confini civili nella timezone scelta:
 *   • minute / hour → tronca al minuto/ora locale;
 *   • day           → mezzanotte locale;
 *   • week          → lunedì (ISO 8601) o domenica della settimana locale;
 *   • month         → primo del mese locale (mesi reali 28-31gg, cambio anno).
 *
 * Il bordo è restituito come epoch-ms UTC. La conversione "ora locale → UTC" usa
 * un doppio-guess dell'offset, così i bordi restano corretti attraverso le
 * transizioni di ora legale/solare (DST), che cambiano l'offset 2 volte l'anno.
 */

export type CalendarGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month';

interface TzParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_MS = 86_400_000;

function tzParts(epochMs: number, timeZone: string): TzParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: WEEKDAY[get('weekday')] ?? 0,
  };
}

/** Offset (ms) della timezone rispetto a UTC nell'istante dato (positivo = avanti). */
function offsetAt(epochMs: number, timeZone: string): number {
  const p = tzParts(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epochMs;
}

/** Converte una data/ora "civile" (nella timezone) in epoch-ms UTC, DST-safe. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = offsetAt(guess, timeZone);
  const utc = guess - off1;
  const off2 = offsetAt(utc, timeZone);
  // Su una transizione DST il primo offset può essere sbagliato: il secondo guess lo corregge.
  return off2 === off1 ? utc : guess - off2;
}

/** Valida un identificatore IANA; timezone ignota → 'UTC' (fail-soft, mai throw nel run). */
export function normalizeTimeZone(tz: unknown): string {
  const candidate = typeof tz === 'string' && tz.trim() !== '' ? tz.trim() : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/** Epoch-ms del bordo iniziale del bucket che contiene `epochMs`, nella granularità data. */
export function bucketStart(
  epochMs: number,
  granularity: CalendarGranularity,
  timeZone: string,
  weekStartsMonday = true,
): number {
  const p = tzParts(epochMs, timeZone);
  switch (granularity) {
    case 'minute': return zonedToUtc(p.year, p.month, p.day, p.hour, p.minute, 0, timeZone);
    case 'hour': return zonedToUtc(p.year, p.month, p.day, p.hour, 0, 0, timeZone);
    case 'day': return zonedToUtc(p.year, p.month, p.day, 0, 0, 0, timeZone);
    case 'month': return zonedToUtc(p.year, p.month, 1, 0, 0, 0, timeZone);
    case 'week': {
      const back = weekStartsMonday ? (p.weekday + 6) % 7 : p.weekday;
      const midnight = zonedToUtc(p.year, p.month, p.day, 0, 0, 0, timeZone);
      // Sottrae `back` giorni civili, poi ri-tronca a mezzanotte locale (il giorno
      // di partenza della settimana può avere un offset DST diverso da oggi).
      const earlier = tzParts(midnight - back * DAY_MS, timeZone);
      return zonedToUtc(earlier.year, earlier.month, earlier.day, 0, 0, 0, timeZone);
    }
  }
}
