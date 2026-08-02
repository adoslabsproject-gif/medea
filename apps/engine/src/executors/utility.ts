/**
 * Executor implementazioni per i 3 nodi utility:
 *   • action_text_template — Mustache-like template engine
 *   • action_json_extract  — JSONPath subset implementato a mano (zero dep)
 *   • action_date_format   — formatter italiano con Intl.DateTimeFormat
 *
 * Tutte funzioni PURE — nessuna I/O — testabili a unit-test puri.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';

// ─── Safety budget (anti-DoS) — IMPLEMENTATI e ASSERITI da test, non aspirazionali ───
/** Cap output template render: oltre → troncato + flag `truncated` (anti-OOM su variabile enorme). */
export const MAX_TEMPLATE_OUTPUT_CHARS = 1_000_000;
/** Profondità ricorsione massima in `$..` recursive descent (anti stack-overflow su JSON deep-nested). */
export const MAX_JSONPATH_DEPTH = 32;
/** Nodi massimi visitati in `$..` (anti-DoS CPU/memoria su oggetti enormi). */
export const MAX_JSONPATH_NODES = 200_000;
/** Risultati massimi raccolti da una query (anti-esplosione output su wildcard `[*]`/`$..`). */
export const MAX_JSONPATH_RESULTS = 100_000;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ─────────────────────────────────────────────────────────────────────
// 1. TEXT TEMPLATE — {{var}} con path nested + fallback "var|default"
// ─────────────────────────────────────────────────────────────────────

/**
 * Risolvi un path nested ("user.address.city") in un oggetto.
 * Ritorna undefined se manca un segmento. Pure function.
 */
