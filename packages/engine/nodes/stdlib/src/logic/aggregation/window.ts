/**
 * WindowNode — raggruppa item in time-window fisse (analytics serie temporali).
 *
 * Bucket key: ISO timestamp del bordo INIZIALE della finestra (es. 2026-05-20T12:00:00Z
 * per windowSec=3600). Item con timestamp invalido sono droppati silenziosamente
 * (preferire skip vs throw — un singolo record corrotto non blocca un aggregate).
 *
 * Output: `{ windows: { <isoBucket>: [item...] }, windowCount, totalItems, windowSizeSec }`.
 */

import type { NodeModule, NodeExecutor } from '../../types.js';
import { getField, capItems } from './helpers.js';
import { bucketStart, normalizeTimeZone, type CalendarGranularity } from './time-window.js';

function toEpochMs(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const CALENDAR_GRANULARITIES = new Set<CalendarGranularity>([
  'minute',
  'hour',
  'day',
  'week',
  'month',
]);

function resolveGranularity(raw: unknown): 'fixed' | CalendarGranularity {
  const g = typeof raw === 'string' ? raw.trim() : '';
  return CALENDAR_GRANULARITIES.has(g as CalendarGranularity)
    ? (g as CalendarGranularity)
    : 'fixed';
}

const executor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const { items, warning } = capItems(input, config.maxItems);
  const tsField = String(config.timestampField ?? 'createdAt');
  const granularity = resolveGranularity(config.granularity);
  const timeZone = normalizeTimeZone(config.timezone);
  const weekStartsMonday = String(config.weekStart ?? 'monday') !== 'sunday';
  const windowSec = Math.max(1, Number(config.windowSeconds ?? 3600));
  const windowMs = windowSec * 1000;

  const windows: Record<string, unknown[]> = {};
  // Gli item senza timestamp valido NON vengono persi in silenzio: finiscono in
  // `undated` (coerente con il bucket __missing__ di group_by) → l'operatore li vede.
  const undated: unknown[] = [];
  for (const item of items) {
    const ts = toEpochMs(getField(item, tsField));
    if (ts === null) {
      undated.push(item);
      continue;
    }
    const bucket =
      granularity === 'fixed'
        ? Math.floor(ts / windowMs) * windowMs
        : bucketStart(ts, granularity, timeZone, weekStartsMonday);
    const key = new Date(bucket).toISOString();
    (windows[key] ??= []).push(item);
  }
  return {
    output: {
      windows,
      windowCount: Object.keys(windows).length,
      totalItems: items.length,
      undated,
      undatedCount: undated.length,
      granularity,
      timezone: timeZone,
      ...(granularity === 'fixed' ? { windowSizeSec: windowSec } : {}),
    },
    durationMs: Date.now() - startedAt,
    ...(warning ? { warnings: [warning] } : {}),
  };
};

