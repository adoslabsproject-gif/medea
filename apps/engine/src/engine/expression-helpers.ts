/**
 * Expression helpers — parità n8n + SUPERIORITÀ.
 *
 * n8n espone $json/$items/$itemIndex/$runIndex/$workflow/$execution/$if/Luxon.
 * Noi facciamo PARITÀ su questi accessor (usando il context che l'engine già
 * porta: input/loop/ctx) e li superiamo con:
 *   - helper aggregati robusti ($sum/$avg/$min/$max/$unique/$flatten) che NON
 *     crashano su input non-array (n8n spesso throwa);
 *   - $get(obj, "a.b[0].c", default) — deep path safe (no optional-chaining hell);
 *   - $date — date math senza dipendenze (plus/minus/diff/format/startOf +
 *     isWeekend/addBusinessDays che n8n non ha out-of-the-box);
 *   - tutto dentro la sandbox `assertSafeExpression` (no require/process/ctor) —
 *     n8n valuta le espressioni con più accesso: noi siamo PIÙ sicuri.
 *
 * FASE-2 (2026-06-12) — parità PIENA con le superfici dichiarate da n8n:
 *   - `$jmespath(data, query)` con la libreria jmespath VERA (la stessa di
 *     n8n): interprete dichiarativo puro, niente codice arbitrario → la
 *     sandbox non si allarga.
 *   - Luxon VERO esposto come `DateTime` e `Duration` (le espressioni n8n
 *     `DateTime.now().setZone('Europe/Rome').toISO()` girano IDENTICHE qui —
 *     timezone/locale compresi, dove il nostro $date è volutamente UTC-only).
 *     Luxon è puro (zero IO); l'accesso a `constructor`/proto resta bloccato
 *     dalla denylist dell'interpreter sul source dell'espressione.
 *
 * Modulo quasi-PURO (jmespath/luxon sono librerie pure, nessun side-effect,
 * nessun logger) → testabile in isolamento e zero blast-radius sui mock.
 * Gli helper degradano gracefully su context assente.
 */
import { coerceString } from '@/lib/coerce.js';
import jmespath from 'jmespath';
// `Duration as LuxonDuration`: il type locale `Duration` (shape {days,hours,…}
// del $date senza dipendenze) preesiste — il binding ESPOSTO alle espressioni
// resta `Duration` (parità n8n), solo l'alias interno cambia.
import { DateTime, Duration as LuxonDuration } from 'luxon';
import type { LoopContext } from './interpreter.js';

export interface ExpressionContext {
  /** Dato corrente in ingresso al nodo (n8n `$json`). */
  input?: unknown;
  /** Array di tutti gli item in ingresso (n8n `$items`). Derivato da input se assente. */
  items?: unknown[] | undefined;
  /** Context loop (se dentro un logic_loop). */
  loop?: LoopContext | undefined;
  /** Metadati workflow. */
  workflow?: { id?: string; name?: string } | undefined;
  /** Metadati esecuzione/run. */
  execution?: { id?: string; mode?: string; startedAt?: string } | undefined;
}

// ─── utility interne (pure) ──────────────────────────────────────────────────

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** Deep-get safe: `$get(obj, "a.b[0].c", fallback)`. Mai throwa. */
function deepGet(obj: unknown, path: string, fallback: unknown = undefined): unknown {
  if (typeof path !== 'string' || path === '') return fallback;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1') // a[0].b → a.0.b
    .split('.')
    .filter((p) => p !== '');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return fallback;
    if (typeof cur !== 'object') return fallback;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? fallback : cur;
}

// ─── $date — date math pure (no luxon dep) ───────────────────────────────────

const PAD = (n: number, w = 2): string => String(Math.abs(Math.trunc(n))).padStart(w, '0');

function parseDate(v: unknown): Date {
  if (v instanceof Date) return new Date(v.getTime());
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

interface Duration {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

function shift(v: unknown, dur: Duration, sign: 1 | -1): string {
  const d = parseDate(v);
  if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + sign * dur.years);
  if (dur.months) d.setUTCMonth(d.getUTCMonth() + sign * dur.months);
  if (dur.days) d.setUTCDate(d.getUTCDate() + sign * dur.days);
  if (dur.hours) d.setUTCHours(d.getUTCHours() + sign * dur.hours);
  if (dur.minutes) d.setUTCMinutes(d.getUTCMinutes() + sign * dur.minutes);
  if (dur.seconds) d.setUTCSeconds(d.getUTCSeconds() + sign * dur.seconds);
  return d.toISOString();
}

type DateUnit = 'days' | 'hours' | 'minutes' | 'seconds' | 'weeks';
const UNIT_MS: Record<DateUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

export interface DateHelper {
  now(): string;
  today(): string;
  plus(date: unknown, dur: Duration): string;
  minus(date: unknown, dur: Duration): string;
  diff(a: unknown, b: unknown, unit?: DateUnit): number;
  format(date: unknown, pattern: string): string;
  startOf(date: unknown, unit: 'day' | 'month' | 'year'): string;
  isWeekend(date: unknown): boolean;
  addBusinessDays(date: unknown, n: number): string;
}

const dateHelper: DateHelper = {
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  plus: (date, dur) => shift(date, dur, 1),
  minus: (date, dur) => shift(date, dur, -1),
  diff: (a, b, unit = 'days') => {
    const ms = parseDate(a).getTime() - parseDate(b).getTime();
    return ms / UNIT_MS[unit];
  },
  format: (date, pattern) => {
    const d = parseDate(date);
    const map: Record<string, string> = {
      YYYY: String(d.getUTCFullYear()),
      MM: PAD(d.getUTCMonth() + 1),
      DD: PAD(d.getUTCDate()),
      HH: PAD(d.getUTCHours()),
      mm: PAD(d.getUTCMinutes()),
      ss: PAD(d.getUTCSeconds()),
    };
    return String(pattern).replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => map[t] ?? t);
  },
  startOf: (date, unit) => {
    const d = parseDate(date);
    d.setUTCHours(0, 0, 0, 0);
    if (unit === 'month') d.setUTCDate(1);
    if (unit === 'year') {
      d.setUTCMonth(0);
      d.setUTCDate(1);
    }
    return d.toISOString();
  },
  isWeekend: (date) => {
    const day = parseDate(date).getUTCDay();
    return day === 0 || day === 6;
  },
  addBusinessDays: (date, n) => {
    const d = parseDate(date);
    let remaining = Math.trunc(n);
    const step = remaining >= 0 ? 1 : -1;
    remaining = Math.abs(remaining);
    while (remaining > 0) {
      d.setUTCDate(d.getUTCDate() + step);
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) remaining--;
    }
    return d.toISOString();
  },
};