function getNested(obj: unknown, path: string): unknown {
  const segments = path.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function renderTemplate(template: string, data: unknown): string {
  // Pattern {{var}} o {{var|default fallback}} — non greedy, no nested braces.
  return template.replace(/\{\{\s*([^{}|]+?)(?:\s*\|\s*default\s+([^{}]*?))?\s*\}\}/g, (_match, rawPath: string, fallback: string | undefined) => {
    const path = rawPath.trim();
    const val = getNested(data, path);
    if (val === undefined || val === null || val === '') {
      return fallback?.trim() ?? '';
    }
    if (typeof val === 'object') return JSON.stringify(val);
    return coerceString(val);
  });
}

export const textTemplateExecutor: NodeExecutor = (config, input) => {
  const start = Date.now();
  const template = asString(config.template);
  if (!template) return Promise.reject(new Error('action_text_template: "template" è obbligatorio'));

  let data: unknown = config.dataExpression ?? input;
  // Se è una stringa che assomiglia a JSON, prova a parsarla.
  if (typeof data === 'string' && data.trim().startsWith('{')) {
    try { data = JSON.parse(data) as unknown; } catch { /* leave as-is */ }
  }

  let rendered = renderTemplate(template, data);
  if (coerceString(config.trim ?? 'false') === 'true') {
    rendered = rendered.replace(/\s+/g, ' ').trim();
  }

  // Output cap (anti-OOM): una variabile interpolata può espandere a dimensioni
  // arbitrarie → tronchiamo e segnaliamo `truncated` (osservabile, non silenzioso).
  let truncated = false;
  if (rendered.length > MAX_TEMPLATE_OUTPUT_CHARS) {
    rendered = rendered.slice(0, MAX_TEMPLATE_OUTPUT_CHARS);
    truncated = true;
  }

  return Promise.resolve({
    output: { text: rendered, length: rendered.length, truncated },
    durationMs: Date.now() - start,
  });
};

// ─────────────────────────────────────────────────────────────────────
// 2. JSON EXTRACT — subset JSONPath
// ─────────────────────────────────────────────────────────────────────

/**
 * JSONPath subset implementato a mano (zero dep). Supporta:
 *   • $.path.to.field     — accesso path nested
 *   • $.items[0]          — array index
 *   • $.items[*]          — wildcard array
 *   • $..field            — recursive descent (raccoglie tutti i `field` ovunque)
 *
 * Non supportato (rare in workflow ETL):
 *   • Filter expressions [?(@.qty>0)]
 *   • Union $.[a,b]
 *   • Slice $.items[2:5]
 *
 * Se servono in futuro, swappare con `jsonpath-plus` (zero crypto risk, MIT).
 */
export function jsonPath(obj: unknown, path: string): unknown[] {
  if (!path.startsWith('$')) throw new Error(`JSONPath deve iniziare con $, ricevuto: ${path}`);
  const rest = path.slice(1);
  if (rest === '') return [obj];

  // Recursive descent: $..field — restituisce tutti i nodi che hanno `field`
  const recursiveMatch = /^\.\.([a-zA-Z_$][\w$]*)$/.exec(rest);
  if (recursiveMatch) {
    const field = recursiveMatch[1] ?? '';
    const results: unknown[] = [];
    let visited = 0;
    // Guard anti-DoS: depth (stack-overflow su deep-nesting), node count
    // (oggetti enormi), result count (esplosione output). Oltre → si ferma.
    const visit = (v: unknown, depth: number): void => {
      if (v === null || typeof v !== 'object') return;
      if (depth > MAX_JSONPATH_DEPTH) return;
      if (++visited > MAX_JSONPATH_NODES) return;
      const rec = v as Record<string, unknown>;
      if (field in rec) {
        results.push(rec[field]);
        if (results.length >= MAX_JSONPATH_RESULTS) return;
      }
      for (const k of Object.keys(rec)) {
        visit(rec[k], depth + 1);
        if (results.length >= MAX_JSONPATH_RESULTS || visited > MAX_JSONPATH_NODES) return;
      }
    };
    visit(obj, 0);
    return results;
  }

  // Tokenize segments: foo.bar[0] → ['foo', 'bar', 0, '*']
  type Segment = string | number;
  const segments: Segment[] = [];
  const re = /\.([a-zA-Z_$][\w$]*)|\[(\d+|\*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] === '*') segments.push('*');
    else if (m[2] !== undefined) segments.push(Number(m[2]));
  }

  let current: unknown[] = [obj];
  for (const seg of segments) {
    const next: unknown[] = [];
    // `pushCapped` evita lo spread `push(...arr)` (RangeError "too many arguments"
    // su array enormi) E applica il cap anti-esplosione DURANTE l'accumulo.
    const pushCapped = (val: unknown): boolean => {
      next.push(val);
      return next.length < MAX_JSONPATH_RESULTS;
    };
    outer: for (const v of current) {
      if (v === null || v === undefined) continue;
      if (seg === '*') {
        const vals = Array.isArray(v)
          ? (v as unknown[])
          : typeof v === 'object'
            ? Object.values(v as Record<string, unknown>)
            : [];
        for (const item of vals) {
          if (!pushCapped(item)) break outer;
        }
      } else if (typeof seg === 'number') {
        if (Array.isArray(v) && v[seg] !== undefined) {
          if (!pushCapped(v[seg])) break outer;
        }
      } else if (typeof v === 'object') {
        const val = (v as Record<string, unknown>)[seg];
        if (val !== undefined) {
          if (!pushCapped(val)) break outer;
        }
      }
    }
    current = next;
  }
  return current;
}

export const jsonExtractExecutor: NodeExecutor = (config, input) => {
  const start = Date.now();
  const path = asString(config.path);
  if (!path) return Promise.reject(new Error('action_json_extract: "path" è obbligatorio'));

  let source: unknown = config.sourceExpression ?? input;
  if (typeof source === 'string' && (source.trim().startsWith('{') || source.trim().startsWith('['))) {
    try { source = JSON.parse(source) as unknown; } catch { /* leave as-is */ }
  }

  const matches = jsonPath(source, path);
  const mode = asString(config.mode) || 'first';
  const fallback = config.defaultValue;

  let value: unknown;
  if (mode === 'count') {
    value = matches.length;
  } else if (mode === 'all') {
    value = matches;
  } else {
    value = matches[0] ?? fallback ?? null;
  }

  return Promise.resolve({
    output: { value, matchCount: matches.length },
    durationMs: Date.now() - start,
  });
};

// ─────────────────────────────────────────────────────────────────────
// 3. DATE FORMAT — Intl-based, locale-aware
// ─────────────────────────────────────────────────────────────────────

const IT_MONTHS_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const IT_MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const IT_WEEKDAYS_LONG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