export const windowNode: NodeModule = {
  def: {
    id: 'logic_window',
    type: 'logic',
    label: 'Window',
    icon: 'clock',
    color: '#f59e0b',
    description:
      'Aggregatore time-series enterprise che raggruppa elementi di un array in finestre temporali non ' +
      'sovrapposte (tumbling window — il modello di windowing di Apache Flink, Kafka Streams, Spark Structured ' +
      'Streaming). Riceve un dataset con un campo timestamp su ciascun item (ISO 8601 o Unix epoch in ms) e ' +
      'produce i bucket — la primitiva per dashboard time-series, KPI rolling, analytics per cohort temporali, ' +
      'alerting su anomalie rispetto a baseline storica. ' +
      'Due modalità di finestratura: ' +
      "(1) FISSA (default) — finestre di durata costante in secondi (windowSeconds), allineate all'epoch UTC: " +
      'semplice e deterministica per qualsiasi durata (es. 300s = 5 minuti, 3600s = 1 ora); ' +
      '(2) CALENDARIO timezone-aware — granularity minute/hour/day/week/month allineata ai confini CIVILI nella ' +
      'timezone scelta (default UTC, es. "Europe/Rome"): day = mezzanotte locale, week = lunedì ISO 8601 (o ' +
      'domenica, configurabile), month = primo del mese (mesi reali 28-31gg + cambio anno). Gestisce ' +
      'correttamente le transizioni di ora legale/solare (DST) — fondamentale per il reporting italiano dove ' +
      '"vendite del 31 marzo" deve includere gli eventi fino alle 23:59 locali, non spostarli al giorno dopo. ' +
      'Output: { windows: { <ISO-del-bordo>: [item...] } (mappa bucket→item), windowCount, totalItems, ' +
      'undated: [item...] + undatedCount (gli item SENZA timestamp valido, tracciati e NON persi in silenzio), ' +
      'granularity, timezone, windowSizeSec (solo in modalità fissa) }. ' +
      'Use case: bucket eventi error_log per dashboard hourly "errori/ora delle ultime 24h" con detection di ' +
      'spike anomali rispetto al baseline; aggregazione di account.move Odoo per giorno per il report ' +
      'fatturato del mese tramite agent_business_summarizer; count di sessioni utenti distinte per settimana ' +
      'per il MAU/WAU/DAU del business dashboard B2B SaaS; rolling KPI con window deslizante (es. "media ' +
      'mobile su 7 giorni della conversion rate") per smussare il rumore daily; aggregazione di chiamate LLM ' +
      'gateway per ora per il forecast costi mensili e capacity planning vLLM.',
    configFields: [
      {
        key: 'sourceExpression',
        label: 'Array da finestrare',
        type: 'expression',
        required: true,
        defaultValue: 'input',
      },
      {
        key: 'timestampField',
        label: 'Campo timestamp',
        type: 'text',
        required: true,
        placeholder: 'es. createdAt, timestamp, ts',
        help: 'Campo che contiene un datetime ISO 8601 (es. "2026-05-20T12:34:56Z") o un Unix epoch in millisecondi.',
      },
      {
        key: 'granularity',
        label: 'Granularità',
        type: 'select',
        required: false,
        options: ['fixed', 'minute', 'hour', 'day', 'week', 'month'],
        defaultValue: 'fixed',
        help: 'fixed = finestre di durata costante (vedi "Dimensione finestra"), allineate a UTC. minute/hour/day/week/month = finestre di CALENDARIO allineate ai confini civili nella timezone scelta (mesi/settimane reali, DST-safe).',
      },
      {
        key: 'windowSeconds',
        label: 'Dimensione finestra (secondi) — solo granularità "fixed"',
        type: 'number',
        required: false,
        defaultValue: '3600',
        help: '60 = 1 minuto · 3600 = 1 ora (default) · 86400 = 1 giorno · 604800 = 1 settimana. Ignorato se la granularità è di calendario.',
        showIf: { field: 'granularity', equals: 'fixed' },
      },
      {
        key: 'timezone',
        label: 'Timezone (granularità di calendario)',
        type: 'text',
        required: false,
        defaultValue: 'UTC',
        placeholder: 'Europe/Rome',
        help: 'Identificatore IANA (es. Europe/Rome). Usato per allineare i confini di giorno/settimana/mese all\'ora locale. Una timezone non valida ricade su UTC. Ignorato in modalità "fixed".',
      },
      {
        key: 'weekStart',
        label: 'Inizio settimana (granularità "week")',
        type: 'select',
        required: false,
        options: ['monday', 'sunday'],
        defaultValue: 'monday',
        help: 'monday = settimana ISO 8601 (standard EU). sunday = convenzione US.',
        showIf: { field: 'granularity', equals: 'week' },
      },
      {
        key: 'maxItems',
        label: 'Max item (cap difensivo)',
        type: 'number',
        required: false,
        defaultValue: '100000',
        help: "Hard cap anti-OOM sul numero di item processati. Se l'input supera questa soglia viene troncato e finestra solo i primi N (warning emesso). Default 100k, tetto 1M.",
      },
    ],
    outputContract: {
      notes: 'Le finestre sono un oggetto: la chiave e` l\'inizio della finestra in ISO 8601, il valore gli elementi che vi cadono. Gli elementi senza data non vengono persi: finiscono in `undated`.',
      fields: [
        { name: 'windows', type: 'object', desc: 'Gli elementi di ogni finestra, sotto la chiave dell\'istante in cui la finestra comincia.' },
        { name: 'windowCount', type: 'number', desc: 'Quante finestre non vuote.' },
        { name: 'totalItems', type: 'number', desc: 'Quanti elementi erano entrati, quelli senza data compresi.' },
        { name: 'undated', type: 'array', desc: 'Gli elementi da cui non si e` potuta leggere una data: sono fuori da ogni finestra.' },
        { name: 'undatedCount', type: 'number', desc: 'Quanti sono.' },
        { name: 'granularity', type: 'string', desc: 'Il passo usato: fixed, hour, day, week, month.' },
        { name: 'timezone', type: 'string', desc: 'Il fuso con cui sono stati calcolati i confini delle finestre.' },
        { name: 'windowSizeSec', type: 'number', desc: 'L\'ampiezza in secondi. Presente SOLO con passo fixed.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor,
};