// ─── bindings esposti nello scope ────────────────────────────────────────────

export interface ExpressionHelperBindings {
  $json: unknown;
  $items: unknown[];
  $itemIndex: number;
  $runIndex: number;
  $first: boolean;
  $last: boolean;
  $itemCount: number;
  $workflow: { id: string; name: string };
  $execution: { id: string; mode: string; startedAt: string };
  $if: (cond: unknown, then: unknown, els: unknown) => unknown;
  $ifEmpty: (val: unknown, fallback: unknown) => unknown;
  $isEmpty: (val: unknown) => boolean;
  $get: (obj: unknown, path: string, fallback?: unknown) => unknown;
  $min: (arr: unknown) => number;
  $max: (arr: unknown) => number;
  $sum: (arr: unknown) => number;
  $avg: (arr: unknown) => number;
  $unique: (arr: unknown) => unknown[];
  $flatten: (arr: unknown) => unknown[];
  $keys: (obj: unknown) => string[];
  $values: (obj: unknown) => unknown[];
  $number: (val: unknown) => number;
  $string: (val: unknown) => string;
  $date: DateHelper;
  /** JMESPath VERO (stessa lib di n8n): `$jmespath($json, "items[?age > \`30\`].name")`. */
  $jmespath: (data: unknown, query: string) => unknown;
  /** Luxon DateTime (parità n8n): `DateTime.now().setZone('Europe/Rome').toISO()`. */
  DateTime: typeof DateTime;
  /** Luxon Duration (parità n8n): `Duration.fromObject({days: 3}).as('hours')`. */
  Duration: typeof LuxonDuration;
}

/**
 * Costruisce i binding helper dallo scope corrente. Tutti gli accessor degradano
 * a default safe se il context manca (es. `$itemIndex` = 0 fuori da un loop).
 */
export function buildExpressionHelpers(ctx: ExpressionContext): ExpressionHelperBindings {
  const items = ctx.items ?? asArray(ctx.input);
  const loop = ctx.loop;
  return {
    $json: ctx.input,
    $items: items,
    $itemIndex: loop?.index ?? 0,
    $runIndex: loop?.index ?? 0,
    $first: loop?.first ?? true,
    $last: loop?.last ?? true,
    $itemCount: loop?.total ?? items.length,
    $workflow: { id: ctx.workflow?.id ?? '', name: ctx.workflow?.name ?? '' },
    $execution: {
      id: ctx.execution?.id ?? '',
      mode: ctx.execution?.mode ?? 'manual',
      startedAt: ctx.execution?.startedAt ?? '',
    },
    $if: (cond, then, els) => (cond ? then : els),
    $ifEmpty: (val, fallback) => (isEmpty(val) ? fallback : val),
    $isEmpty: isEmpty,
    $get: deepGet,
    // reduce, NON Math.min/max(...a): spread di array utente grande → RangeError stack.
    $min: (arr) => {
      const a = asArray(arr).map(toNumber);
      return a.length ? a.reduce((m, x) => (x < m ? x : m), Infinity) : 0;
    },
    $max: (arr) => {
      const a = asArray(arr).map(toNumber);
      return a.length ? a.reduce((m, x) => (x > m ? x : m), -Infinity) : 0;
    },
    $sum: (arr) => asArray(arr).reduce<number>((s, x) => s + toNumber(x), 0),
    $avg: (arr) => {
      const a = asArray(arr);
      return a.length ? a.reduce<number>((s, x) => s + toNumber(x), 0) / a.length : 0;
    },
    $unique: (arr) => [...new Set(asArray(arr))],
    $flatten: (arr) => asArray(arr).flat(Infinity),
    $keys: (obj) => (obj && typeof obj === 'object' ? Object.keys(obj) : []),
    $values: (obj) =>
      obj && typeof obj === 'object' ? Object.values(obj as Record<string, unknown>) : [],
    $number: toNumber,
    $string: (val) =>
      val === null || val === undefined
        ? ''
        : typeof val === 'object'
          ? JSON.stringify(val)
          : coerceString(val),
    $date: dateHelper,
    // FASE-2: fail-soft come gli altri helper — query rotta → null, mai crash
    // del run per un typo in un'espressione di reporting.
    // FASE-2: fail-soft come gli altri helper — query rotta → null, mai crash
    // del run per un typo in un'espressione di reporting.
    $jmespath: (data, query) => {
      try {
        return jmespath.search(data, String(query)) as unknown;
      } catch {
        return null;
      }
    },
    DateTime,
    Duration: LuxonDuration,
  };
}