/**
 * Parse input in multiple formats — Date object, ISO, dd/mm/yyyy, dd-mm-yyyy,
 * "now". Returns null if unparseable (caller decides whether to throw).
 */
export function parseDateInput(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === 'now' || value === null || value === undefined || value === '') {
    if (value === 'now') return new Date();
    return null;
  }
  if (typeof value === 'number') {
    const d = new Date(value > 1e12 ? value : value * 1000); // assume seconds if small
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = coerceString(value).trim();
  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // dd/mm/yyyy or dd-mm-yyyy
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (dmy) {
    const [, dd, mm, yy] = dmy;
    const year = yy?.length === 2 ? Number(`20${yy}`) : Number(yy);
    const d = new Date(year, Number(mm) - 1, Number(dd));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n.toString()}` : n.toString();
}

/**
 * Render a Date with custom format tokens (yyyy/MM/dd/HH/mm/ss/EEEE).
 * Italian month/weekday names hardcoded — no Intl runtime cost.
 */
export function formatDate(date: Date, preset: string, customFormat: string, tz: string): string {
  // Per ottenere componenti nel TZ corretto usiamo Intl.DateTimeFormat.
  const fmt = new Intl.DateTimeFormat('it-IT', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    weekday: 'long',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour);
  const mi = Number(parts.minute);
  const s = Number(parts.second);
  const wIdx = ['lunedì','martedì','mercoledì','giovedì','venerdì','sabato','domenica'].indexOf((parts.weekday ?? '').toLowerCase());
  // Note: Intl returns "lunedì" but our weekday array is sunday-first. Map back.
  const weekday0to6 = wIdx === -1 ? 0 : (wIdx + 1) % 7; // Sunday = 0

  switch (preset) {
    case 'it_long':  return `${IT_WEEKDAYS_LONG[weekday0to6] ?? ''} ${d.toString()} ${IT_MONTHS_LONG[m - 1] ?? ''} ${y.toString()}`;
    case 'it_short': return `${pad2(d)}/${pad2(m)}/${y.toString()}`;
    case 'it_iso':   return `${pad2(d)}-${pad2(m)}-${y.toString()}`;
    case 'us_short': return `${m.toString()}/${d.toString()}/${y.toString()}`;
    case 'iso8601':  return date.toISOString();
    case 'unix':     return Math.floor(date.getTime() / 1000).toString();
    case 'custom': {
      return customFormat
        .replace(/yyyy/g, y.toString())
        .replace(/yy/g, y.toString().slice(-2))
        .replace(/MMMM/g, IT_MONTHS_LONG[m - 1] ?? '')
        .replace(/MMM/g, IT_MONTHS_SHORT[m - 1] ?? '')
        .replace(/MM/g, pad2(m))
        .replace(/dd/g, pad2(d))
        .replace(/EEEE/g, IT_WEEKDAYS_LONG[weekday0to6] ?? '')
        .replace(/HH/g, pad2(h))
        .replace(/hh/g, pad2(h % 12 || 12))
        .replace(/mm/g, pad2(mi))
        .replace(/ss/g, pad2(s));
    }
    default: return date.toISOString();
  }
}

export const dateFormatExecutor: NodeExecutor = (config) => {
  const start = Date.now();
  const inputRaw = config.input;
  const date = parseDateInput(inputRaw);
  if (!date) return Promise.reject(new Error(`action_date_format: input non parsabile (${typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw)})`));
  const preset = asString(config.preset) || 'it_long';
  const customFormat = asString(config.customFormat) || 'yyyy-MM-dd HH:mm:ss';
  const timezone = asString(config.timezone) || 'Europe/Rome';
  const formatted = formatDate(date, preset, customFormat, timezone);

  // Componenti separati per uso downstream (es. routing per giorno settimana).
  const tzFmt = new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  });
  const parts = Object.fromEntries(tzFmt.formatToParts(date).map((p) => [p.type, p.value]));

  return Promise.resolve({
    output: {
      formatted,
      iso: date.toISOString(),
      unix: Math.floor(date.getTime() / 1000),
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      weekday: parts.weekday ?? '',
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    },
    durationMs: Date.now() - start,
  });
};
