/**
 * Time helpers — ISO 8601, add/sub, diff.
 *
 * NB: no `Date.now` policy — uso esplicito di Date constructor che vendor
 * sandbox può chiamare (l'host fornisce Date deterministico nei test).
 *
 * @module sandbox/time
 */

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse ISO 8601 → Date. Throw se invalid. */
export function fromIso(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${iso}`);
  return d;
}

export function toIso(d: Date): string {
  return d.toISOString();
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3600 * 1000);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60 * 1000);
}

export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}

export function diffSeconds(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 1000);
}

export function diffDays(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 86400));
}

/** Format Date as `YYYY-MM-DD`. */
export function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

/** Format Date as `HH:MM:SS`. */
export function toTimeString(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}
