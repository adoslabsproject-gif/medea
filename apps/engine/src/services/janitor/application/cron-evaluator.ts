/**
 * Cron expression evaluator — minimal, deterministic, no deps.
 *
 * Supporta la sintassi cron standard 5-field: `m h d M w`.
 * Pattern supportati per ogni field:
 *   • `*`           → any value
 *   • `N`           → exact match
 *   • `N-M`         → range inclusive
 *   • `N,M`         → list (es. `1,15`)
 *   • `* /N` (no space) → step
 *   • `N-M/S`       → step in range
 *
 * Non supportato (per ora):
 *   • `?` (Quartz)
 *   • alias `@daily`, `@hourly` — usa il canonical equivalent
 *   • weekday names ('mon', 'tue', ...) — usa 0-6 (0=Sun, 7=Sun)
 *
 * Federico-grade: zero dipendenze, zero side effects, completamente
 * testabile. Niente cron-parser library (sono pesanti + 50KB di
 * locale data che non ci servono).
 */

export interface CronExpression {
  readonly raw: string;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

const MINUTES_MAX = 60;
const HOURS_MAX = 24;
const DAY_MAX = 31;
const MONTH_MAX = 12;
const DOW_MAX = 7;

export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression "${expression}" deve avere 5 campi (m h d M w), trovati ${fields.length.toString()}`);
  }
  const [minRaw, hourRaw, dayRaw, monthRaw, dowRaw] = fields as [string, string, string, string, string];
  return Object.freeze({
    raw: expression.trim(),
    minute: Object.freeze(parseField(minRaw, 0, MINUTES_MAX - 1, 'minute')),
    hour: Object.freeze(parseField(hourRaw, 0, HOURS_MAX - 1, 'hour')),
    dayOfMonth: Object.freeze(parseField(dayRaw, 1, DAY_MAX, 'day')),
    month: Object.freeze(parseField(monthRaw, 1, MONTH_MAX, 'month')),
    dayOfWeek: Object.freeze(parseField(dowRaw, 0, DOW_MAX - 1, 'dayOfWeek', { mapMax: 7 })),
  });
}

function parseField(
  raw: string,
  min: number,
  max: number,
  fieldName: string,
  opts: { mapMax?: number } = {},
): Set<number> {
  const out = new Set<number>();
  for (const segment of raw.split(',')) {
    addSegment(segment.trim(), min, max, fieldName, out);
  }
  // Day of week: 7 ≡ 0 (Sun). Normalizza.
  if (opts.mapMax === 7 && out.has(7)) {
    out.delete(7);
    out.add(0);
  }
  return out;
}

function addSegment(seg: string, min: number, max: number, fieldName: string, out: Set<number>): void {
  // Step form `*/N` or `A-B/N`
  let stepStr: string | null = null;
  let rangePart = seg;
  if (seg.includes('/')) {
    const parts = seg.split('/');
    if (parts.length !== 2) throw new Error(`Cron ${fieldName}: step invalido "${seg}"`);
    rangePart = parts[0]!;
    stepStr = parts[1]!;
  }
  const step = stepStr === null ? 1 : Number.parseInt(stepStr, 10);
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Cron ${fieldName}: step deve essere intero positivo, "${stepStr ?? ''}" ricevuto`);
  }
  let from: number;
  let to: number;
  if (rangePart === '*') {
    from = min;
    to = max;
  } else if (rangePart.includes('-')) {
    const [aStr, bStr] = rangePart.split('-');
    from = Number.parseInt(aStr!, 10);
    to = Number.parseInt(bStr!, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error(`Cron ${fieldName}: range invalido "${rangePart}"`);
    }
  } else {
    from = to = Number.parseInt(rangePart, 10);
    if (!Number.isInteger(from)) {
      throw new Error(`Cron ${fieldName}: valore invalido "${rangePart}"`);
    }
  }
  if (from < min || to > max) {
    throw new Error(`Cron ${fieldName}: out-of-range ${from.toString()}-${to.toString()} (atteso ${min.toString()}-${max.toString()})`);
  }
  for (let i = from; i <= to; i += step) out.add(i);
}

/**
 * Determina se `at` Date soddisfa la cron expression.
 *
 * NB: usiamo UTC. Per cron sensitive al fuso orario locale, il caller
 * deve aggiustare offset prima di passare la Date.
 */
export function cronMatches(expr: CronExpression, at: Date): boolean {
  if (!expr.minute.has(at.getUTCMinutes())) return false;
  if (!expr.hour.has(at.getUTCHours())) return false;
  if (!expr.dayOfMonth.has(at.getUTCDate())) return false;
  if (!expr.month.has(at.getUTCMonth() + 1)) return false;
  if (!expr.dayOfWeek.has(at.getUTCDay())) return false;
  return true;
}

/**
 * Validazione: ritorna null se OK, message di errore altrimenti.
 * Usato nelle route per validare l'input UI prima di salvare.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'cron invalida';
  }
}
